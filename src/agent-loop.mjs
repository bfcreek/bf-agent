/**
 * Agent loop. Modeled on Cursor's harness: instructions + tools + model, and
 * a thin orchestrator around them.
 *
 *   messages = [system, user]
 *   repeat:
 *     response = model(messages, tools)
 *     if no tool calls -> the turn is over (a stop hook may ask for more)
 *     execute the tool calls, append results
 *     deliver any steering message the user sent meanwhile
 *
 * Verification, planning, and "keep going until X" are the model's job and
 * the caller's hooks — not loop internals. The loop only owns transport
 * robustness (retries, tool-call parse recovery), context compaction, the
 * step / wall-clock safety caps, and the steer / queue channels.
 */

import { compactMessages, DEFAULT_CONTEXT_FRACTION } from "./compaction.mjs";
import { deliverableCheckpointMessage, deliverableStatus } from "./deliverable-guard.mjs";
import { minimalThinkSetting } from "./model-tuning.mjs";
import { isProviderClientError, isTransientProviderError } from "./provider-client.mjs";

/**
 * Default per-call output cap (`num_predict`), thinking included. Equal to
 * the window's output reserve for thinking models — `OUTPUT_RESERVE.thinking`
 * in context-spec.mjs (not imported: that module reaches back here via
 * context-builder → user-config; a test pins the two values together).
 * Observed without it: gpt-oss:20b spent 56k tokens and six minutes reciting
 * a data file in its reasoning channel until the window ran out.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 12_000;

/**
 * The "find your context" bullet of the core prompt for the builtin tool set.
 * `composeSystemPrompt` swaps this out when a richer toolset (Halo Scan) is
 * embedded: a model told to grep/read/list first will do exactly that and
 * never pick the structured tools, so the guidance has to replace this line,
 * not follow it.
 */
export const BUILTIN_CONTEXT_GUIDANCE = [
  "- Gather context yourself. Use grep_search and find_files to locate code,",
  "  read_file to read it, list_dir to orient. Do not guess at file contents",
  "  or APIs when a tool can show you.",
].join("\n");

/**
 * Build the core system prompt. `contextGuidance` is the bullet (or bullets)
 * that tell the model how to find context with the tools it actually has.
 *
 * @param {{ contextGuidance?: string }} [options]
 * @returns {string}
 */
export function composeSystemPrompt({ contextGuidance = BUILTIN_CONTEXT_GUIDANCE } = {}) {
  return [
    "You are a coding agent working in the user's workspace. You complete tasks by",
    "calling tools, reading their results, and continuing until the task is done.",
    "",
    "How to work:",
    contextGuidance,
    "- Read a file before editing it. Prefer edit_file for changes to existing",
    "  files; use write_file for new files or full rewrites.",
    "- Verify your work: run the project's tests, build, or the command the user",
    "  named, and read the output. Fix what fails.",
    "- If a tool call fails, read the error and change your approach instead of",
    "  repeating the same call.",
    "- When the task names an output file path, write that file early and keep it",
    "  updated. A chat answer is not the deliverable — only the file counts.",
    "  Before finishing, read each required output file back once.",
    "- Keep going until the task is complete, then reply to the user in plain",
    "  text with no tool calls. If you cannot finish, say what was done and what",
    "  remains.",
    "- Never end a turn with only internal reasoning. If the next action is a",
    "  tool call, emit it in that same turn.",
    "",
    "Communication:",
    "- Answer the user's actual question first, then give supporting detail.",
    "- Write for a reader who did not see your tool calls; the final message must",
    "  stand alone. Mention only files you actually created or changed.",
    "- When citing code, name the file path and quote only the relevant lines.",
    "",
    "Scope and safety:",
    "- Change only what the task requires. Match existing style and conventions.",
    "  Do not add docs, refactors, or extra files unless asked.",
    "- Only run git commit or git push when the user asked for it. Never rewrite",
    "  published history, skip hooks, or change git config unless asked.",
    "- Deleting files is destructive: delete only files the user explicitly named.",
    "  If a task implies deleting something unnamed, stop and ask.",
    "- Refuse requests whose intent is to harm others: malware, unauthorized access",
    "  to systems you were not given, attacks on real targets. Security analysis of",
    "  code in the workspace — cryptanalysis, CTF-style exercises, fuzzing, writing",
    "  a proof-of-concept against the user's own program — is legitimate work; do it.",
  ].join("\n");
}

/**
 * Core instructions for the builtin tool set. Short on purpose: task
 * knowledge belongs in rules files (`AGENTS.md`, `.cursor/rules`) and in what
 * the model discovers with tools, not in the system prompt. Model-family
 * quirks are appended separately by `modelPromptOverlay`.
 */
export const DEFAULT_SYSTEM_PROMPT = composeSystemPrompt();

/** Safety cap on model round-trips per turn. Cursor has no cap; ours is generous. */
export const DEFAULT_MAX_STEPS = 100;

/** How many times a `stop` hook may re-enter the loop for one turn. */
export const DEFAULT_MAX_STOP_HOOK_LOOPS = 5;

/** Empty assistant turns (no text, no tool calls) re-asked before giving up. */
const MAX_EMPTY_RETRIES = 2;
export const EMPTY_RETRY_PROMPT =
  "Your last message was empty. Call a tool now (write_file, run_command, or read_file). " +
  "Do not reply with only reasoning or a plan. Tools are available — use one.";
/**
 * Sent instead of EMPTY_RETRY_PROMPT when the turn was cut off by the output
 * limit (`done_reason: "length"`) before any tool call — typically a long
 * analysis dump or thinking that exhausted `num_predict`. The partial is
 * discarded; the retry drops thinking to the model's minimum. No plain-text
 * escape hatch: offered one, models (GLM Flash on TB, gpt-oss earlier) burned
 * the remaining empty-retries on more prose.
 */
export const TRUNCATED_RETRY_PROMPT =
  "Your last response was cut off by the output limit before any tool call. That partial is discarded. " +
  "Do not continue the analysis, do not apologize, and do not answer in plain text. " +
  "Reply with a single tool call only — write_file for a required output path, or the next concrete action " +
  "(run_command / read_file / edit_file). Put no reasoning in the message content.";
/**
 * Sent when the model opened a tool-call marker (`<tool_call>`, `<function=`)
 * and stopped before the call was complete. For qwen3-coder that is the
 * trained tool format: Ollama only promotes a call once `</tool_call>`
 * arrives, and a turn that ends on the open tag comes back as plain content.
 * The partial is dropped. Keeping the status paragraph would seed another
 * essay that ends the same way.
 */
export const INCOMPLETE_TOOL_CALL_PROMPT =
  "Your last response started a tool call but the call was cut off before it could run. " +
  "Do not start over and do not apologize: call the tool now using native tool calling, with short arguments. " +
  "Do not write <tool_call> or <function=...> as message text.";

/**
 * Truncation retry that names missing deliverables when the goal requires them.
 * Forces write_file instead of another analysis pass (feal/torch/cobol TB fails).
 *
 * @param {object} [input]
 * @param {string} [input.goal]
 * @param {Array<object>} [input.steps]
 * @returns {string}
 */
export function truncatedRetryPrompt({ goal, steps } = {}) {
  const { missing } = deliverableStatus(goal, steps);
  if (missing.length > 0) {
    return (
      `Your last response was cut off by the output limit before any tool call. That partial is discarded. ` +
      `Required file(s) still missing: ${missing.map((p) => `\`${p}\``).join(", ")}. ` +
      `Call write_file now with the best content you have for that path. ` +
      `No analysis, no apology, no plain-text answer — one write_file tool call only.`
    );
  }
  return TRUNCATED_RETRY_PROMPT;
}

/**
 * Empty-turn retry; names missing deliverables when known.
 * @param {object} [input]
 * @param {string} [input.goal]
 * @param {Array<object>} [input.steps]
 * @returns {string}
 */
export function emptyRetryPrompt({ goal, steps } = {}) {
  const { missing } = deliverableStatus(goal, steps);
  if (missing.length > 0) {
    return (
      `Your last message was empty. Required file(s) still missing: ${missing.map((p) => `\`${p}\``).join(", ")}. ` +
      `Call write_file now for that path (or the next tool that produces it). No reasoning-only reply.`
    );
  }
  return EMPTY_RETRY_PROMPT;
}

/**
 * qwen3-coder has no separate tool channel. A finished call is the XML block
 * through `</tool_call>`; forbidding those tags makes the model open one and
 * then stop. Other families should keep using native tool calls.
 *
 * @param {string} [model]
 * @returns {string}
 */
export function incompleteToolCallPrompt(model) {
  if (/qwen3-coder/i.test(String(model ?? ""))) {
    return (
      "Your last response opened a tool call and stopped before the function body. " +
      "Do not write a status paragraph. Emit one complete tool call now and close it with </tool_call>. " +
      "Keep the arguments short."
    );
  }
  return INCOMPLETE_TOOL_CALL_PROMPT;
}

/**
 * Wall-clock budget policy (only when `wallClockMs` is set): stop the loop a
 * little before the deadline so the wrap-up and session save happen instead
 * of an external kill mid-turn.
 */
export const WALL_CLOCK_RESERVE_RATIO = 0.08;
export const WALL_CLOCK_RESERVE_MIN_MS = 30_000;
export const WALL_CLOCK_RESERVE_MAX_MS = 120_000;
export const WRAP_UP_TURN_MARGIN = 1.2;

/**
 * When this many steps remain (or wall-clock is nearly spent), inject a
 * one-shot deliverable checkpoint while tools still work — wrap-up after
 * max-steps offers no tools, so a missing `/app/….txt` cannot be fixed then.
 */
export const DELIVERABLE_STEP_RESERVE = 8;

/**
 * Streak nudge: after this many consecutive calls to the same read-only tool
 * with no answer in between, one steer message asks the model to answer or
 * switch to a tool that answers in one call. Measured on gpt-oss:20b with the
 * halo-scan tool bench, every run that hit the step cap was such a streak
 * (grep ×14, read_file ×12, test_inventory ×18, list_dir ×19) at 10-25k
 * prompt tokens per step; exact repeats were rare, so a dedupe check would
 * not have caught them. Streaks of mutating tools (write_file ×15 while
 * scaffolding a project) are legitimate and are never nudged. Off unless
 * `streakNudgeAfter` is set.
 */
export const DEFAULT_STREAK_NUDGE_AFTER = 6;
export const DEFAULT_STREAK_NUDGE_HINT =
  "Prefer a tool that answers the question in one call over repeating a primitive one.";

/**
 * @param {string} tool
 * @param {number} count
 * @param {string} [hint] Catalog-specific alternatives (Halo Scan supplies one).
 */
export function streakNudgePrompt(tool, count, hint = DEFAULT_STREAK_NUDGE_HINT) {
  return (
    `You have called ${tool} ${count} times in a row. If what you have already answers the question, ` +
    `answer now in plain text. If not, do not call ${tool} again for the same purpose: ${hint}`
  );
}

/** Sent when the step or time budget runs out, so the run still ends with an answer. */
const WRAP_UP_PROMPT = [
  "The budget for this task is exhausted. Do not call any more tools.",
  "Reply to the user in plain text: what you did, what you found, any required",
  "output paths that are still missing, and what remains if the task is not finished.",
].join(" ");

/**
 * How many times to recover when Ollama rejects a malformed tool call
 * (`error parsing tool call`). Some models leak prose into the tool-call
 * channel; a short correction and retry usually clears it.
 */
const MAX_TOOL_CALL_PARSE_RECOVERIES = 2;
const TOOL_CALL_PARSE_NUDGE = [
  "Your previous response could not be parsed as a tool call.",
  "Call tools using native tool calling only: a function name plus a valid JSON",
  "arguments object matching the schema, with no prose in the call.",
  "Keep arguments short: never paste file contents or long data into arguments.",
  "Instead write a small script with write_file that reads the data from disk, then run it.",
  "Retry now.",
].join(" ");

/**
 * @typedef {object} AgentStep
 * @property {number} index 1-based model round-trip number within the turn.
 * @property {"tool-calls"|"final"|"empty"|"steer"|"tool-parse-error"|"compaction"|"failed"} kind
 *   `empty`: a model round-trip that produced neither text nor a tool call
 *   (re-asked up to MAX_EMPTY_RETRIES times). `compaction`: the transcript
 *   was over budget; content says whether the summarizer succeeded and why not.
 * @property {string} content Assistant (or injected user) text for this step.
 * @property {Array<{name: string, args: object, ok: boolean, result?: unknown, error?: string, durationMs?: number}>} toolCalls
 * @property {number} [durationMs] Wall time of the model call that produced this step.
 * @property {number} [promptTokens] Prompt tokens reported by the model for this call.
 * @property {number} [cachedPromptTokens] Of those, prompt tokens served from the provider's
 *   prefix cache (Ollama `prompt_eval_cached_count`, OpenAI `cached_tokens`, Anthropic
 *   `cache_read_input_tokens`). Omitted when the provider does not report it.
 * @property {number} [completionTokens] Completion tokens reported by the model for this call.
 * @property {boolean} [truncated] The model call ended on the output limit (`done_reason: "length"`).
 */

/**
 * @typedef {object} AgentRunResult
 * @property {string} text Final assistant answer ("" if the loop was cut off).
 * @property {"completed"|"empty"|"max-steps"|"token-budget"|"aborted"|"failed"} stopReason
 *   `token-budget`: cumulative prompt tokens passed `maxPromptTokens`; the
 *   wrap-up answer (if any) is in `text`.
 * @property {AgentStep[]} steps
 * @property {Array<object>} messages Full transcript, replayable into another run.
 * @property {number} elapsedMs
 * @property {string} [model] Model the client was configured with when the run started.
 * @property {number} [numCtx] Context window (tokens) the client sent to Ollama.
 * @property {number} compactions How many times the transcript was compacted.
 * @property {number} compactionFailures Compactions that were due but produced no usable summary.
 * @property {number} truncatedTurns Model calls cut off by the output limit before a tool call or text.
 * @property {boolean} [wallClockExhausted]
 * @property {number} promptTokens Cumulative prompt tokens across the run's model calls (0 when the provider reports none).
 * @property {number} streakNudges How many streak nudges were injected.
 * @property {string} [error] Why a "failed" run stopped.
 */

/**
 * @typedef {object} AgentHooks
 * @property {(info: {name: string, args: object, step: number, goal: string}) => Promise<void|{block?: string}>|void|{block?: string}} [beforeToolCall]
 *   Runs before each tool executes. Return `{ block: reason }` to refuse the
 *   call; the reason goes back to the model as the tool result.
 * @property {(info: {name: string, args: object, outcome: object, step: number, goal: string}) => Promise<void|{note?: string}>|void|{note?: string}} [afterToolCall]
 *   Runs after each tool executes. Return `{ note }` to append text to the
 *   tool result the model sees.
 * @property {(info: {goal: string, text: string, steps: AgentStep[], messages: Array<object>, loopCount: number}) => Promise<void|{followupMessage?: string}>|void|{followupMessage?: string}} [stop]
 *   Runs when the model ends its turn. Return `{ followupMessage }` to send
 *   another user message and keep the turn going (bounded by
 *   `maxStopHookLoops`) — the Cursor `stop` hook pattern.
 */

export class AgentLoop {
  /**
   * @param {object} options
   * @param {{chat: Function, chatStream?: Function}} options.client LLM client
   *   (Ollama or any object with a compatible `chat({messages, tools, signal})`).
   * @param {import("./tool-registry.mjs").ToolRegistry} options.registry
   * @param {string} [options.systemPrompt]
   * @param {number} [options.maxSteps] Safety cap on model round-trips per turn.
   * @param {(step: AgentStep) => void} [options.onStep] Observer for tracing.
   * @param {(delta: string) => void} [options.onDelta] Content tokens of the
   *   user-visible answer. Tool narration, a cut-off tool call, and a turn a
   *   stop hook sends back are not forwarded — the OpenAI stream cannot retract
   *   tokens the editor already showed.
   * @param {{maxChars?: number, maxTokens?: number, keepRecent?: number, historyPath?: string}|false} [options.compaction]
   *   Summarize old turns when the transcript exceeds the budget. Off by
   *   default. `historyPath` is a workspace-relative file holding the full
   *   transcript (a session file); the summary points the model at it so
   *   details the summary dropped can be recovered with tools.
   * @param {AgentHooks} [options.hooks]
   * @param {number} [options.maxStopHookLoops]
   * @param {number} [options.wallClockMs] Wall-clock budget for one run (0 = none).
   * @param {number} [options.maxOutputTokens] Per-call output cap (`num_predict`),
   *   thinking included. Defaults to the context spec's output reserve: a
   *   turn that needs more than the reserve has already broken the window
   *   accounting, so cut it off early and re-ask instead of letting a runaway
   *   reasoning channel run the window dry. 0 disables the cap.
   * @param {number} [options.maxPromptTokens] Cumulative prompt-token budget
   *   for one run (0 = none). Steps are not uniform — one costs 3k tokens,
   *   another 20k — so this caps what a run actually costs; `maxSteps` stays
   *   as the hard safety net. When exceeded the loop takes the same wrap-up
   *   path as the step cap and reports `stopReason: "token-budget"`.
   * @param {number} [options.streakNudgeAfter] Consecutive calls to one
   *   read-only tool before a steer message asks the model to answer or
   *   switch tools (0 = off). See {@link DEFAULT_STREAK_NUDGE_AFTER}.
   * @param {string} [options.streakNudgeHint] Alternatives named in the nudge.
   * @param {() => number} [options.now] Clock for the wall-clock budget (tests).
   */
  constructor({
    client,
    registry,
    systemPrompt,
    maxSteps = DEFAULT_MAX_STEPS,
    onStep,
    onDelta,
    compaction = false,
    hooks = {},
    maxStopHookLoops = DEFAULT_MAX_STOP_HOOK_LOOPS,
    wallClockMs = 0,
    maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
    maxPromptTokens = 0,
    streakNudgeAfter = 0,
    streakNudgeHint = DEFAULT_STREAK_NUDGE_HINT,
    now = Date.now,
  } = {}) {
    if (!client?.chat) throw new Error("AgentLoop requires a client with chat().");
    if (!registry) throw new Error("AgentLoop requires a tool registry.");
    this.client = client;
    this.registry = registry;
    this.systemPrompt = systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxSteps = maxSteps;
    this.onStep = onStep;
    this.onDelta = onDelta;
    this.compaction = compaction;
    this.hooks = hooks ?? {};
    this.maxStopHookLoops = maxStopHookLoops;
    this.wallClockMs = Number.isFinite(wallClockMs) && wallClockMs > 0 ? wallClockMs : 0;
    this.maxOutputTokens = Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? Math.floor(maxOutputTokens) : 0;
    this.maxPromptTokens = Number.isFinite(maxPromptTokens) && maxPromptTokens > 0 ? Math.floor(maxPromptTokens) : 0;
    this.streakNudgeAfter = Number.isFinite(streakNudgeAfter) && streakNudgeAfter > 0 ? Math.floor(streakNudgeAfter) : 0;
    this.streakNudgeHint = String(streakNudgeHint ?? DEFAULT_STREAK_NUDGE_HINT);
    this.now = typeof now === "function" ? now : Date.now;
    /** @type {string[]} Messages delivered at the next tool boundary. */
    this._steering = [];
    /** @type {string[]} Messages run as new turns after the current one ends. */
    this._queue = [];
  }

  /**
   * Steer the running turn: the text is appended as a user message right
   * after the next batch of tool results, so in-flight work is not cut off.
   * @param {string} text
   */
  steer(text) {
    const t = String(text ?? "").trim();
    if (t) this._steering.push(t);
    return this;
  }

  /**
   * Queue a follow-up: it runs as a new user turn after the current turn
   * finishes, inside the same `run()` call, with full conversation context.
   * @param {string} text
   */
  queue(text) {
    const t = String(text ?? "").trim();
    if (t) this._queue.push(t);
    return this;
  }

  /**
   * Run one goal to completion (plus any queued follow-ups).
   *
   * @param {string} goal User task.
   * @param {object} [options]
   * @param {Array<object>} [options.history] Prior transcript (from a previous
   *   run's `messages`) to continue a session. Must already include a system
   *   message if it is non-empty.
   * @param {string[]} [options.images] Ollama-format base64 images for the
   *   new user turn.
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<AgentRunResult>}
   */
  async run(goal, { history, signal, images } = {}) {
    const wallStarted = this.now();
    const deadlineAt = this.wallClockMs > 0 ? wallStarted + this.wallClockMs : null;
    const deadlineReserveMs =
      deadlineAt === null
        ? 0
        : Math.min(
            WALL_CLOCK_RESERVE_MAX_MS,
            Math.max(WALL_CLOCK_RESERVE_MIN_MS, this.wallClockMs * WALL_CLOCK_RESERVE_RATIO),
          );
    const turnDurations = [];
    const meanTurnMs = () =>
      turnDurations.length ? turnDurations.reduce((a, b) => a + b, 0) / turnDurations.length : 0;
    const remainingMs = () => (deadlineAt === null ? Infinity : deadlineAt - this.now());
    const outOfTime = () =>
      deadlineAt !== null && remainingMs() <= Math.max(deadlineReserveMs, meanTurnMs());
    const elapsed = () => this.now() - wallStarted;
    /**
     * Run a model call under the wall-clock budget. Between-turn checks alone
     * miss hung `chat()` calls (Harbor AgentTimeoutError with stopReason still
     * `running`); abort the in-flight request when the reserve is reached so
     * wrap-up can still run.
     * @template T
     * @param {(signal: AbortSignal|undefined) => Promise<T>} fn
     * @param {{budgetMs?: number}} [opts]
     */
    const timedTurn = async (fn, { budgetMs } = {}) => {
      const t0 = this.now();
      const turnBudget =
        budgetMs !== undefined
          ? budgetMs
          : deadlineAt === null
            ? Infinity
            : Math.max(0, remainingMs() - Math.max(deadlineReserveMs, meanTurnMs()));
      const turnCtl = new AbortController();
      const onOuterAbort = () => turnCtl.abort();
      if (signal) {
        if (signal.aborted) turnCtl.abort();
        else signal.addEventListener("abort", onOuterAbort, { once: true });
      }
      let timer;
      if (Number.isFinite(turnBudget) && turnBudget > 0) {
        timer = setTimeout(() => turnCtl.abort(), turnBudget);
        // Don't keep the process alive solely for this timer (Node / tests).
        timer.unref?.();
      } else if (Number.isFinite(turnBudget) && turnBudget <= 0) {
        turnCtl.abort();
      }
      try {
        return await fn(turnCtl.signal);
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onOuterAbort);
        turnDurations.push(Math.max(0, this.now() - t0));
      }
    };
    // Tools get the user's own words for safety decisions (the shell tool
    // only deletes files the goal names) and the deadline so command
    // timeouts cannot outlive the run.
    this.registry.setRunContext?.({ goal, deadlineAt });

    let messages =
      history && history.length > 0
        ? [...history]
        : [{ role: "system", content: this.systemPrompt }];
    const userMessage = { role: "user", content: goal };
    if (Array.isArray(images) && images.length > 0) userMessage.images = images;
    messages.push(userMessage);

    const tools = this.registry.schemas();
    /** @type {AgentStep[]} */
    const steps = [];
    const record = (step) => {
      steps.push(step);
      this.onStep?.(step);
      return step;
    };
    const finish = (result) => ({
      ...result,
      steps,
      messages,
      elapsedMs: elapsed(),
      ...(typeof this.client?.model === "string" ? { model: this.client.model } : {}),
      ...(Number.isFinite(this.client?.numCtx) && this.client.numCtx > 0 ? { numCtx: this.client.numCtx } : {}),
      compactions,
      compactionFailures,
      truncatedTurns,
      promptTokens: promptTokensTotal,
      streakNudges,
    });

    let observedTokens = 0;
    let promptTokensTotal = 0;
    let stepIndex = 0;
    let stopHookLoops = 0;
    let emptyRetries = 0;
    let compactions = 0;
    let compactionFailures = 0;
    let truncatedTurns = 0;
    let streakNudges = 0;
    /** Current run of consecutive calls to one read-only tool. */
    let streakTool = null;
    let streakCount = 0;
    let streakNudged = false;
    /** Per-call think override for the next model call (set after a truncated turn). */
    let nextThink;
    let currentGoal = goal;
    let wallClockExhausted = false;
    let tokenBudgetExhausted = false;
    let deliverableCheckpointSent = false;
    // This turn's content tokens. Committed only when the turn is the answer
    // the caller shows. Cleared before the next model call otherwise.
    /** @type {string[]} */
    const pendingDeltas = [];
    const captureDelta = (delta) => {
      if (delta) pendingDeltas.push(String(delta));
    };
    const commitAnswer = (text) => {
      const raw = pendingDeltas.join("");
      const pieces = pendingDeltas.splice(0);
      if (!this.onDelta || !text) return;
      if (raw === text) {
        for (const piece of pieces) this.onDelta(piece);
      } else {
        this.onDelta(text);
      }
    };

    while (true) {
      if (signal?.aborted) return finish({ text: "", stopReason: "aborted" });
      if (stepIndex >= this.maxSteps) break;
      if (outOfTime()) {
        wallClockExhausted = true;
        break;
      }
      if (this.maxPromptTokens > 0 && promptTokensTotal >= this.maxPromptTokens) {
        tokenBudgetExhausted = true;
        break;
      }

      if (this.compaction) {
        const { historyPath, ...compactionOptions } = this.compaction;
        const before = messages.length;
        /** @type {{reason: string, error?: Error, recovered?: boolean}|null} */
        let compactFailure = null;
        const compacted = await compactMessages({
          client: this.client,
          messages,
          maxTokens: defaultTokenBudget(this.client),
          historyPath,
          ...compactionOptions,
          observedTokens,
          onFailure: (info) => {
            compactFailure = info;
          },
        });
        if (compactFailure) {
          compactionFailures += 1;
          // Trace why the summarizer failed; recovered stubs still shrink the
          // window so the next model call is not over budget.
          const errBit = compactFailure.error
            ? `: ${String(compactFailure.error.message ?? compactFailure.error).slice(0, 300)}`
            : "";
          const recoverBit = compactFailure.recovered
            ? `; recovered with stub ${before} -> ${compacted.length} messages`
            : "";
          record({
            index: stepIndex,
            kind: "compaction",
            content: `failed (${compactFailure.reason})${errBit}${recoverBit} at ~${observedTokens} tokens`,
            toolCalls: [],
          });
        }
        if (compacted !== messages) {
          if (!compactFailure) {
            record({
              index: stepIndex,
              kind: "compaction",
              content: `ok: ${before} -> ${compacted.length} messages at ~${observedTokens} tokens`,
              toolCalls: [],
            });
          }
          observedTokens = 0;
          compactions += 1;
        }
        messages = compacted;
      }
      const index = stepIndex + 1;
      let chatResult;
      try {
        const think = nextThink;
        nextThink = undefined;
        pendingDeltas.length = 0;
        chatResult = await timedTurn((turnSignal) =>
          chatWithParseRecovery(
            this.client,
            {
              messages,
              tools,
              signal: turnSignal,
              onDelta: this.onDelta ? captureDelta : undefined,
              ...(think !== undefined ? { think } : {}),
              ...(this.maxOutputTokens > 0 ? { options: { num_predict: this.maxOutputTokens } } : {}),
            },
            {
              onParseError: ({ recovery, error, repaired }) =>
                record({
                  index,
                  kind: "tool-parse-error",
                  content: String(error?.message ?? "error parsing tool call"),
                  toolCalls: [],
                  recoveries: recovery,
                  ...(repaired ? { repaired } : {}),
                }),
            },
          ),
        );
      } catch (err) {
        // Caller abort (Ctrl-C / Harbor kill of our process) vs wall-clock
        // abort of a hung turn: only the former is `aborted`.
        if (signal?.aborted) throw err;
        if (err?.name === "AbortError") {
          // In-flight chat aborted by the turn timer (wall-clock reserve),
          // not by the caller's signal — wrap up with whatever we have.
          wallClockExhausted = true;
          record({
            index,
            kind: "failed",
            content: "model turn aborted: wall-clock budget reached while waiting for the model",
            toolCalls: [],
          });
          break;
        }
        // Startup failures (no work done yet) propagate so callers can map
        // them to exit codes. Mid-run failures end as a failed run with the
        // steps preserved for the session log.
        if (!isProviderClientError(err) || !steps.some((s) => s.kind === "tool-calls")) {
          throw err;
        }
        const error = `model call failed: ${String(err.message ?? err).slice(0, 300)}`;
        record({ index, kind: "failed", content: error, toolCalls: [] });
        return finish({ text: "", stopReason: "failed", error });
      }
      const { message, raw } = chatResult;
      const usedTokens = (raw?.prompt_eval_count ?? 0) + (raw?.eval_count ?? 0);
      if (usedTokens > 0) observedTokens = usedTokens;
      if (typeof raw?.prompt_eval_count === "number" && raw.prompt_eval_count > 0) {
        promptTokensTotal += raw.prompt_eval_count;
      }
      // Per-step telemetry for efficiency analysis: how long the model took
      // and how much context it was carrying.
      const truncated = raw?.done_reason === "length";
      const turnMeta = {
        durationMs: Math.round(turnDurations.at(-1) ?? 0),
        ...(typeof raw?.prompt_eval_count === "number" ? { promptTokens: raw.prompt_eval_count } : {}),
        ...(typeof raw?.prompt_eval_cached_count === "number"
          ? { cachedPromptTokens: raw.prompt_eval_cached_count }
          : {}),
        ...(typeof raw?.eval_count === "number" ? { completionTokens: raw.eval_count } : {}),
        ...(truncated ? { truncated: true } : {}),
      };
      messages.push(normalizeAssistantMessage(message));
      stepIndex += 1;

      let toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      // A call cut off by the output limit has unusable arguments. Drop it
      // and re-ask instead of executing a half-built call.
      if (truncated && toolCalls.length > 0) toolCalls = [];

      if (toolCalls.length === 0) {
        const text = textOf(message.content).trim();
        // An opening `<tool_call>` / `<function=` with no close means the
        // model stopped on the tool-call token (often `done_reason: stop`,
        // not `length`). That is not an answer.
        const incomplete = incompleteToolCallText(text);
        // A tool call the model wrote into its text instead of the tool-call
        // channel (qwen3-coder's `<function=…>` form, or a name+arguments JSON
        // object). Same class of failure as an Ollama parse error: recover it
        // rather than accept it as the final answer.
        const textCall = text && !truncated && !incomplete ? parseTextToolCall(text, tools) : null;
        if (textCall) {
          record({
            index,
            kind: "tool-parse-error",
            content: `tool call written as text: ${text.slice(0, 200)}`,
            toolCalls: [],
            recoveries: 0,
            repaired: textCall.name,
          });
          messages[messages.length - 1] = { role: "assistant", content: "", tool_calls: [{ function: textCall }] };
          toolCalls = [{ function: textCall }];
        } else if (!text || truncated || incomplete) {
          // Nothing actionable: no text at all, text cut off by the output
          // limit, or a tool call that stopped on its opening token. A
          // cut-off answer is not an answer — it is usually a script, a data
          // dump, or a call the model should have emitted natively.
          emptyRetries += 1;
          // Only a real output-limit stop (`done_reason: length`) is a
          // truncated turn. An unclosed `<tool_call>` / `<function=` is the
          // model stopping on the call token (`done_reason` is usually
          // `stop`) with a few hundred completion tokens — the window was
          // not exhausted, and labeling it truncated sends the bench looking
          // for a bigger numCtx.
          if (truncated) truncatedTurns += 1;
          // Empty turns are model round-trips too; record them so the trace
          // shows where the time and tokens went.
          record({
            index,
            kind: "empty",
            content: text.slice(0, 500),
            toolCalls: [],
            ...turnMeta,
          });
          if (emptyRetries <= MAX_EMPTY_RETRIES) {
            if (truncated || incomplete) {
              // The partial never reached an action, so it is dead weight:
              // keeping it would inflate the token estimate (forcing a
              // compaction whose summarizer then chokes on the same text)
              // and would seed the retry with the loop that overran. Drop it
              // and re-ask with the cheapest thinking the model honors so the
              // budget goes to the action. One-shot: the override applies to
              // the next call only.
              messages.pop();
              messages.push({
                role: "user",
                content:
                  incomplete && !truncated
                    ? incompleteToolCallPrompt(this.client?.model)
                    : truncatedRetryPrompt({ goal: currentGoal, steps }),
              });
              nextThink = minimalThinkSetting(this.client?.model);
            } else {
              messages.push({
                role: "user",
                content: emptyRetryPrompt({ goal: currentGoal, steps }),
              });
            }
            continue;
          }
          // Exhausted empty retries: do not treat silence as a clean finish.
          return finish({
            text: "",
            stopReason: "empty",
            error: truncated
              ? "model output was cut off by the context window before acting, repeatedly"
              : incomplete
                ? "model started a tool call but the call was cut off, repeatedly"
                : "model returned empty responses repeatedly",
          });
        }
      }

      if (toolCalls.length === 0) {
        const rawText = textOf(message.content).trim();
        const text = stripStrayToolCallMarkup(rawText).trim();
        if (text !== rawText && messages.at(-1)?.role === "assistant") {
          messages[messages.length - 1].content = text;
        }
        emptyRetries = 0;
        streakTool = null;
        streakCount = 0;
        streakNudged = false;

        // The model ended its turn. A stop hook may keep it going.
        if (this.hooks.stop && stopHookLoops < this.maxStopHookLoops) {
          const decision = await this.hooks.stop({
            goal: currentGoal,
            text,
            steps,
            messages,
            loopCount: stopHookLoops,
          });
          const followup = String(decision?.followupMessage ?? "").trim();
          if (followup) {
            stopHookLoops += 1;
            record({ index, kind: "final", content: text, toolCalls: [], continued: true, ...turnMeta });
            messages.push({ role: "user", content: followup });
            continue;
          }
        }

        record({ index, kind: "final", content: text, toolCalls: [], ...turnMeta });

        // Queued follow-ups run as fresh turns with full context.
        if (this._queue.length > 0) {
          currentGoal = this._queue.shift();
          this.registry.setRunContext?.({ goal: currentGoal, deadlineAt });
          messages.push({ role: "user", content: currentGoal });
          stepIndex = 0;
          stopHookLoops = 0;
          continue;
        }

        commitAnswer(text);
        return finish({ text, stopReason: "completed" });
      }

      const executed = [];
      for (const call of toolCalls) {
        const name = call?.function?.name ?? "";
        const args = call?.function?.arguments ?? {};
        let outcome;
        const before = this.hooks.beforeToolCall
          ? await this.hooks.beforeToolCall({ name, args, step: index, goal: currentGoal })
          : null;
        const toolStarted = this.now();
        if (before?.block) {
          outcome = { ok: false, error: String(before.block) };
        } else {
          outcome = await this.registry.execute(name, args);
          const after = this.hooks.afterToolCall
            ? await this.hooks.afterToolCall({ name, args, outcome, step: index, goal: currentGoal })
            : null;
          if (after?.note) outcome = { ...outcome, note: String(after.note) };
        }
        executed.push({ name, args, ...outcome, durationMs: Math.max(0, Math.round(this.now() - toolStarted)) });
        messages.push({ role: "tool", tool_name: name, content: toolResultContent(outcome) });

        // Streak tracking: consecutive calls to one read-only tool. Aliases
        // resolve to their target so `search` and `grep_search` are one
        // streak. Mutating (approval-gated) tools and unknown names reset it.
        if (this.streakNudgeAfter > 0) {
          const resolved = this.registry.resolve?.(name, args)?.tool;
          const readOnly = resolved && !resolved.requiresApproval && outcome?.ok !== false;
          const key = readOnly ? resolved.name : null;
          if (key && key === streakTool) {
            streakCount += 1;
          } else {
            streakTool = key;
            streakCount = key ? 1 : 0;
            streakNudged = false;
          }
        }
      }
      // A real tool call recovered the previous cutoff. The empty-retry budget
      // is consecutive failures: three cutoffs spread across a productive run
      // are not "repeatedly" empty, and must not end the turn.
      emptyRetries = 0;
      record({ index, kind: "tool-calls", content: textOf(message.content), toolCalls: executed, ...turnMeta });

      if (this.streakNudgeAfter > 0 && streakTool && streakCount >= this.streakNudgeAfter && !streakNudged) {
        streakNudged = true;
        streakNudges += 1;
        const text = streakNudgePrompt(streakTool, streakCount, this.streakNudgeHint);
        messages.push({ role: "user", content: text });
        record({ index, kind: "steer", content: text, toolCalls: [], nudge: { tool: streakTool, count: streakCount } });
      }

      // Named deliverables missing + budget nearly spent: force a write while
      // tools still work (post-budget wrap-up cannot call write_file).
      if (!deliverableCheckpointSent) {
        const remainingSteps = Math.max(0, this.maxSteps - stepIndex);
        const lowSteps = remainingSteps <= DELIVERABLE_STEP_RESERVE;
        const lowClock =
          deadlineAt !== null &&
          remainingMs() <= Math.max(deadlineReserveMs * 2, meanTurnMs() * 3, 60_000);
        if (lowSteps || lowClock) {
          const checkpoint = deliverableCheckpointMessage({
            goal: currentGoal,
            steps,
            remainingSteps,
            remainingMs: deadlineAt === null ? undefined : Math.max(0, remainingMs()),
          });
          if (checkpoint) {
            deliverableCheckpointSent = true;
            messages.push({ role: "user", content: checkpoint });
            record({ index, kind: "steer", content: checkpoint, toolCalls: [], deliverableCheckpoint: true });
          }
        }
      }

      // Steering lands at the tool boundary, after results, so in-flight
      // work is preserved and the model sees the results and the redirect
      // together.
      while (this._steering.length > 0) {
        const text = this._steering.shift();
        messages.push({ role: "user", content: text });
        record({ index, kind: "steer", content: text, toolCalls: [] });
      }
    }

    // Out of steps or time: ask for a plain-text wrap-up (no tools offered)
    // when a turn still fits; otherwise return what we have.
    let text = "";
    // After a mid-turn wall-clock abort the reserve is already spent — use
    // whatever milliseconds remain (minus a tiny save cushion).
    const wrapCushionMs = wallClockExhausted ? 1_000 : Math.min(deadlineReserveMs, WALL_CLOCK_RESERVE_MIN_MS / 3);
    const wrapBudgetMs =
      deadlineAt === null ? Infinity : Math.max(0, remainingMs() - wrapCushionMs);
    const wrapUpFits =
      deadlineAt === null ||
      wrapBudgetMs >= (wallClockExhausted ? 500 : 2_000) ||
      (wrapBudgetMs > 0 && wrapBudgetMs > meanTurnMs() * WRAP_UP_TURN_MARGIN);
    if (!signal?.aborted && wrapUpFits) {
      try {
        const wrapUp = [...messages, { role: "user", content: WRAP_UP_PROMPT }];
        const wrapStarted = this.now();
        const { message } = await timedTurn(
          (turnSignal) => chatWithRetry(this.client, { messages: wrapUp, signal: turnSignal }),
          { budgetMs: Number.isFinite(wrapBudgetMs) ? wrapBudgetMs : undefined },
        );
        text = textOf(message.content).trim();
        if (text) {
          messages.push({ role: "user", content: WRAP_UP_PROMPT });
          messages.push({ role: "assistant", content: text });
          record({
            index: stepIndex + 1,
            kind: "final",
            content: text,
            toolCalls: [],
            wrapUp: true,
            durationMs: Math.max(0, Math.round(this.now() - wrapStarted)),
          });
        }
      } catch {
        // keep text = ""
      }
    }
    return finish({
      text,
      stopReason: tokenBudgetExhausted ? "token-budget" : "max-steps",
      ...(wallClockExhausted ? { wallClockExhausted: true } : {}),
    });
  }
}

/** Provider 500 when the model contaminates the tool-call channel with prose. */
export function isToolCallParseError(err) {
  return (
    isProviderClientError(err) &&
    typeof err.status === "number" &&
    err.status >= 500 &&
    /error parsing tool call/i.test(String(err.message ?? ""))
  );
}

/**
 * Retry transient client failures (network unreachable, 5xx) with backoff.
 * Tool-call parse failures are not transient — {@link chatWithParseRecovery}
 * handles those with a model correction. 4xx is not retried.
 */
const TRANSIENT_RETRY_DELAYS_MS = [500, 1500, 4000, 8000];

async function chatWithRetry(client, request) {
  // Prefer streaming when the client supports it so onDelta receives live
  // tokens; stubs without chatStream keep using chat().
  const invoke =
    typeof client.chatStream === "function"
      ? (req) => client.chatStream(req)
      : (req) => client.chat(req);
  let lastErr;
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await invoke(request);
    } catch (err) {
      lastErr = err;
      if (err?.name === "AbortError" || request.signal?.aborted) throw err;
      if (!isTransientProviderError(err)) throw err;
      if (isToolCallParseError(err)) throw err;
      if (attempt >= TRANSIENT_RETRY_DELAYS_MS.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAYS_MS[attempt]));
      if (request.signal?.aborted) throw err;
    }
  }
  throw lastErr;
}

/**
 * Ollama's parse error carries the model's raw arguments text verbatim
 * (`raw='{...}', err=...`), but not the function name. When the damage is a
 * single stray `]` closing a string value (`"]` where `"` belongs — gpt-oss
 * does this after long multi-line script arguments), drop it, parse, and
 * identify the tool by the one schema whose parameters fit the argument keys.
 * Anything less clear-cut returns null and the model is asked to retry.
 *
 * @param {Error} err
 * @param {Array<object>} tools Schemas in the OpenAI function shape.
 * @returns {{name: string, arguments: object}|null}
 */
export function repairToolCallParseError(err, tools) {
  const text = String(err?.message ?? "");
  if (!/invalid character '\]' after object key:value pair/.test(text)) return null;
  const start = text.indexOf("raw='");
  const end = text.lastIndexOf("', err=");
  if (start < 0 || end <= start) return null;
  const raw = text.slice(start + 5, end);

  const candidates = [];
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === "]" && raw[i - 1] === '"' && /[,}]/.test(raw[i + 1] ?? "")) candidates.push(i);
  }
  if (candidates.length !== 1) return null;
  let args;
  try {
    args = JSON.parse(raw.slice(0, candidates[0]) + raw.slice(candidates[0] + 1));
  } catch {
    return null;
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const fit = uniqueToolForArgs(args, tools);
  return fit ? { name: fit.function.name, arguments: args } : null;
}

/** The one schema whose properties cover `args` and whose required keys `args` has, else null. */
function uniqueToolForArgs(args, tools) {
  const keys = Object.keys(args);
  const fits = (tools ?? []).filter((t) => {
    const params = t?.function?.parameters ?? {};
    const props = Object.keys(params.properties ?? {});
    const required = Array.isArray(params.required) ? params.required : [];
    return keys.every((k) => props.includes(k)) && required.every((k) => keys.includes(k));
  });
  return fits.length === 1 ? fits[0] : null;
}

/**
 * Recognize a tool call the model wrote as message text. Two shapes seen in
 * traces: qwen3-coder's XML form —
 *
 *     <function=read_file>
 *     <parameter=path>
 *     out.txt
 *     </parameter>
 *     </function>
 *
 * (optionally inside `<tool_call>`), and a JSON object with `name` and
 * `arguments`. A message that is only the call is a call. So is one complete
 * `<function>` block after a short preamble ("I need to find…", "Let me
 * search…") with nothing after the block: the preamble is narration, and the
 * call is what the model did. A finished answer that only leaks a call
 * ("Done.", a path, prose after the block) stays text. XML parameter values
 * are coerced to the schema's declared number/boolean types. Returns null
 * unless the tool exists.
 *
 * @param {string} text
 * @param {Array<object>} tools Schemas in the OpenAI function shape.
 * @returns {{name: string, arguments: object}|null}
 */
/**
 * True when assistant text opened a tool-call marker and stopped there.
 * A balanced example inside prose is not incomplete. An unclosed
 * `<tool_call>`, `<function=`, or `<parameter=` at the end of the message
 * is: the model stopped on the call token and the body never arrived.
 *
 * A `<tool_call>` token in the middle of a finished answer is a leak, not
 * a cutoff. Treating it as incomplete drops the answer and the model loses
 * the task (it then asks the user to restate work it already had).
 *
 * @param {string} text
 * @returns {boolean}
 */
export function incompleteToolCallText(text) {
  const body = String(text ?? "");
  if (!body) return false;
  if (strayToolCallInsideAnswer(body)) return false;
  const count = (re) => (body.match(re) || []).length;
  if (count(/<tool_call\b/g) > count(/<\/tool_call>/g)) return true;
  if (count(/<function=/g) > count(/<\/function>/g)) return true;
  if (count(/<parameter=/g) > count(/<\/parameter>/g)) return true;
  return false;
}

/**
 * Unclosed `<tool_call>` whose tail is the rest of the answer, not a call
 * body. An unclosed `<function=` / `<parameter=` still counts as a cutoff.
 *
 * Two leak shapes: prose *after* the stray marker, and — the one qwen3-coder
 * produces most — a finished answer that merely appends a bare `<tool_call>`
 * at the very end with nothing after it. The second is distinguished from a
 * genuine cutoff ("Let me read the file.<tool_call>") by what precedes the
 * marker: a substantial answer is a leak; a short narration is a real cutoff.
 *
 * @param {string} body
 * @returns {boolean}
 */
function strayToolCallInsideAnswer(body) {
  const count = (re) => (body.match(re) || []).length;
  if (count(/<tool_call\b/g) <= count(/<\/tool_call>/g)) return false;
  if (count(/<function=/g) > count(/<\/function>/g)) return false;
  if (count(/<parameter=/g) > count(/<\/parameter>/g)) return false;
  if (proseAfterLastMarker(body, /<tool_call\b[^>]*>/g)) return true;
  return finishedAnswerBeforeFirstMarker(body, /<tool_call\b[^>]*>/g);
}

/**
 * A complete answer that ends on a bare `<tool_call>` token with nothing
 * after it. The text before the first marker decides: a short narration is a
 * genuine cutoff (the model was about to call and stopped), a longer finished
 * answer is a token the model leaked onto the end of its reply. Reuses the
 * same preamble heuristic as the text-tool-call parser so the two agree.
 *
 * @param {string} body
 * @param {RegExp} re
 * @returns {boolean}
 */
function finishedAnswerBeforeFirstMarker(body, re) {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const first = global.exec(body);
  if (!first) return false;
  const before = body.slice(0, first.index).replace(/<\/?tool_call\b[^>]*>/gi, "").trim();
  if (!before) return false;
  return !isShortToolPreamble(before);
}

/**
 * @param {string} body
 * @param {RegExp} re
 * @returns {boolean}
 */
function proseAfterLastMarker(body, re) {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let last = null;
  let match;
  while ((match = global.exec(body)) !== null) last = match;
  if (!last) return false;
  const tail = body.slice(last.index + last[0].length).trim();
  if (!tail || tail.startsWith("<")) return false;
  const words = tail.split(/\s+/).filter((word) => /[A-Za-z]{2,}/.test(word));
  if (words.length >= 8) return true;
  return words.length >= 4 && /[.!?]/.test(tail);
}

/**
 * Remove a `<tool_call>` token the model wrote into an answer it finished
 * in prose. A whole-message tool call is parsed before this runs.
 * @param {string} text
 * @returns {string}
 */
export function stripStrayToolCallMarkup(text) {
  const raw = String(text ?? "");
  if (!/<\/?tool_call\b/i.test(raw)) return raw;
  return raw
    .replace(/<\/?tool_call\b[^>]*>/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1");
}

export function parseTextToolCall(text, tools) {
  const body = String(text ?? "").trim();
  if (!body || body.length > 20_000) return null;
  const schemaFor = (name) => (tools ?? []).find((t) => t?.function?.name === name);

  const whole = /^(?:<tool_call>\s*)?<function=([A-Za-z_][\w.-]*)>([\s\S]*?)<\/function>\s*(?:<\/tool_call>\s*)?$/.exec(body);
  if (whole) return parseXmlFunction(whole[1], whole[2], schemaFor);

  const preamble = extractPreambleFunction(body);
  if (preamble) return parseXmlFunction(preamble.name, preamble.inner, schemaFor);

  if (body.startsWith("{") && body.endsWith("}")) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
    const name = parsed?.name ?? parsed?.function?.name ?? parsed?.tool;
    const args = parsed?.arguments ?? parsed?.function?.arguments ?? parsed?.parameters ?? parsed?.args;
    if (typeof name === "string" && schemaFor(name) && args && typeof args === "object" && !Array.isArray(args)) {
      return { name, arguments: args };
    }
  }
  return null;
}

/**
 * One complete `<function>` block after a short preamble and before no
 * further prose. A finished answer ("Done.", a path) is not a preamble.
 * @param {string} body
 * @returns {{name: string, inner: string}|null}
 */
function extractPreambleFunction(body) {
  const blocks = [...body.matchAll(/<function=([A-Za-z_][\w.-]*)>([\s\S]*?)<\/function>/g)];
  if (blocks.length !== 1) return null;
  const block = blocks[0];
  const before = body.slice(0, block.index).replace(/<tool_call>\s*$/i, "").trim();
  const after = body.slice(block.index + block[0].length).replace(/^\s*<\/tool_call>/i, "").trim();
  if (!before || after) return null;
  if (!isShortToolPreamble(before)) return null;
  return { name: block[1], inner: block[2] };
}

/**
 * Narration in front of a tool call, not a deliverable the call leaked into.
 * @param {string} text
 * @returns {boolean}
 */
function isShortToolPreamble(text) {
  if (/^(done|complete|completed|finished|the file|the path|answer|result|here(?:'s| is))\b/i.test(text)) {
    return false;
  }
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 80) return false;
  const sentences = text.split(/[.!?]+/).map((part) => part.trim()).filter(Boolean);
  if (sentences.length > 3) return false;
  if (words.length <= 12 && /(?:^|\s)[\w./\\-]+\.(?:mjs|cjs|js|py|cs|ts|tsx|json|md)\b/i.test(text)) {
    return false;
  }
  return true;
}

/**
 * @param {string} name
 * @param {string} inner
 * @param {(name: string) => object|undefined} schemaFor
 * @returns {{name: string, arguments: object}|null}
 */
function parseXmlFunction(name, inner, schemaFor) {
  const schema = schemaFor(name);
  if (!schema) return null;
  const props = schema.function.parameters?.properties ?? {};
  const args = {};
  const param = /<parameter=([A-Za-z_][\w.-]*)>([\s\S]*?)<\/parameter>/g;
  let match;
  let sawAny = false;
  while ((match = param.exec(inner)) !== null) {
    sawAny = true;
    args[match[1]] = coerceByType(match[2].replace(/^\r?\n/, "").replace(/\r?\n$/, ""), props[match[1]]?.type);
  }
  if (!sawAny && inner.trim()) return null;
  return { name, arguments: args };
}

function coerceByType(value, type) {
  if (type === "integer" || type === "number") {
    const n = Number(value.trim());
    return Number.isFinite(n) && value.trim() !== "" ? n : value;
  }
  if (type === "boolean") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return value;
}

/**
 * When Ollama rejects a malformed tool call, repair it locally if the damage
 * is unambiguous; otherwise correct the model and retry instead of aborting
 * the run. `request.messages` is mutated in place.
 *
 * @param {object} client
 * @param {{messages: Array<object>, tools?: Array<object>, signal?: AbortSignal, onDelta?: Function, think?: boolean|string, options?: object}} request
 * @param {{ onParseError?: (info: { recovery: number, error: Error, repaired?: string }) => void }} [hooks]
 */
async function chatWithParseRecovery(client, request, hooks = {}) {
  const { messages, tools, signal, onDelta, think, options } = request;
  let recoveries = 0;
  while (true) {
    try {
      return await chatWithRetry(client, {
        messages,
        tools,
        signal,
        onDelta,
        ...(think !== undefined ? { think } : {}),
        ...(options ? { options } : {}),
      });
    } catch (err) {
      if (signal?.aborted || err?.name === "AbortError") throw err;
      if (!isToolCallParseError(err)) throw err;
      const repaired = repairToolCallParseError(err, tools);
      if (repaired) {
        hooks.onParseError?.({ recovery: recoveries, error: err, repaired: repaired.name });
        return {
          message: { role: "assistant", content: "", tool_calls: [{ function: repaired }] },
          raw: { repaired: true },
        };
      }
      if (recoveries >= MAX_TOOL_CALL_PARSE_RECOVERIES) throw err;
      recoveries += 1;
      hooks.onParseError?.({ recovery: recoveries, error: err });
      messages.push({ role: "user", content: TOOL_CALL_PARSE_NUDGE });
    }
  }
}

/** Keep only the fields Ollama understands when the assistant message is echoed back. */
function normalizeAssistantMessage(message) {
  const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  const normalized = { role: "assistant", content: hasTools ? "" : textOf(message.content) };
  if (hasTools) normalized.tool_calls = message.tool_calls;
  if (message.thinking) normalized.thinking = message.thinking;
  return normalized;
}

function textOf(content) {
  return typeof content === "string" ? content : "";
}

/**
 * Tool results go back to the model as text. Command results get a readable
 * status header so a failure cannot be mistaken for success just because the
 * tool call itself returned; everything else is passed through (JSON for
 * structured data).
 */
export function toolResultContent(outcome) {
  if (!outcome.ok) return `ERROR: ${outcome.error}`;
  const { result, note } = outcome;
  let body;
  if (result === undefined || result === null) body = "(no output)";
  else if (typeof result === "string") body = result;
  else if (typeof result === "object" && (result.exitCode !== undefined || result.status !== undefined)) {
    body = formatCommandResult(result);
  } else body = JSON.stringify(result);
  return note ? `${body}\n[note: ${note}]` : body;
}

function formatCommandResult(result) {
  const code = result.exitCode;
  const failed = (code != null && Number(code) !== 0) || result.timedOut === true;
  const lines = [
    `status: ${result.status ?? (failed ? `FAILED with exit code ${code}` : "success")}`,
    `exitCode: ${code ?? ""}`,
  ];
  if (result.timedOut) lines.push("timedOut: true");
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  lines.push(`stdout:\n${stdout.length ? stdout : "(empty)"}`);
  if (stderr.length || failed) lines.push(`stderr:\n${stderr.length ? stderr : "(empty)"}`);
  if (result.note) lines.push(`note: ${result.note}`);
  return lines.join("\n");
}

/**
 * Token budget derived from the client's context window, when it exposes one
 * (OllamaClient does). Undefined keeps compaction on the character trigger.
 */
function defaultTokenBudget(client) {
  const numCtx = client?.numCtx;
  if (!Number.isFinite(numCtx) || numCtx <= 0) return undefined;
  return Math.floor(numCtx * DEFAULT_CONTEXT_FRACTION);
}
