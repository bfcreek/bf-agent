/**
 * Lightweight live plan state: parse numbered steps, checkpoint progress,
 * and prompts for remaining-step replan / multiturn adjust.
 */

import {
  commandExitCode,
  flattenToolCalls,
  MUTATING_TOOL_NAMES,
  runCommandText,
} from "./prompt-enhancements.mjs";

/** @typedef {"pending"|"done"} PlanStepStatus */

/**
 * @typedef {object} PlanStep
 * @property {number} id
 * @property {string} text
 * @property {PlanStepStatus} status
 */

/**
 * @typedef {object} PlanState
 * @property {PlanStep[]} steps
 * @property {string} raw
 */

/** Max remaining-step replans inside one `run()`. */
export const MAX_REMAINING_REPLANS = 2;

/**
 * Multiturn follow-up: revise the prior plan for the new goal (no tools).
 */
export const ADJUST_PLAN_MESSAGE = [
  "The user has a new follow-up goal. Adjust the plan for this new request.",
  "If a prior plan appears above, keep completed work and revise only what remains.",
  "Reply with a short numbered plan (2–4 remaining steps) naming tools you will use,",
  "then a ## Acceptance section (deliverable: / command: / output: bullets).",
  "Do not call tools yet — reply with only the adjusted plan and ## Acceptance.",
].join(" ");

/**
 * Mid-run: replan only remaining work after a stuck/struggle signal (no tools).
 */
export const REPLAN_REMAINING_MESSAGE = [
  "Progress against the plan is stuck or the approach is failing.",
  "Given the ## Plan progress and tool results above, write a short revised plan",
  "for only the remaining work (2–4 numbered steps).",
  "Do not repeat completed steps. Name specific tools.",
  "Update ## Acceptance if checks should change.",
  "Do not call tools yet — reply with only the remaining-steps plan and ## Acceptance.",
].join(" ");

const NUMBERED_STEP = /^\s*(\d+)[.)]\s+(.+)$/;
const SECTION_HEADER = /^#{1,3}\s+/;
const FILE_PATH_IN_TEXT = /(?:^|[\s`"'(])([\w./-]+\.[A-Za-z0-9]+)(?=[\s`"''),]|$)/g;

/**
 * Whether a user message is a planning / adjust / replan pre-pass prompt.
 * @param {string} content
 * @returns {boolean}
 */
export function isPlanPrompt(content) {
  const text = String(content ?? "");
  if (!text) return false;
  if (/Do not call tools yet/i.test(text)) return true;
  if (/remaining numbered steps|remaining-steps plan|Adjust the plan for this new/i.test(text)) {
    return true;
  }
  if (/^Before using any tools, write a short/i.test(text)) return true;
  return false;
}

/**
 * Extract numbered plan lines; skip ## Acceptance body (and ## Goals bullets).
 * Numbered steps after Goals still count as the plan body.
 * @param {string} planText
 * @returns {PlanStep[]}
 */
export function parsePlanSteps(planText) {
  const text = String(planText ?? "");
  if (!text.trim()) return [];

  const steps = [];
  let inAcceptance = false;
  let inGoals = false;

  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (SECTION_HEADER.test(trimmed)) {
      inAcceptance = /^(#{1,3})\s*Acceptance\b/i.test(trimmed);
      inGoals = /^(#{1,3})\s*Goals\b/i.test(trimmed);
      continue;
    }
    if (inAcceptance) continue;

    const match = trimmed.match(NUMBERED_STEP);
    if (match) {
      inGoals = false;
      steps.push({
        id: Number(match[1]),
        text: match[2].trim(),
        status: "pending",
      });
      continue;
    }

    if (inGoals) continue;
  }

  return steps;
}

/**
 * @param {string} planText
 * @returns {PlanState}
 */
export function createPlanState(planText) {
  const raw = String(planText ?? "").trim();
  return { steps: parsePlanSteps(raw), raw };
}

/**
 * Paths mentioned in a plan step (best-effort).
 * @param {string} stepText
 * @returns {string[]}
 */
export function pathsInStepText(stepText) {
  const found = [];
  const text = String(stepText ?? "");
  FILE_PATH_IN_TEXT.lastIndex = 0;
  let m;
  while ((m = FILE_PATH_IN_TEXT.exec(text)) !== null) {
    const p = m[1].replace(/^\.\//, "");
    if (p && !found.includes(p)) found.push(p);
  }
  return found;
}

/**
 * @param {object} call
 * @returns {string}
 */
function mutatedPath(call) {
  if (!MUTATING_TOOL_NAMES.has(call?.name)) return "";
  const args = call.args ?? {};
  return String(args.path ?? args.file ?? args.filename ?? "").replace(/^\.\//, "");
}

/**
 * Heuristic: mark plan steps done from tool evidence. Never invent false dones.
 * @param {PlanState} state
 * @param {{ steps?: Array<object>, contract?: { checks?: Array<{kind: string, target: string}> } }} [ctx]
 * @returns {PlanState}
 */
export function markProgress(state, { steps: runSteps } = {}) {
  if (!state?.steps?.length) return state;

  const calls = flattenToolCalls(runSteps);
  const written = new Set();
  const okCommands = [];

  for (const call of calls) {
    if (!call?.ok) continue;
    const path = mutatedPath(call);
    if (path) written.add(path.replace(/\\/g, "/"));
    if (call.name === "run_command" && commandExitCode(call.result) === 0) {
      const cmd = runCommandText(call).trim();
      if (cmd) okCommands.push(cmd);
    }
  }

  const nextSteps = state.steps.map((step) => {
    if (step.status === "done") return step;

    const paths = pathsInStepText(step.text).map((p) => p.replace(/\\/g, "/"));
    if (paths.some((p) => written.has(p) || [...written].some((w) => w.endsWith(p) || p.endsWith(w)))) {
      return { ...step, status: "done" };
    }

    const stepLower = step.text.toLowerCase();
    const mentionsCommand =
      /\brun_command\b/i.test(step.text) ||
      /\b(npm|node|pytest|python|cargo|go|dotnet|make|curl|wget)\b/i.test(step.text);
    if (mentionsCommand) {
      for (const cmd of okCommands) {
        const cmdLower = cmd.toLowerCase();
        if (stepLower.includes(cmdLower) || cmdLower.includes(stepLower.slice(0, 40))) {
          return { ...step, status: "done" };
        }
        // Token overlap: step names a binary/script that appears in the command.
        for (const p of paths) {
          if (cmdLower.includes(p.toLowerCase())) return { ...step, status: "done" };
        }
      }
    }

    return step;
  });

  return { ...state, steps: nextSteps };
}

/**
 * Format a compact checkpoint block for injection into the transcript.
 * @param {PlanState} state
 * @returns {string}
 */
export function formatCheckpoint(state) {
  if (!state?.steps?.length) return "";
  const lines = ["## Plan progress"];
  for (const step of state.steps) {
    const mark = step.status === "done" ? "x" : " ";
    lines.push(`- [${mark}] ${step.id}. ${step.text}`);
  }
  return lines.join("\n");
}

/**
 * Find the most recent plan assistant text in a transcript.
 * Prefers assistant replies that follow a plan/adjust/replan user prompt.
 * @param {Array<{role?: string, content?: unknown}>} messages
 * @returns {string}
 */
export function findLastPlanText(messages) {
  const list = messages ?? [];
  for (let i = list.length - 1; i >= 1; i--) {
    const msg = list[i];
    if (msg?.role !== "assistant") continue;
    const prev = list[i - 1];
    if (prev?.role === "user" && isPlanPrompt(textOf(prev.content))) {
      const plan = textOf(msg.content).trim();
      if (plan) return plan;
    }
  }

  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    if (msg?.role !== "assistant") continue;
    const plan = textOf(msg.content).trim();
    if (plan && parsePlanSteps(plan).length > 0) return plan;
  }

  return "";
}

/**
 * Stable key for acceptance `missing` lists (stuck-progress detection).
 * @param {string[]|undefined} missing
 * @returns {string}
 */
export function missingKey(missing) {
  return [...(missing ?? [])].map(String).sort().join("\0");
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .join("");
  }
  return content == null ? "" : String(content);
}
