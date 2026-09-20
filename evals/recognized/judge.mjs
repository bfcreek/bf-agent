/**
 * Cursor-judge a Harbor trial the same way the dev bench judges a scenario.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { computeEfficiency } from "../efficiency.mjs";
import { judgeRun } from "../judge.mjs";

const SNAPSHOT_SKIP = new Set([
  "node_modules",
  ".git",
  ".halo-agent",
]);

/** Where Harbor's `--artifact /app` download lands inside a trial directory. */
export const APP_ARTIFACT_REL = path.join("artifacts", "app");

/**
 * @param {object} task from parse.mjs
 * @param {object} [options]
 * @param {string} [options.model]
 * @param {number} [options.timeoutSeconds]
 * @param {number} [options.retries]
 * @param {number} [options.maxSteps] Step cap the agent ran with.
 */
export async function judgeHarborTask(task, options = {}) {
  if (!task.trialDir) {
    throw new Error(`Task '${task.name}' has no trial directory to judge.`);
  }
  const packed = await loadTrialJudgeInput(task, { maxSteps: options.maxSteps ?? null });
  return judgeRun({
    scenario: packed.scenario,
    agentResult: packed.agentResult,
    workspaceDir: task.trialDir,
    oracle: packed.oracle,
    options: {
      model: options.model ?? "auto",
      timeoutSeconds: options.timeoutSeconds ?? 300,
      retries: options.retries ?? 2,
      preamble: packed.preamble,
      efficiency: packed.efficiency,
      maxSteps: options.maxSteps ?? null,
      changeSetRoot: packed.changeSetRoot,
      snapshotOptions: {
        maxFiles: 60,
        maxFileBytes: 12_000,
        skipDirs: SNAPSHOT_SKIP,
      },
    },
  });
}

/**
 * @param {object} task
 * @param {{maxSteps?: number|null}} [options]
 */
export async function loadTrialJudgeInput(task, { maxSteps = null } = {}) {
  const trialDir = task.trialDir;
  const instruction = await readInstruction(trialDir, task);
  const verifierLog = await readFirstExisting(trialDir, [
    "verifier/test-stdout.txt",
    "verifier/stdout.txt",
    "verifier/reward.txt",
  ]);
  const agentResult = await agentResultFromTrial(trialDir);
  const efficiency = computeEfficiency(agentResult, { maxSteps });

  const harborLine =
    task.reward != null
      ? `Harbor verifier reward: ${task.reward} (${task.resolved ? "PASS — hidden tests succeeded" : "FAIL — hidden tests did not succeed"}).`
      : "Harbor verifier reward: (missing — the trial may have errored before tests ran).";
  const exceptionLine = task.exception ? `Harbor exception: ${task.exception}` : "Harbor exception: none.";

  /** @type {import("../judge.mjs").Oracle} */
  const oracle = {
    pass: task.reward != null ? Boolean(task.resolved) : null,
    source: "harbor",
    detail: `${harborLine} ${exceptionLine}`,
  };

  const scenario = {
    name: task.name,
    goal: instruction,
    rubric: [
      "This is a Terminal-Bench task. Hidden tests are the ground truth for pass/fail; do not try to re-run them.",
      "Instruction following matters: staying on the requested files/paths and honoring constraints counts toward outcome.",
      "Runtime issues you notice (timeouts, tool errors, prompt gaps, compaction losing context) belong in agentImprovements.",
      "",
      "Verifier output (truncated):",
      (verifierLog ?? "(none)").slice(0, 4000),
    ].join("\n"),
  };

  const preamble = [
    "You are grading Bitfield Agent on a Terminal-Bench task that already ran inside Harbor/Docker.",
    "The workspace is the Harbor trial directory: instruction, agent logs, verifier output, and any downloaded /app artifacts.",
    "Harbor's hidden tests already produced a mechanical pass/fail (reward); it fixes the outcome band.",
    "Your job is qualitative: whether the artifacts match the instruction, how efficiently the agent worked, and what to change in the Bitfield Agent runtime.",
  ].join(" ");

  // Checkpoints live in the container's /app; when Harbor collected that
  // artifact the judge gets an exact before/after diff.
  const appDir = path.join(trialDir, APP_ARTIFACT_REL);
  const changeSetRoot = (await isDir(path.join(appDir, ".halo-agent", "checkpoints"))) ? appDir : trialDir;

  return { scenario, agentResult, preamble, oracle, efficiency, changeSetRoot };
}

/**
 * @param {string} trialDir
 * @param {object} task
 */
export async function readInstruction(trialDir, task) {
  const fromFiles = await readFirstExisting(trialDir, [
    "agent/instruction.txt",
    "instruction.md",
    "instruction.txt",
  ]);
  if (fromFiles) return fromFiles;
  try {
    const config = JSON.parse(await readFile(path.join(trialDir, "config.json"), "utf8"));
    const found = findInstructionField(config);
    if (found) return found;
  } catch {
    // ignore
  }
  return task?.trialResult?.config
    ? findInstructionField(task.trialResult.config) ?? `(Terminal-Bench task: ${task.name})`
    : `(Terminal-Bench task: ${task.name})`;
}

/**
 * Infer stop reason when Harbor session.json omits it after a crash.
 * @param {object|null|undefined} session
 * @param {{ stdout?: string }} [options]
 * @returns {string}
 */
export function inferAgentStopReason(session, { stdout = "" } = {}) {
  if (!session) {
    // The harbor-mode agent always writes session.json when it finishes. No
    // session means the process was killed (Harbor agent timeout, hang) or
    // crashed before the loop — never a completed run. Calling it "completed"
    // with 0 steps poisons pattern detection with phantom hollow finishes.
    return /timeout|timed.?out/i.test(stdout) ? "timeout" : "error";
  }
  const steps = session.steps ?? [];
  const explicit = session.stopReason;
  if (explicit && explicit !== "completed") return explicit;
  const blob = `${stdout}\n${session.error ?? ""}`;
  if (
    steps.length === 0 &&
    (/NonZeroAgentExitCode|error parsing tool call|exit code 3/i.test(blob) ||
      session.error ||
      !session.messages?.length)
  ) {
    return "error";
  }
  return explicit ?? "completed";
}

/**
 * @param {string} trialDir
 */
export async function agentResultFromTrial(trialDir) {
  const sessionRaw = await readFirstExisting(trialDir, [
    "agent/session.json",
    "agent/halo-agent/session.json",
    // The adapter copies the session into /logs/agent only after the CLI
    // exits. When Harbor kills the agent (AgentTimeoutError) that never runs,
    // but the live-flushed session survives in the collected /app artifact.
    "artifacts/app/.halo-agent/sessions/harbor.json",
  ]);
  const stdout = await readFirstExisting(trialDir, ["agent/stdout.txt", "logs/agent/stdout.txt"]);
  if (sessionRaw) {
    try {
      const session = JSON.parse(sessionRaw);
      const messages = session.messages ?? [];
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      return {
        text: typeof lastAssistant?.content === "string" ? lastAssistant.content : session.text ?? "",
        stopReason: inferAgentStopReason(session, { stdout: stdout ?? "" }),
        steps: session.steps ?? [],
        messages,
        elapsedMs: typeof session.elapsedMs === "number" ? session.elapsedMs : null,
        compactions: Number(session.compactions ?? 0) || 0,
        wallClockExhausted: session.wallClockExhausted === true,
      };
    } catch {
      // fall through
    }
  }
  return {
    text: stdout ?? "",
    stopReason: inferAgentStopReason(null, { stdout: stdout ?? "" }),
    steps: [],
    messages: [],
    elapsedMs: null,
    compactions: 0,
    wallClockExhausted: false,
  };
}

/**
 * Telemetry the reports and pattern detector need, pulled from a Harbor
 * trial session.
 * @param {object} task
 * @param {{maxSteps?: number|null}} [options]
 */
export async function loadTrialAgentMetrics(task, { maxSteps = null } = {}) {
  if (!task?.trialDir) {
    return { stepCount: 0, stopReason: null, efficiency: null };
  }
  const result = await agentResultFromTrial(task.trialDir);
  const efficiency = computeEfficiency(result, { maxSteps });
  return {
    stepCount: (result.steps ?? []).length,
    stopReason: result.stopReason ?? null,
    efficiency,
  };
}

async function isDir(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {string|null}
 */
export function findInstructionField(value, depth = 0) {
  if (value == null || depth > 8) return null;
  if (typeof value === "string") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findInstructionField(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  for (const key of ["instruction", "prompt", "goal"]) {
    if (typeof record[key] === "string" && record[key].trim()) return String(record[key]);
  }
  for (const nested of Object.values(record)) {
    const found = findInstructionField(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * @param {string} root
 * @param {string[]} rels
 */
async function readFirstExisting(root, rels) {
  for (const rel of rels) {
    try {
      return await readFile(path.join(root, rel), "utf8");
    } catch {
      // try next
    }
  }
  return null;
}
