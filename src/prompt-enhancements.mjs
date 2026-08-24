/**
 * Prompt enhancements for weaker models: task-type heuristics, a planning
 * pre-pass on complex goals, and Ollama native-thinking configuration.
 */

import { detectCapabilities, parseParamsBillions } from "./model-routing.mjs";

/** Minimum goal length (words) before planning is considered. */
export const COMPLEX_GOAL_MIN_WORDS = 10;

/**
 * Task-type patterns. First match wins per category; multiple categories
 * can apply. Keep constraints short — they ride in the user message.
 */
const TASK_HINT_RULES = [
  {
    id: "test-fix",
    test: /\b(failing tests?|fix.{0,40}\b(test|spec|suite)\b|(?:test|spec).{0,40}\b(fail|broken|error)\b)\b/i,
    constraint:
      "Run the relevant tests first (run_command) to see failures before editing. Re-run after each fix.",
  },
  {
    id: "debug",
    test: /\b(debug|diagnose|troubleshoot)\b|\bwhy (?:is|does|isn't|doesn't)\b|\bnot working\b|\b(?:is|are) broken\b/i,
    constraint:
      "Reproduce the issue first (read logs, run the failing command). Form a hypothesis before changing code.",
  },
  {
    id: "search",
    test: /\b(where is|find|locate|search for|look for)\b.{0,60}\b(defin(?:ed|ition)|used|implemented|exports?)\b/i,
    constraint:
      "Use grep_search or find_files to locate symbols before reading files one at a time.",
  },
  {
    id: "path-answer",
    test:
      /\b(reply with|answer with)\b.{0,40}\b(just|only)\b.{0,40}\b(number|path)\b|\bwhich file\b.{0,40}\b(path|relative)\b|\brelative to the workspace\b/i,
    constraint:
      "Reply with only the requested value (path or number) — no quotes, explanation, or extra text.",
  },
  {
    id: "test-verify",
    test:
      /\b(run|confirm).{0,50}\b(test\.mjs|tests?)\b.{0,30}\b(pass|succeed|ok)\b|\btest\.mjs\b.{0,40}\b(run|pass|confirm)\b/i,
    constraint:
      "Run the test script with run_command (e.g. node test.mjs) as your last tool step, then state the pass/fail output in your final answer.",
  },
  {
    id: "config-edit",
    test: /\b(config\.json|\.json)\b.{0,40}\b(change|edit|update|set|flip|modify)\b|\bchange\b.{0,40}\b(debug|true|false)\b/i,
    constraint:
      "read_file the config first, edit_file the exact key, then read_file again to verify before finishing.",
  },
  {
    id: "refactor",
    test: /\b(refactor|rename|extract|move|reorganiz)\w*/i,
    constraint:
      "Read every affected file first. Make one logical change at a time and verify after each.",
  },
  {
    id: "implement",
    test: /\b(implement|add|create|build|write)\b.{0,40}\b(feature|function|class|module|component|endpoint|api)\b/i,
    constraint:
      "Find similar existing code (grep_search) and match its patterns before writing new code.",
  },
  {
    id: "explain",
    test: /\b(explain|describe|how does|what does|walk me through)\b/i,
    constraint:
      "Read the relevant source files before answering. Cite specific file paths in your answer.",
  },
  {
    id: "multi-step",
    test: /\b(?:and then|after that|also|next|finally)\b/i,
    constraint: "This is a multi-step task — complete each step in order and verify before moving on.",
  },
];

/** Signals that a goal is complex enough to benefit from a planning pass. */
const COMPLEX_GOAL_PATTERNS = [
  /\b(?:and then|after that|also|next|finally)\b/i,
  /^\s*\d+[\).\]]\s/m,
  /;\s*\S/,
];

export const PLANNING_USER_MESSAGE = [
  "Before using any tools, write a short numbered plan (3–6 steps) for the task above.",
  "Name the specific tools you will use (read_file, grep_search, run_command, etc.).",
  "Do not call tools yet — reply with only the plan.",
].join(" ");

/** Tools that ground answers or change workspace state. */
export const SUBSTANTIVE_TOOL_NAMES = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "grep_search",
  "find_files",
  "run_command",
  "search_project",
]);

export const TOOL_NUDGE_NO_TOOLS = [
  "You replied without calling any tools, but this task requires tool use.",
  "Call the appropriate tools now (read_file, grep_search, write_file, edit_file, run_command, etc.)",
  "to complete the work before giving your final answer.",
].join(" ");

export const TOOL_NUDGE_EMPTY_ANSWER = [
  "Your answer was empty. Use tools to gather information or make the required changes,",
  "then reply in plain text with your final answer.",
].join(" ");

const ACTION_GOAL =
  /\b(create|write|build|fix|edit|change|update|implement|modify|extract|refactor|rename|move|persist|include)\b/i;
const RUN_TEST_GOAL = /\b(run|test)\b.{0,40}\b(node|npm|test|spec|\.mjs|\.js|\.ts)\b/i;
const ADD_FEATURE_GOAL = /\badd\b.{0,40}\b(cli|flag|route|feature|function|file|module|test|support)\b/i;
const READ_GOAL =
  /\b(read|open)\b.{0,40}\b(\.md|\.json|\.env|readme|config)\b/i;
const LOCATE_GOAL =
  /\b(which file|where is|find|locate|grep|search for|tell me|what port|what value|exports?)\b/i;

/**
 * @param {string} goal
 * @returns {boolean}
 */
export function goalNeedsSubstantiveTools(goal) {
  const text = String(goal ?? "");
  return (
    ACTION_GOAL.test(text) ||
    RUN_TEST_GOAL.test(text) ||
    ADD_FEATURE_GOAL.test(text) ||
    READ_GOAL.test(text) ||
    LOCATE_GOAL.test(text)
  );
}

/**
 * @param {string} goal
 * @returns {boolean}
 */
export function isQuestionGoal(goal) {
  const text = String(goal ?? "");
  return /\?/.test(text) || /\b(what|which|where|how many|tell me)\b/i.test(text);
}

/**
 * Simple read-a-file-and-answer goals should not get a planning pre-pass.
 * @param {string} goal
 * @returns {boolean}
 */
export function isSimpleReadAnswerGoal(goal) {
  const text = String(goal ?? "").trim();
  if (ACTION_GOAL.test(text) || RUN_TEST_GOAL.test(text) || ADD_FEATURE_GOAL.test(text)) return false;
  return (
    /\b(read|open)\b.{0,50}\b(and answer|and tell)\b/i.test(text) ||
    (/\b(reply with|answer with)\b/i.test(text) && /\b(just|only)\b/i.test(text))
  );
}

/**
 * @param {Array<{toolCalls?: Array<{name: string, ok?: boolean}>}>} steps
 * @returns {Set<string>}
 */
export function substantiveToolsUsed(steps) {
  const used = new Set();
  for (const step of steps ?? []) {
    for (const call of step.toolCalls ?? []) {
      if (call.ok && SUBSTANTIVE_TOOL_NAMES.has(call.name)) used.add(call.name);
    }
  }
  return used;
}

/**
 * @param {Array<{toolCalls?: Array<{ok?: boolean}>}>} steps
 * @returns {boolean}
 */
function anyToolCallsExecuted(steps) {
  return steps.some((step) => step.toolCalls?.some((call) => call.ok));
}

/**
 * @param {object} input
 * @param {string} input.goal
 * @param {string} input.answerText
 * @param {Array<{toolCalls?: Array<{name: string, ok?: boolean}>}>} input.steps
 * @param {number} input.nudgeCount
 * @returns {string|null} Nudge message, or null if the final answer is acceptable.
 */
export function prematureFinalNudge({ goal, answerText, steps, nudgeCount }) {
  const MAX_TOOL_NUDGES = 2;
  if (nudgeCount >= MAX_TOOL_NUDGES) return null;
  if (!goalNeedsSubstantiveTools(goal)) return null;
  if (substantiveToolsUsed(steps).size > 0) return null;

  const answer = String(answerText ?? "").trim();
  if (!answer) return TOOL_NUDGE_EMPTY_ANSWER;
  if (!anyToolCallsExecuted(steps)) return TOOL_NUDGE_NO_TOOLS;
  return null;
}

/**
 * @param {string} goal
 * @returns {Array<{id: string, constraint: string}>}
 */
export function detectTaskHints(goal) {
  const text = String(goal ?? "");
  const seen = new Set();
  const hints = [];
  for (const rule of TASK_HINT_RULES) {
    if (rule.test.test(text) && !seen.has(rule.id)) {
      seen.add(rule.id);
      hints.push({ id: rule.id, constraint: rule.constraint });
    }
  }
  return hints;
}

/**
 * @param {Array<{id: string, constraint: string}>} hints
 * @returns {string}
 */
export function formatTaskConstraints(hints) {
  if (!hints?.length) return "";
  const lines = hints.map((h) => `- ${h.constraint}`);
  return ["## Task focus", ...lines].join("\n");
}

/**
 * @param {string} goal
 * @param {object} [options]
 * @param {number} [options.minWords]
 * @returns {boolean}
 */
export function isComplexGoal(goal, { minWords = COMPLEX_GOAL_MIN_WORDS } = {}) {
  const text = String(goal ?? "").trim();
  if (!text) return false;
  if (isSimpleReadAnswerGoal(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  const hints = detectTaskHints(text);
  if (words.length >= minWords) return true;
  if (hints.length >= 2) return true;
  if (hints.length >= 1 && words.length >= 6) return true;
  return COMPLEX_GOAL_PATTERNS.some((re) => re.test(text));
}

/** GPT-OSS expects think levels, not booleans. */
export function isGptOssModel(model) {
  return /^gpt-oss/i.test(String(model ?? ""));
}

/**
 * Resolve the Ollama `think` request field.
 *
 * @param {object} options
 * @param {boolean|string} [options.think] `auto` (default), `true`/`false`,
 *   or a level (`low`, `medium`, `high`, `max`).
 * @param {boolean|null} [options.thinkingCapable] From model capabilities.
 * @param {string} [options.model]
 * @param {number} [options.paramsB] Model size in billions; smaller models get
 *   stronger thinking when `think` is `auto`.
 * @returns {boolean|string|undefined} Value for the API body, or undefined to omit.
 */
export function resolveThinkSetting({
  think = "auto",
  thinkingCapable,
  model,
  paramsB = 0,
} = {}) {
  if (think === false || think === "false" || think === "off") return undefined;

  const explicitLevel =
    typeof think === "string" && ["low", "medium", "high", "max"].includes(think);
  if (explicitLevel) return think;

  if (thinkingCapable !== true) return undefined;

  const small = paramsB > 0 && paramsB < 14;

  if (think === true || think === "true" || think === "on") {
    return isGptOssModel(model) ? (small ? "high" : "medium") : true;
  }

  // auto — bias harder reasoning for smaller models
  if (isGptOssModel(model)) return small ? "high" : "medium";
  if (small) return true;
  return true;
}

/**
 * Set model metadata on an OllamaClient for think auto-resolution.
 *
 * @param {import("./ollama-client.mjs").OllamaClient} client
 * @param {string} model
 * @param {object} [options]
 * @param {{parameterSize?: string, sizeBytes?: number}} [options.listEntry]
 */
export async function configureClientModel(client, model, { listEntry } = {}) {
  client.model = model;
  const { thinking } = await detectCapabilities(client, model);
  client.thinkingCapable = thinking === true;

  if (listEntry) {
    client.paramsB = parseParamsBillions(listEntry.parameterSize ?? "", listEntry.sizeBytes ?? 0);
    return;
  }
  if (typeof client.listModelsDetailed === "function") {
    try {
      const models = await client.listModelsDetailed();
      const entry = models.find((m) => m.name === model);
      if (entry) {
        client.paramsB = parseParamsBillions(entry.parameterSize ?? "", entry.sizeBytes ?? 0);
      }
    } catch {
      client.paramsB = 0;
    }
  }
}
