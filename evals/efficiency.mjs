/**
 * Deterministic efficiency metrics from an agent run trace.
 *
 * This is the first layer of the process "meta-judge": everything here is
 * computed from `AgentRunResult.steps` (and `messages` when present), so it
 * is reproducible and comparable across runs and models. The LLM judge gets
 * these numbers as evidence; it does not re-derive them.
 *
 * Nothing here knows about task outcome. Combine with the oracle (precheck /
 * Harbor reward) in patterns.mjs to say whether a run was *wastefully* right
 * or *cheaply* wrong.
 */

import { EMPTY_RETRY_PROMPT, TRUNCATED_RETRY_PROMPT } from "../src/agent-loop.mjs";

export const READ_TOOLS = new Set(["read_file", "list_dir", "fetch_rule", "describe_tool"]);
export const SEARCH_TOOLS = new Set([
  "grep_search",
  "find_files",
  "search_project",
  "web_search",
  "fetch_url",
]);
export const MUTATION_TOOLS = new Set(["write_file", "edit_file"]);
export const EXEC_TOOLS = new Set(["run_command"]);

/** Flags and the penalty each takes off the heuristic score. */
export const FLAG_PENALTIES = {
  spinning: 15,
  "budget-exhausted": 15,
  "wall-clock-exhausted": 15,
  "no-verification": 15,
  "redundant-reads": 10,
  "blind-edit": 10,
  "edit-misses": 10,
  "no-exploration": 10,
  "high-failure-rate": 10,
    "parse-recoveries": 5,
    "empty-retries": 10,
    "truncated-turns": 10,
    "compaction-failed": 10,
    "heavy-compaction": 5,
    "no-tool-use": 0,
  };

/** One-line meaning per flag, for reports and the judge prompt. */
export const FLAG_DESCRIPTIONS = {
  spinning: "repeated the same failing command or identical tool call several times",
  "budget-exhausted": "hit the step cap before finishing",
  "wall-clock-exhausted": "hit the wall-clock budget before finishing",
  "no-verification": "changed files but never ran a command afterwards",
  "redundant-reads": "re-read the same file region with no change in between",
  "blind-edit": "edited a file it had not read or written earlier in the run",
  "edit-misses": "edit_file failed to find its target more than once",
  "no-exploration": "wrote or edited files without reading or searching first",
  "high-failure-rate": "a large share of tool calls failed",
    "parse-recoveries": "needed repeated tool-call parse corrections",
    "empty-retries": "returned empty assistant turns and exhausted empty-retry re-asks",
    "truncated-turns": "model output hit the context window (done_reason length) before a tool call or answer",
    "compaction-failed": "compaction was due but the summarizer produced nothing, so the transcript kept growing",
    "heavy-compaction": "the transcript was compacted more than once",
    "no-tool-use": "answered without calling any tool",
  };

/**
 * @param {string} name
 * @returns {"read"|"search"|"mutate"|"exec"|"other"}
 */
export function classifyTool(name) {
  if (READ_TOOLS.has(name)) return "read";
  if (SEARCH_TOOLS.has(name)) return "search";
  if (MUTATION_TOOLS.has(name)) return "mutate";
  if (EXEC_TOOLS.has(name)) return "exec";
  return "other";
}

/**
 * @typedef {object} EfficiencyMetrics
 * @property {number} steps
 * @property {number} modelCalls
 * @property {number} toolCalls
 * @property {number} failedToolCalls Tool-level errors plus commands that exited non-zero or timed out.
 * @property {number} failedToolRate
 * @property {{read: number, search: number, mutate: number, exec: number, other: number}} byCategory
 * @property {number} explorationRatio (read + search) / toolCalls
 * @property {number} redundantReads
 * @property {number} repeatedFailingCommands
 * @property {number} maxIdenticalRepeats
 * @property {number} blindEdits
 * @property {number} editMisses
 * @property {number} mutations Successful write_file / edit_file calls.
 * @property {string[]} filesTouched
 * @property {number|null} firstMutationStep
 * @property {number|null} lastMutationStep
 * @property {boolean|null} verifiedAfterLastMutation Null when nothing was mutated.
 * @property {string} stopReason
 * @property {boolean} wallClockExhausted
 * @property {boolean} wrapUp
 * @property {number|null} budgetUsed steps / maxSteps
 * @property {number|null} elapsedMs
 * @property {number} modelMs
 * @property {number} toolMs
 * @property {number} compactions
 * @property {number} compactionFailures Compactions that were due but produced no summary.
 * @property {number} parseRecoveries Malformed tool calls that cost a correction round-trip.
 * @property {number} parseRepairs Malformed tool calls the loop repaired locally (no round-trip).
 * @property {number} emptyRetries Model round-trips with neither text nor a tool call.
 * @property {number} truncatedTurns Model calls cut off by the context window (done_reason length).
 * @property {number} steers
 * @property {{prompt: number, completion: number, peakPrompt: number, perStep: number, window: number|null}|null} tokens
 * @property {string[]} flags
 * @property {number} heuristicScore 0–100, penalties from flags. A comparison aid, not a grade.
 */

/**
 * @param {import("../src/agent-loop.mjs").AgentRunResult | {steps?: Array<object>, messages?: Array<object>, stopReason?: string}} agentResult
 * @param {{maxSteps?: number|null, wallClockMs?: number|null}} [budget]
 * @returns {EfficiencyMetrics}
 */
export function computeEfficiency(agentResult, { maxSteps = null } = {}) {
  const steps = Array.isArray(agentResult?.steps) ? agentResult.steps : [];
  const messages = Array.isArray(agentResult?.messages) ? agentResult.messages : [];

  /** @type {Array<{step: number, name: string, args: object, ok: boolean, failed: boolean, category: string, path: string|null, key: string, durationMs: number}>} */
  const calls = [];
  let modelMs = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let peakPrompt = 0;
  let sawTokens = false;
  let modelCalls = 0;
  let parseRecoveries = 0;
  let parseRepairs = 0;
  let steers = 0;
  let wrapUp = false;
  let emptySteps = 0;
  let truncatedTurns = 0;

  for (const step of steps) {
    const kind = step?.kind;
    if (kind === "tool-parse-error") {
      if (step?.repaired) parseRepairs += 1;
      else parseRecoveries += 1;
    }
    if (kind === "steer") steers += 1;
    if (kind === "tool-calls" || kind === "final" || kind === "empty") modelCalls += 1;
    if (kind === "empty") emptySteps += 1;
    if (step?.truncated === true) truncatedTurns += 1;
    if (step?.wrapUp) wrapUp = true;
    if (typeof step?.durationMs === "number") modelMs += step.durationMs;
    if (typeof step?.promptTokens === "number") {
      sawTokens = true;
      promptTokens += step.promptTokens;
      peakPrompt = Math.max(peakPrompt, step.promptTokens);
    }
    if (typeof step?.completionTokens === "number") {
      sawTokens = true;
      completionTokens += step.completionTokens;
    }
    for (const call of step?.toolCalls ?? []) {
      const name = String(call?.name ?? "");
      const args = call?.args && typeof call.args === "object" ? call.args : {};
      const ok = call?.ok === true;
      calls.push({
        step: Number(step?.index ?? 0),
        name,
        args,
        ok,
        failed: !ok || commandFailed(call),
        category: classifyTool(name),
        path: filePathOf(name, args),
        key: `${name}:${stableJson(args)}`,
        durationMs: typeof call?.durationMs === "number" ? call.durationMs : 0,
      });
    }
  }

  const toolCalls = calls.length;
  // A command that ran but exited non-zero (missing interpreter, syntax
  // error, failing test) is a failed call from the agent's point of view,
  // same as a tool-level error. `ok` alone only covers the latter.
  const failedToolCalls = calls.filter((c) => c.failed).length;
  const byCategory = { read: 0, search: 0, mutate: 0, exec: 0, other: 0 };
  for (const c of calls) byCategory[c.category] += 1;

  // Redundant reads: same read_file region again with no mutation to that
  // path in between. Different offset/limit is pagination, not redundancy.
  let redundantReads = 0;
  const readKeysSincePathChanged = new Set();
  const seenPaths = new Set(); // read or written earlier
  let blindEdits = 0;
  let editMisses = 0;
  let mutations = 0;
  let firstMutationStep = null;
  let lastMutationStep = null;
  let lastMutationIndex = -1;
  const filesTouched = new Set();

  calls.forEach((c, i) => {
    if (c.name === "read_file" && c.path) {
      const key = `${c.path}|${c.args.offset ?? ""}|${c.args.limit ?? ""}`;
      if (readKeysSincePathChanged.has(key)) redundantReads += 1;
      readKeysSincePathChanged.add(key);
      seenPaths.add(c.path);
    } else if (c.category === "mutate" && c.path) {
      if (c.name === "edit_file") {
        if (!c.ok) editMisses += 1;
        if (!seenPaths.has(c.path)) blindEdits += 1;
      }
      if (c.ok) {
        mutations += 1;
        filesTouched.add(c.path);
        if (firstMutationStep === null) firstMutationStep = c.step;
        lastMutationStep = c.step;
        lastMutationIndex = i;
        // The file changed; a later read of it is legitimate.
        for (const key of [...readKeysSincePathChanged]) {
          if (key.startsWith(`${c.path}|`)) readKeysSincePathChanged.delete(key);
        }
      }
      seenPaths.add(c.path);
    }
  });

  // Spinning: identical failing commands, or any identical call repeated a lot.
  const failingCommandCounts = new Map();
  const identicalCounts = new Map();
  for (const c of calls) {
    identicalCounts.set(c.key, (identicalCounts.get(c.key) ?? 0) + 1);
    if (c.category === "exec" && c.failed) {
      failingCommandCounts.set(c.key, (failingCommandCounts.get(c.key) ?? 0) + 1);
    }
  }
  let repeatedFailingCommands = 0;
  for (const n of failingCommandCounts.values()) repeatedFailingCommands += Math.max(0, n - 1);
  const maxIdenticalRepeats = Math.max(0, ...identicalCounts.values());

  const verifiedAfterLastMutation =
    mutations === 0 ? null : calls.slice(lastMutationIndex + 1).some((c) => c.category === "exec");

  // Empty turns are recorded as `empty` steps; older traces only carry the
  // re-ask prompts in the transcript, so take whichever signal is richer.
  const emptyPrompts = messages.filter(
    (m) =>
      m?.role === "user" && (m?.content === EMPTY_RETRY_PROMPT || m?.content === TRUNCATED_RETRY_PROMPT),
  ).length;
  const emptyRetries = Math.max(emptySteps, emptyPrompts);
  if (truncatedTurns === 0 && typeof agentResult?.truncatedTurns === "number") {
    truncatedTurns = agentResult.truncatedTurns;
  }

  const stopReason = String(agentResult?.stopReason ?? "unknown");
  const wallClockExhausted = agentResult?.wallClockExhausted === true;
  const toolMs = calls.reduce((sum, c) => sum + c.durationMs, 0);

  const metrics = {
    steps: steps.length,
    modelCalls,
    toolCalls,
    failedToolCalls,
    failedToolRate: toolCalls ? failedToolCalls / toolCalls : 0,
    byCategory,
    explorationRatio: toolCalls ? (byCategory.read + byCategory.search) / toolCalls : 0,
    redundantReads,
    repeatedFailingCommands,
    maxIdenticalRepeats,
    blindEdits,
    editMisses,
    mutations,
    filesTouched: [...filesTouched].sort(),
    firstMutationStep,
    lastMutationStep,
    verifiedAfterLastMutation,
    stopReason,
    wallClockExhausted,
    wrapUp,
    budgetUsed: maxSteps && maxSteps > 0 ? Math.min(1, steps.length / maxSteps) : null,
    elapsedMs: typeof agentResult?.elapsedMs === "number" ? agentResult.elapsedMs : null,
    modelMs,
    toolMs,
    compactions: Number(agentResult?.compactions ?? 0) || 0,
    compactionFailures: Number(agentResult?.compactionFailures ?? 0) || 0,
    parseRecoveries,
    parseRepairs,
    emptyRetries,
    truncatedTurns,
    steers,
    tokens: sawTokens
      ? {
          prompt: promptTokens,
          completion: completionTokens,
          peakPrompt,
          perStep: modelCalls ? Math.round(promptTokens / modelCalls) : 0,
          window: typeof agentResult?.numCtx === "number" && agentResult.numCtx > 0 ? agentResult.numCtx : null,
        }
      : null,
    flags: [],
    heuristicScore: 100,
  };
  metrics.flags = deriveFlags(metrics);
  metrics.heuristicScore = heuristicScore(metrics.flags);
  return metrics;
}

/**
 * @param {EfficiencyMetrics} m
 * @returns {string[]}
 */
export function deriveFlags(m) {
  const flags = [];
  if (m.repeatedFailingCommands >= 2 || m.maxIdenticalRepeats >= 3) flags.push("spinning");
  if (m.redundantReads >= 2) flags.push("redundant-reads");
  if (m.blindEdits >= 1) flags.push("blind-edit");
  if (m.editMisses >= 2) flags.push("edit-misses");
  if (m.mutations > 0 && m.verifiedAfterLastMutation === false) flags.push("no-verification");
  if (m.mutations > 0 && m.byCategory.read + m.byCategory.search === 0) flags.push("no-exploration");
  if (m.stopReason === "max-steps" && !m.wallClockExhausted) flags.push("budget-exhausted");
  if (m.wallClockExhausted) flags.push("wall-clock-exhausted");
  if (m.toolCalls >= 4 && m.failedToolRate >= 0.3) flags.push("high-failure-rate");
  if (m.parseRecoveries >= 2) flags.push("parse-recoveries");
  if (m.emptyRetries >= 2 || m.stopReason === "empty") flags.push("empty-retries");
  if (m.truncatedTurns >= 1) flags.push("truncated-turns");
  if (m.compactionFailures >= 1) flags.push("compaction-failed");
  if (m.compactions >= 2) flags.push("heavy-compaction");
  if ((m.stopReason === "completed" || m.stopReason === "empty") && m.toolCalls === 0) {
    flags.push("no-tool-use");
  }
  return flags;
}

/**
 * @param {string[]} flags
 */
export function heuristicScore(flags) {
  let score = 100;
  for (const flag of flags ?? []) score -= FLAG_PENALTIES[flag] ?? 0;
  return Math.max(0, Math.min(100, score));
}

/**
 * Compact block for the judge prompt. Numbers first, flags with meanings.
 * @param {EfficiencyMetrics} m
 */
export function formatEfficiencyForPrompt(m) {
  if (!m) return "(no efficiency metrics)";
  const lines = [
    `steps: ${m.steps} (model calls ${m.modelCalls}${m.budgetUsed != null ? `, ${Math.round(m.budgetUsed * 100)}% of step budget` : ""})`,
    `tool calls: ${m.toolCalls} — read ${m.byCategory.read}, search ${m.byCategory.search}, mutate ${m.byCategory.mutate}, exec ${m.byCategory.exec}, other ${m.byCategory.other}; failed ${m.failedToolCalls}`,
    `files touched: ${m.filesTouched.length ? m.filesTouched.join(", ") : "(none)"}`,
    `mutations: ${m.mutations}; first at step ${m.firstMutationStep ?? "—"}, last at step ${m.lastMutationStep ?? "—"}; command run after last change: ${m.verifiedAfterLastMutation == null ? "n/a" : m.verifiedAfterLastMutation ? "yes" : "NO"}`,
    `waste signals: redundant reads ${m.redundantReads}, repeated failing commands ${m.repeatedFailingCommands}, blind edits ${m.blindEdits}, edit misses ${m.editMisses}, parse recoveries ${m.parseRecoveries} (repaired locally ${m.parseRepairs ?? 0}), empty retries ${m.emptyRetries}, truncated turns ${m.truncatedTurns ?? 0}`,
    `stop: ${m.stopReason}${m.wallClockExhausted ? " (wall clock)" : ""}${m.wrapUp ? ", wrap-up answer" : ""}; compactions ${m.compactions}${m.compactionFailures ? ` (${m.compactionFailures} failed)` : ""}`,
  ];
  if (m.elapsedMs != null) {
    lines.push(
      `time: ${formatMs(m.elapsedMs)} total, model ${formatMs(m.modelMs)}, tools ${formatMs(m.toolMs)}`,
    );
  }
  if (m.tokens) {
    lines.push(
      `tokens: prompt ${m.tokens.prompt} (peak ${m.tokens.peakPrompt}${m.tokens.window ? ` of a ${m.tokens.window} window` : ""}, ~${m.tokens.perStep}/call), completion ${m.tokens.completion}`,
    );
  }
  lines.push(
    m.flags.length
      ? `flags: ${m.flags.map((f) => `${f} (${FLAG_DESCRIPTIONS[f] ?? ""})`).join("; ")}`
      : "flags: none",
  );
  lines.push(`heuristic efficiency: ${m.heuristicScore}/100 (penalties from flags only)`);
  return lines.join("\n");
}

/**
 * Aggregate metrics across runs for reports and the scoreboard.
 * @param {Array<EfficiencyMetrics|null|undefined>} list
 */
export function summarizeEfficiency(list) {
  const rows = (list ?? []).filter(Boolean);
  if (rows.length === 0) {
    return {
      runs: 0,
      avgSteps: null,
      avgToolCalls: null,
      avgFailedToolRate: null,
      avgPromptTokens: null,
      verifiedRate: null,
      avgHeuristicScore: null,
      flagCounts: {},
    };
  }
  const withTokens = rows.filter((r) => r.tokens);
  const mutated = rows.filter((r) => r.verifiedAfterLastMutation != null);
  const flagCounts = {};
  for (const r of rows) for (const f of r.flags ?? []) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
  return {
    runs: rows.length,
    avgSteps: avg(rows.map((r) => r.steps)),
    avgToolCalls: avg(rows.map((r) => r.toolCalls)),
    avgFailedToolRate: avg(rows.map((r) => r.failedToolRate)),
    avgPromptTokens: withTokens.length ? avg(withTokens.map((r) => r.tokens.prompt)) : null,
    verifiedRate: mutated.length
      ? mutated.filter((r) => r.verifiedAfterLastMutation === true).length / mutated.length
      : null,
    avgHeuristicScore: avg(rows.map((r) => r.heuristicScore)),
    flagCounts,
  };
}

// ---------------------------------------------------------------------------

function commandFailed(call) {
  const result = call?.result;
  if (!result || typeof result !== "object") return false;
  if (result.timedOut === true) return true;
  const code = result.exitCode;
  return code != null && Number(code) !== 0;
}

function filePathOf(name, args) {
  if (!MUTATION_TOOLS.has(name) && name !== "read_file") return null;
  const raw = args?.path;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
    .join(",")}}`;
}

function avg(nums) {
  const vals = nums.filter((n) => typeof n === "number" && Number.isFinite(n));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function formatMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
