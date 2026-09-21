/**
 * Grade halo-agent runs with the Cursor CLI agent (default model: auto).
 * Read-only ask mode, and the grading packet is one file. The invocation
 * tells the judge not to open anything else: exploring a trial workspace
 * (sequence dumps, verifier logs) is what blows the judge timeout.
 *
 * The verdict has two independent scores:
 *
 * - **outcome** — did the deliverable satisfy the task. When a mechanical
 *   oracle exists (dev-bench precheck, Harbor hidden tests) it fixes the band
 *   (pass → 70–100, fail → 0–50) and the judge only ranks quality inside it.
 *   Without an oracle the judge's number stands on its own.
 * - **process** — how efficiently the agent got there: proportionate
 *   exploration, read-before-edit, verification, no spinning, budget use.
 *   The judge gets the deterministic metrics from efficiency.mjs as evidence
 *   and is asked to name the wasted steps by number.
 *
 * `verdict.score` mirrors `outcome.score` so gates and history stay
 * comparable.
 */

import { spawn } from "node:child_process";

import {
  ARTIFACTS_JUDGE_PROMPT,
  formatStepSummary,
  persistAgentArtifacts,
  persistJudgePrompt,
} from "./agent-artifacts.mjs";
import { collectChangeSet, formatChangeSetForPrompt } from "./change-set.mjs";
import { computeEfficiency, formatEfficiencyForPrompt } from "./efficiency.mjs";
import { captureWorkspaceSnapshot, formatSnapshotForPrompt } from "./workspace-snapshot.mjs";
import { agentAnswerText } from "./scenarios.mjs";

const DEFAULT_AGENT_BIN = "agent";
const INVALID_SUMMARY = "Judge response was not valid JSON.";

/** Outcome band when a mechanical oracle passed / failed. */
export const ORACLE_PASS_FLOOR = 70;
export const ORACLE_FAIL_CEILING = 50;
/** Judge outcome score at or above which it "agrees" the task passed. */
const AGREEMENT_THRESHOLD = 60;

/**
 * Windows cannot spawn .cmd/.bat directly; route through cmd.exe instead.
 * @param {string} agentBin
 * @param {string[]} args
 */
export function buildAgentSpawn(agentBin, args) {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", agentBin, ...args],
    };
  }
  return { command: agentBin, args };
}

/**
 * @typedef {object} Oracle
 * @property {boolean|null} pass Mechanical result; null when the task has none.
 * @property {"precheck"|"harbor"|"integrity"|string} source
 * @property {string} [detail]
 */

/**
 * @typedef {object} JudgeVerdict
 * @property {number} score Outcome score (0–100); mirrors `outcome.score`.
 * @property {string} grade Letter grade for the outcome score.
 * @property {{score: number, judgeScore: number, oracle: boolean|null, source: "oracle-anchored"|"judge", agreesWithOracle: boolean|null, notes: string}} outcome
 * @property {{score: number|null, grade: string|null, notes: string, wastedSteps: Array<{step: number, why: string}>, missing: string[]}} process
 * @property {string} summary One-paragraph assessment
 * @property {string[]} strengths
 * @property {string[]} weaknesses
 * @property {Array<{area: string, suggestion: string, priority: "low"|"medium"|"high"}>} agentImprovements
 * @property {string} raw Judge model text (parsed JSON when possible)
 */

/**
 * @param {object} input
 * @param {import("./scenarios.mjs").BenchScenario} input.scenario
 * @param {import("../src/agent-loop.mjs").AgentRunResult} input.agentResult
 * @param {string} input.workspaceDir
 * @param {Oracle|null} [input.oracle] Mechanical pass/fail to anchor the outcome score.
 * @param {object} [input.options]
 * @param {string} [input.options.model]
 * @param {string} [input.options.agentBin]
 * @param {number} [input.options.timeoutSeconds]
 * @param {number} [input.options.retries]
 * @param {string} [input.options.preamble] Extra instructions prepended to the prompt.
 * @param {object} [input.options.snapshotOptions] Passed to captureWorkspaceSnapshot.
 * @param {string} [input.options.changeSetRoot] Directory holding `.halo-agent/checkpoints` (default: workspaceDir).
 * @param {number} [input.options.maxSteps] Step budget the agent ran with (for budget metrics).
 * @param {import("./efficiency.mjs").EfficiencyMetrics} [input.options.efficiency] Precomputed metrics.
 */
export async function judgeRun({ scenario, agentResult, workspaceDir, oracle = null, options = {} }) {
  const efficiency =
    options.efficiency ?? computeEfficiency(agentResult, { maxSteps: options.maxSteps ?? null });
  await persistAgentArtifacts(workspaceDir, agentResult, {
    goal: scenario.goal,
    followUp: scenario.followUp ?? null,
    rubric: scenario.rubric,
    oracle,
    efficiency,
  });

  let changeSet;
  try {
    changeSet = await collectChangeSet(options.changeSetRoot ?? workspaceDir);
  } catch {
    changeSet = { source: "none", root: workspaceDir, runIds: [], files: [] };
  }
  // With a diff in hand the judge only needs to know what else exists; the
  // full-content snapshot is the fallback for runs without checkpoints.
  const snapshot = await captureWorkspaceSnapshot(workspaceDir, {
    ...(options.snapshotOptions ?? {}),
    ...(changeSet.files.length > 0 ? { listOnly: true, maxFiles: 120 } : {}),
  });

  const retries = options.retries ?? 2;
  let lastRaw = "";
  let lastVerdict = null;
  const promptInput = {
    scenario,
    agentResult,
    snapshot,
    changeSet,
    efficiency,
    oracle,
    preamble: options.preamble,
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    const prompt =
      attempt === 0
        ? buildJudgePrompt(promptInput)
        : buildJudgeRetryPrompt({ ...promptInput, priorRaw: lastRaw });
    lastRaw = await runCursorAgent({
      prompt,
      workspaceDir,
      model: options.model ?? "auto",
      agentBin: options.agentBin ?? DEFAULT_AGENT_BIN,
      timeoutSeconds: options.timeoutSeconds ?? 300,
    });
    lastVerdict = parseJudgeResponse(lastRaw, { oracle });
    if (isUsableVerdict(lastVerdict)) return lastVerdict;
  }

  const detail = lastVerdict?.summary || INVALID_SUMMARY;
  throw new Error(detail);
}

export function isUsableVerdict(verdict) {
  return verdict.grade !== "?" && verdict.summary !== INVALID_SUMMARY;
}

const JUDGE_RESPONSE_SCHEMA = {
  outcome: {
    score: 0,
    notes: "does the deliverable satisfy the task — cite files, tests, or output",
  },
  process: {
    score: 0,
    notes: "how efficiently and carefully the agent got there, given the task's size",
    wastedSteps: [{ step: 0, why: "what this step cost and why it was unnecessary" }],
    missing: ["a step a careful engineer would have taken and the agent skipped"],
  },
  summary: "one paragraph",
  strengths: ["..."],
  weaknesses: ["..."],
  agentImprovements: [
    {
      area: "system prompt | tools | loop | compaction | routing | other",
      suggestion: "concrete change to the Bitfield Agent runtime",
      priority: "low|medium|high",
    },
  ],
};

function truncateForJudge(text, max = 180) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * @param {import("../src/agent-loop.mjs").AgentRunResult} agentResult
 */
function formatAgentStepsForJudge(agentResult) {
  return (agentResult.steps ?? [])
    .map((step) => {
      const tools = (step.toolCalls ?? [])
        .map((c) => `${c.name}(${truncateForJudge(JSON.stringify(c.args))}) -> ${c.ok ? "ok" : c.error}`)
        .join("; ");
      const timing =
        typeof step.durationMs === "number" || typeof step.promptTokens === "number"
          ? ` {${[
              typeof step.durationMs === "number" ? `${(step.durationMs / 1000).toFixed(1)}s` : null,
              typeof step.promptTokens === "number" ? `${step.promptTokens} prompt tok` : null,
            ]
              .filter(Boolean)
              .join(", ")}}`
          : "";
      return `  ${step.index}. [${step.kind}]${timing} ${step.content?.slice(0, 200) || "(no text)"}${tools ? ` | ${tools}` : ""}`;
    })
    .join("\n");
}

/**
 * @param {Oracle|null|undefined} oracle
 */
export function formatOracleForPrompt(oracle) {
  if (!oracle || oracle.pass == null) {
    return [
      "No mechanical check exists for this task. Your outcome score stands on its own — grade what the workspace and final answer actually deliver.",
    ].join("\n");
  }
  const label = oracle.source === "harbor" ? "Harbor hidden tests" : `${oracle.source}`;
  const verdict = oracle.pass ? "PASS" : "FAIL";
  const band = oracle.pass
    ? `Outcome band is fixed at ${ORACLE_PASS_FLOOR}–100: rank quality inside it (completeness, correctness beyond the tests, instruction following).`
    : `Outcome band is fixed at 0–${ORACLE_FAIL_CEILING}: rank how close the attempt got (partial deliverable vs. nothing). Only note if the tests look flaky; do not override them.`;
  return [
    `${label}: ${verdict}.${oracle.detail ? ` ${String(oracle.detail).slice(0, 1500)}` : ""}`,
    band,
  ].join("\n");
}

/**
 * Shared grading context for initial and retry judge prompts.
 * @param {object} input
 * @param {import("./scenarios.mjs").BenchScenario} input.scenario
 * @param {import("../src/agent-loop.mjs").AgentRunResult} input.agentResult
 * @param {Awaited<ReturnType<typeof captureWorkspaceSnapshot>>} input.snapshot
 * @param {import("./change-set.mjs").ChangeSet} [input.changeSet]
 * @param {import("./efficiency.mjs").EfficiencyMetrics} [input.efficiency]
 * @param {Oracle|null} [input.oracle]
 */
function buildJudgeGradingContext({ scenario, agentResult, snapshot, changeSet, efficiency, oracle }) {
  const steps = formatAgentStepsForJudge(agentResult);
  const stepSummary = formatStepSummary(agentResult);
  const metrics = efficiency ?? computeEfficiency(agentResult);
  return [
    "## Task",
    scenario.followUp
      ? [
          "### Phase 1 — create",
          scenario.goal,
          "",
          "### Phase 2 — follow-up change",
          scenario.followUp,
        ].join("\n")
      : scenario.goal,
    "",
    "## Rubric",
    scenario.rubric,
    "",
    "## Ground truth",
    formatOracleForPrompt(oracle),
    "",
    "## Efficiency metrics (computed from the trace — treat as facts)",
    formatEfficiencyForPrompt(metrics),
    "",
    "## Agent step summary",
    stepSummary,
    "",
    "## Agent final answer",
    agentAnswerText(agentResult) || "(empty)",
    "",
    `## Agent stop reason: ${agentResult.stopReason}`,
    `## Agent steps (${agentResult.steps?.length ?? 0}):`,
    steps || "  (none)",
    "",
    "## Files changed by the agent",
    formatChangeSetForPrompt(changeSet),
    "",
    "## Workspace snapshot",
    formatSnapshotForPrompt(snapshot),
  ].join("\n");
}

const SCORING_GUIDE = [
  "Score two things independently:",
  "- outcome.score (0–100): does the deliverable satisfy the task? Use the ground-truth band when one is given. Judge the workspace and final answer, not your own ability to fix it.",
  "- process.score (0–100): was the path proportionate to the task? Reward reading before editing, running the relevant command after changes, and stopping when done. Penalize repeated failing commands, redundant reads, blind edits, unverified changes, and burning the budget. The efficiency metrics are computed facts; use them, and list wasted steps by their step number from the trace.",
  "A run can score high on outcome and low on process, or the reverse. Do not blend them.",
];

/**
 * @param {object} input
 * @param {import("./scenarios.mjs").BenchScenario} input.scenario
 * @param {import("../src/agent-loop.mjs").AgentRunResult} input.agentResult
 * @param {Awaited<ReturnType<typeof captureWorkspaceSnapshot>>} input.snapshot
 * @param {import("./change-set.mjs").ChangeSet} [input.changeSet]
 * @param {import("./efficiency.mjs").EfficiencyMetrics} [input.efficiency]
 * @param {Oracle|null} [input.oracle]
 * @param {string} [input.priorRaw]
 * @param {string} [input.preamble]
 */
export function buildJudgeRetryPrompt({ scenario, agentResult, snapshot, changeSet, efficiency, oracle, priorRaw, preamble }) {
  return [
    ...(preamble ? [preamble, ""] : []),
    "Your previous grading response was invalid or incomplete.",
    "Reply with ONLY a single JSON object matching the schema below — no markdown fences, no placeholders.",
    ...SCORING_GUIDE,
    "",
    buildJudgeGradingContext({ scenario, agentResult, snapshot, changeSet, efficiency, oracle }),
    "",
    "Previous invalid response:",
    String(priorRaw ?? "").slice(0, 1500),
    "",
    "Respond with a single JSON object and no markdown fences. Schema:",
    JSON.stringify(JUDGE_RESPONSE_SCHEMA, null, 2),
  ].join("\n");
}

/**
 * @param {object} input
 * @param {import("./scenarios.mjs").BenchScenario} input.scenario
 * @param {import("../src/agent-loop.mjs").AgentRunResult} input.agentResult
 * @param {Awaited<ReturnType<typeof captureWorkspaceSnapshot>>} input.snapshot
 * @param {import("./change-set.mjs").ChangeSet} [input.changeSet]
 * @param {import("./efficiency.mjs").EfficiencyMetrics} [input.efficiency]
 * @param {Oracle|null} [input.oracle]
 * @param {string} [input.preamble]
 */
export function buildJudgePrompt({ scenario, agentResult, snapshot, changeSet, efficiency, oracle, preamble }) {
  return [
    ...(preamble ? [preamble, ""] : []),
    "You are grading an AI coding agent (Bitfield Agent) that ran against a task in a temp workspace.",
    ...SCORING_GUIDE,
    `Use the step list in this prompt. Do not open other files.`,
    "",
    buildJudgeGradingContext({ scenario, agentResult, snapshot, changeSet, efficiency, oracle }),
    "",
    "Respond with a single JSON object and no markdown fences. Schema:",
    JSON.stringify(JUDGE_RESPONSE_SCHEMA, null, 2),
  ].join("\n");
}

/**
 * The mechanical ground truth handed to the judge for a dev-bench scenario.
 * Precheck is the task's own test; an integrity miss (unexpected writes or
 * deletes) is a hard fail regardless of what the precheck says.
 *
 * @param {{pass: boolean|null, detail: string}|null|undefined} precheck
 * @param {{pass: boolean|null, detail: string}|null|undefined} integrity
 * @returns {Oracle|null}
 */
export function buildOracle(precheck, integrity) {
  if (integrity?.pass === false) {
    return { pass: false, source: "integrity", detail: `integrity FAIL: ${integrity.detail}` };
  }
  if (precheck?.pass == null) return null;
  return {
    pass: precheck.pass,
    source: "precheck",
    detail: `precheck ${precheck.pass ? "PASS" : "FAIL"}: ${precheck.detail}`,
  };
}

/**
 * Pin the judge's outcome score to the mechanical result when there is one.
 * @param {number} judgeScore
 * @param {Oracle|null|undefined} oracle
 */
export function anchorOutcome(judgeScore, oracle) {
  const score = clampScore(judgeScore);
  if (!oracle || oracle.pass == null) {
    return { score, judgeScore: score, oracle: null, source: "judge", agreesWithOracle: null };
  }
  const agrees = oracle.pass ? score >= AGREEMENT_THRESHOLD : score < AGREEMENT_THRESHOLD;
  const anchored = oracle.pass
    ? Math.max(ORACLE_PASS_FLOOR, score)
    : Math.min(ORACLE_FAIL_CEILING, score);
  return {
    score: anchored,
    judgeScore: score,
    oracle: oracle.pass,
    source: "oracle-anchored",
    agreesWithOracle: agrees,
  };
}

/**
 * @param {string} text
 * @param {{oracle?: Oracle|null}} [context]
 * @returns {JudgeVerdict}
 */
export function parseJudgeResponse(text, { oracle = null } = {}) {
  const parsed = extractJsonObject(String(text ?? ""));
  if (!parsed) {
    return {
      score: 0,
      grade: "?",
      outcome: { score: 0, judgeScore: 0, oracle: oracle?.pass ?? null, source: "judge", agreesWithOracle: null, notes: "" },
      process: { score: null, grade: null, notes: "", wastedSteps: [], missing: [] },
      summary: INVALID_SUMMARY,
      strengths: [],
      weaknesses: [],
      agentImprovements: [],
      raw: String(text ?? ""),
    };
  }

  // Accept the legacy single-score shape so old artifacts still parse.
  const outcomeRaw = parsed.outcome && typeof parsed.outcome === "object" ? parsed.outcome : null;
  const outcomeScore = outcomeRaw?.score ?? parsed.score;
  const outcome = {
    ...anchorOutcome(outcomeScore, oracle),
    notes: String(outcomeRaw?.notes ?? ""),
  };

  const processRaw = parsed.process && typeof parsed.process === "object" ? parsed.process : null;
  const processScore = processRaw && processRaw.score != null ? clampScore(processRaw.score) : null;
  const process = {
    score: processScore,
    grade: processScore == null ? null : scoreToGrade(processScore),
    notes: String(processRaw?.notes ?? ""),
    wastedSteps: Array.isArray(processRaw?.wastedSteps)
      ? processRaw.wastedSteps
          .map((w) => ({ step: Number(w?.step) || 0, why: String(w?.why ?? "") }))
          .filter((w) => w.why)
      : [],
    missing: Array.isArray(processRaw?.missing) ? processRaw.missing.map(String).filter(Boolean) : [],
  };

  return {
    score: outcome.score,
    grade: typeof parsed.grade === "string" && parsed.grade.trim() ? parsed.grade : scoreToGrade(outcome.score),
    outcome,
    process,
    summary: String(parsed.summary ?? ""),
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(String) : [],
    weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses.map(String) : [],
    agentImprovements: Array.isArray(parsed.agentImprovements)
      ? parsed.agentImprovements.map((item) => ({
          area: String(item.area ?? "other"),
          suggestion: String(item.suggestion ?? ""),
          priority: ["low", "medium", "high"].includes(item.priority) ? item.priority : "medium",
        }))
      : [],
    raw: String(text ?? ""),
  };
}

/** @param {string} text */
function extractJsonObject(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** @param {number} score */
export function scoreToGrade(score) {
  if (score >= 93) return "A";
  if (score >= 90) return "A-";
  if (score >= 87) return "B+";
  if (score >= 83) return "B";
  if (score >= 80) return "B-";
  if (score >= 77) return "C+";
  if (score >= 73) return "C";
  if (score >= 70) return "C-";
  if (score >= 67) return "D+";
  if (score >= 60) return "D";
  return "F";
}

/** Short CLI prompt. The grading packet is already one file; the judge must not explore the workspace. */
export function buildJudgeInvocationPrompt() {
  return [
    "You are grading an AI coding agent (Bitfield Agent).",
    `Read ${ARTIFACTS_JUDGE_PROMPT} and nothing else. It already contains the task, the ground truth, the efficiency metrics, the step trace, and the file changes.`,
    "Do not use tools. Do not open any other file. Do not re-run tests.",
    "Reply with ONLY a single JSON object matching the schema in that file — no markdown fences.",
  ].join("\n");
}

/**
 * Build argv for the Cursor CLI judge. Exported for tests (Windows cmd line limit).
 * @param {object} options
 * @param {string} options.workspaceDir
 * @param {string} options.model
 * @param {string} [options.invocationPrompt]
 */
export function buildCursorAgentArgs({ workspaceDir, model, invocationPrompt = buildJudgeInvocationPrompt() }) {
  return [
    "--print",
    "--trust",
    "--mode",
    "ask",
    "--model",
    model,
    "--output-format",
    "json",
    "--workspace",
    workspaceDir,
    invocationPrompt,
  ];
}

/**
 * @param {object} options
 * @param {string} options.prompt
 * @param {string} options.workspaceDir
 * @param {string} options.model
 * @param {string} options.agentBin
 * @param {number} options.timeoutSeconds
 */
export async function runCursorAgent({ prompt, workspaceDir, model, agentBin, timeoutSeconds }) {
  await persistJudgePrompt(workspaceDir, prompt);
  const args = buildCursorAgentArgs({ workspaceDir, model });

  return new Promise((resolve, reject) => {
    const { command, args: spawnArgs } = buildAgentSpawn(agentBin, args);
    const child = spawn(command, spawnArgs, {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Cursor agent timed out after ${timeoutSeconds}s`));
    }, timeoutSeconds * 1000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to run '${agentBin}': ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Cursor agent exited ${code}: ${stderr || stdout}`.trim()));
        return;
      }
      try {
        const envelope = JSON.parse(stdout.trim());
        resolve(String(envelope.result ?? ""));
      } catch {
        resolve(stdout.trim());
      }
    });
  });
}
