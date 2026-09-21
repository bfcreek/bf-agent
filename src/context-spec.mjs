/**
 * Context-window spec: what the loop puts in front of the model on every
 * call, and the smallest window in which that still works.
 *
 * Every number here was measured against real tokenizers (gpt-oss:20b and
 * qwen3:14b via Ollama `prompt_eval_count`), not estimated; see
 * docs/context-spec.md for the measurement and the derivation. Keep the two
 * in sync: this file is the spec the code enforces, the doc is the reasoning.
 *
 * Token accounting model for one model call:
 *
 *   prompt  = fixed + transcript
 *   fixed   = chat template + core prompt & environment + tool schemas
 *             + rules/instructions + the task message
 *   transcript, right after a compaction = recap + keepRecent messages
 *   output  = thinking + tool call (or answer), bounded by num_ctx - prompt
 *
 * Compaction fires when the estimated transcript passes
 * DEFAULT_CONTEXT_FRACTION (0.75) of num_ctx, so the remaining 25% is the
 * output reserve for the call that follows. That reserve is where thinking
 * models overrun (`done_reason: "length"`), so it is the binding constraint.
 */

import {
  CHARS_PER_TOKEN_CODE,
  CHARS_PER_TOKEN_TEXT,
  DEFAULT_CONTEXT_FRACTION,
  DEFAULT_KEEP_RECENT,
  SUMMARY_MAX_TOKENS,
} from "./compaction.mjs";
import { MAX_INSTRUCTION_CHARS } from "./context-builder.mjs";
import { DEFAULT_NUM_CTX } from "./model-tuning.mjs";
import { SPILL_HEAD_CHARS, SPILL_TAIL_CHARS } from "./tools/output.mjs";

export { CHARS_PER_TOKEN_CODE, CHARS_PER_TOKEN_TEXT };
/** Prose (prompts, summaries) measured at ~5.3 chars/token. */
export const CHARS_PER_TOKEN_PROSE = 5;

/** Fixed per-call costs in tokens (measured, rounded up). */
export const FIXED_COST = {
  /** Chat-template scaffolding (role markers, tool preamble). */
  chatTemplate: 100,
  /** Core prompt + model overlay + workspace listing (<=40 entries) + git status (<=30 lines). */
  systemPrompt: 800,
  /** 12 builtin tool schemas; qwen-family templates render them ~20% larger than gpt-oss. */
  toolSchemas: 1700,
  /** Each MCP tool adds roughly this much schema. */
  perMcpTool: 150,
  /** Rules/instructions cap (MAX_INSTRUCTION_CHARS) at code density — the worst case; many workspaces have none. */
  rulesCap: Math.ceil(MAX_INSTRUCTION_CHARS / CHARS_PER_TOKEN_CODE),
  /** The user's task message. Terminal-Bench instructions run 100–500; this leaves room for a long brief. */
  task: 1000,
};

/** Per tool exchange (assistant call + tool result), in tokens. */
export const EXCHANGE_COST = {
  /** A spilled result keeps head + tail inline; at code density that is the largest single tool message. */
  toolResultMax: Math.ceil((SPILL_HEAD_CHARS + SPILL_TAIL_CHARS) / CHARS_PER_TOKEN_CODE) + 100,
  /** Observed p90 of tool messages (~7.2k chars). */
  toolResultTypical: 2500,
  /** Assistant tool-call message: name + JSON args (p50 ~110 completion tokens; edits with content run higher). */
  assistantCall: 400,
};

/** Compaction artefacts, in tokens. */
export const COMPACTION_COST = {
  /** Summarizer output cap. */
  summary: SUMMARY_MAX_TOKENS,
  /** Recap header + the original instruction quoted verbatim + history-file pointer. */
  recapFraming: 1200,
  /** Messages kept verbatim after a compaction. */
  keepRecent: DEFAULT_KEEP_RECENT,
};

/**
 * Output reserve the model needs after the prompt, in tokens.
 *
 * A tool-call turn is small (p50 ~110), but thinking counts against the same
 * budget: a thinking model on a hard step was observed at 13k tokens of
 * reasoning before it would have emitted a call. The last turn's thinking is
 * also re-sent in the next prompt (both templates render it for the pending
 * tool exchange), so a heavy thinking step costs its size twice.
 */
export const OUTPUT_RESERVE = {
  /** Non-thinking model, or thinking forced to the minimum: one call with headroom. */
  toolCall: 4_000,
  /** Thinking model at its default level. */
  thinking: 12_000,
};

/**
 * Hard floor — and therefore the default / auto starting point. Below this
 * a single maximum tool result plus the fixed cost crosses the compaction
 * trigger, and compaction cannot recover it because keepRecent keeps that
 * result verbatim — the loop would thrash.
 */
export const MIN_NUM_CTX = DEFAULT_NUM_CTX;

/** Smallest window at which a thinking model gets its reserve without truncating. */
export const RECOMMENDED_NUM_CTX_THINKING = 32_768;
/** Smallest window recommended for a non-thinking model. */
export const RECOMMENDED_NUM_CTX = 24_576;

/**
 * Derive the minimum window for a configuration from the components above.
 *
 * The prompt right after a compaction is the steady-state worst case the
 * window must hold with the output reserve on top:
 *
 *   fixed + recap + keepRecent/2 exchanges + reserve  <=  num_ctx
 *
 * and the compaction trigger must sit above that prompt, or compaction
 * fires on every step:
 *
 *   fixed + recap + keepRecent/2 exchanges  <=  DEFAULT_CONTEXT_FRACTION * num_ctx
 *
 * @param {object} [options]
 * @param {boolean} [options.thinking] Thinking model at its default level.
 * @param {number} [options.mcpTools] Extra MCP tools registered.
 * @param {number} [options.ruleChars] Rules/instructions actually loaded (default: none).
 * @param {"typical"|"max"} [options.toolResults] Size assumed for the kept tool results.
 * @returns {{fixed: number, transcriptAfterCompaction: number, reserve: number, minNumCtx: number, breakdown: object}}
 */
export function deriveMinimumContext({ thinking = false, mcpTools = 0, ruleChars = 0, toolResults = "typical" } = {}) {
  const rules = Math.ceil(Math.min(ruleChars, MAX_INSTRUCTION_CHARS) / CHARS_PER_TOKEN_CODE);
  const fixed =
    FIXED_COST.chatTemplate + FIXED_COST.systemPrompt + FIXED_COST.toolSchemas + mcpTools * FIXED_COST.perMcpTool + rules + FIXED_COST.task;
  const exchanges = Math.ceil(COMPACTION_COST.keepRecent / 2);
  const perExchange =
    EXCHANGE_COST.assistantCall + (toolResults === "max" ? EXCHANGE_COST.toolResultMax : EXCHANGE_COST.toolResultTypical);
  const recap = COMPACTION_COST.summary + COMPACTION_COST.recapFraming;
  const transcriptAfterCompaction = recap + exchanges * perExchange;
  const reserve = thinking ? OUTPUT_RESERVE.thinking : OUTPUT_RESERVE.toolCall;
  const prompt = fixed + transcriptAfterCompaction;
  const byReserve = prompt + reserve;
  const byTrigger = Math.ceil(prompt / DEFAULT_CONTEXT_FRACTION);
  const minNumCtx = Math.max(MIN_NUM_CTX, roundUp(Math.max(byReserve, byTrigger), 1024));
  return {
    fixed,
    transcriptAfterCompaction,
    reserve,
    minNumCtx,
    breakdown: { rules, exchanges, perExchange, recap, prompt, byReserve, byTrigger },
  };
}

/**
 * Warnings for a configured window. Empty when it meets the spec.
 *
 * @param {number|null|undefined} numCtx Window in use (null = Ollama default, unknown).
 * @param {{thinking?: boolean|null, mcpTools?: number, ruleChars?: number}} [options]
 * @returns {string[]}
 */
export function checkContextWindow(numCtx, { thinking = null, mcpTools = 0, ruleChars = 0 } = {}) {
  const warnings = [];
  if (!Number.isFinite(numCtx) || numCtx <= 0) {
    warnings.push(
      `Context window is Ollama's server default (often 4096 tokens), below the ${MIN_NUM_CTX}-token floor the agent needs; the system prompt and tool schemas will be silently dropped. Pass --num-ctx auto.`,
    );
    return warnings;
  }
  if (numCtx < MIN_NUM_CTX) {
    warnings.push(
      `Context window ${numCtx} is below the ${MIN_NUM_CTX}-token floor: one large tool result plus the fixed prompt exceeds the compaction trigger, so the loop will thrash. Use --num-ctx auto or at least ${MIN_NUM_CTX}.`,
    );
    return warnings;
  }
  const need = deriveMinimumContext({ thinking: thinking === true, mcpTools, ruleChars });
  if (numCtx < need.minNumCtx) {
    const why = thinking === true ? `a thinking model needs ~${need.reserve} tokens of output reserve` : `the steady-state prompt is ~${need.breakdown.prompt} tokens`;
    warnings.push(
      `Context window ${numCtx} is under the ${need.minNumCtx} this configuration needs (${why}); expect truncated turns and frequent compaction. Use --num-ctx auto or raise it.`,
    );
  }
  return warnings;
}

function roundUp(n, step) {
  return Math.ceil(n / step) * step;
}
