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
    test: /\b(failing tests?|tests?\s+fail|\bit fails?\b|fix.{0,60}\btests?\b|(?:test|spec|suite).{0,40}\b(fail|fails|broken|error)\b)\b/i,
    constraint:
      "Mandatory first step: run_command the failing test (e.g. node test.mjs) and record exit code/output before any edit_file or write_file. After the last fix, run the same command again. Checklist: reproduce → diagnose → fix → verify.",
  },
  {
    id: "debug",
    test: /\b(debug|diagnose|troubleshoot)\b|\bwhy (?:is|does|isn't|doesn't)\b|\bnot working\b|\b(?:is|are) broken\b/i,
    constraint:
      "Reproduce the issue first (read logs, run the failing command). Form a hypothesis before changing code.",
  },
  {
    id: "rename-typo",
    test: /\b(misspell|typo|renam\w*|fix the (?:typo|spelling)|handeler|identifier)\b/i,
    constraint:
      "Scan the file for every declaration, export, and reference of the misspelled identifier. Update them all in one edit_file with replace_all: true before running tests.",
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
      "Run the test script with run_command (e.g. node test.mjs) as your last tool step, then state the pass/fail output in your final answer. Do not claim success if the exit code is non-zero.",
  },
  {
    id: "cli-module",
    test:
      /\b(create|write|implement)\b.{0,80}\b(\.mjs|cli)\b|\bnode\s+[\w./-]+\.mjs\b.{0,40}\b(--|\bprints?\b)/i,
    constraint:
      ".mjs is ESM (import/export only). If the script exports helpers and also runs as a CLI, guard entry-point code with import.meta.url === pathToFileURL(process.argv[1]).href so tests can import safely — or prefer spawning the CLI in tests instead of importing it.",
  },
  {
    id: "http-server",
    test: /\b(http|server\.mjs|listens?\s+on\s+port|PORT\s+env)\b|\/health|\/echo/i,
    constraint:
      "The server entry must call listen when run as node server.mjs (import.meta.url main check) in addition to being importable for tests. After documenting a run command in README.md, run that exact command once to confirm observable behavior.",
  },
  {
    id: "extract-shared",
    test: /\b(extract|shared|refactor).{0,60}\b(module|util|slugify|common)\b|\binto\s+(?:a\s+)?shared\b/i,
    constraint:
      "Write the shared module file first, then update importers to use it, then run tests — avoid a broken import window.",
  },
  {
    id: "fixture-first",
    test: /\b(sample\.txt|fixture|\.csv|\.log|data\/[\w./-]+)\b.{0,80}\b(create|write|implement|count|summar)/i,
    constraint:
      "Read the named sample/fixture file before writing the implementation so formats and edge cases match reality.",
  },
  {
    id: "error-handling",
    test: /\b(error handling|graceful|missing (?:file|subcommand)|unknown (?:command|subcommand)|exit(?:s)? non-zero)\b/i,
    constraint:
      "Include at least one negative-path check (missing args/file or unknown subcommand) via a test assertion or a one-off run_command before finishing.",
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
      "Read every affected file first. Make one logical change at a time and verify after each. For renames, update all sites before the verify run.",
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
  "For fix/debug tasks use: reproduce (run failing command) → diagnose → fix all related sites in one change → verify.",
  "For create/CLI/server tasks include a final verify step that runs every named command and the tests; do not plan to claim success without that run.",
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

export const MUTATING_TOOL_NAMES = new Set(["write_file", "edit_file"]);

export const TOOL_NUDGE_NO_TOOLS = [
  "You replied without calling any tools, but this task requires tool use.",
  "Call the appropriate tools now (read_file, grep_search, write_file, edit_file, run_command, etc.)",
  "to complete the work before giving your final answer.",
].join(" ");

export const TOOL_NUDGE_EMPTY_ANSWER = [
  "Your answer was empty. Use tools to gather information or make the required changes,",
  "then reply in plain text with your final answer.",
].join(" ");

export const TOOL_NUDGE_VERIFY = [
  "Do not finish yet — run the verification command(s) the task requires with run_command",
  "(e.g. node test.mjs and any named CLI invocation) and only claim success if the exit code is 0.",
].join(" ");

export const TOOL_NUDGE_PRETEST = [
  "This task requires reproducing failing tests before edits.",
  "Call run_command with the test command first, then fix, then re-run.",
].join(" ");

export const MUTATION_BLOCKED_PRETEST =
  "Blocked: this task mentions failing tests. Run the test command with run_command and inspect the failure before edit_file or write_file.";

const ACTION_GOAL =
  /\b(create|write|build|fix|edit|change|update|implement|modify|extract|refactor|rename|move|persist|include)\b/i;
const RUN_TEST_GOAL = /\b(run|test)\b.{0,40}\b(node|npm|test|spec|\.mjs|\.js|\.ts)\b/i;
const ADD_FEATURE_GOAL = /\badd\b.{0,40}\b(cli|flag|route|feature|function|file|module|test|support)\b/i;
const READ_GOAL =
  /\b(read|open)\b.{0,40}\b(\.md|\.json|\.env|readme|config)\b/i;
const LOCATE_GOAL =
  /\b(which file|where is|find|locate|grep|search for|tell me|what port|what value|exports?)\b/i;
const SUCCESS_CLAIM =
  /\b(pass(?:es|ed)?|success|all tests? (?:pass|ok)|works|done|completed|fixed)\b/i;

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
 * Flatten tool calls from steps in order.
 * @param {Array<{toolCalls?: Array<object>}>} steps
 * @returns {Array<object>}
 */
export function flattenToolCalls(steps) {
  const out = [];
  for (const step of steps ?? []) {
    for (const call of step.toolCalls ?? []) out.push(call);
  }
  return out;
}

/**
 * @param {object} call
 * @returns {string}
 */
function runCommandText(call) {
  if (call?.name !== "run_command") return "";
  const args = call.args ?? {};
  return String(args.command ?? args.cmd ?? "");
}

/**
 * @param {Array<object>} calls
 * @returns {boolean}
 */
export function hasRunCommand(calls) {
  return calls.some((c) => c.name === "run_command" && c.ok !== false);
}

/**
 * @param {Array<object>} calls
 * @returns {boolean}
 */
export function hasSuccessfulTestRun(calls) {
  return calls.some((c) => {
    if (c.name !== "run_command" || !c.ok) return false;
    const cmd = runCommandText(c);
    if (!/\b(test\.mjs|npm\s+test|node\s+--test)\b/i.test(cmd) && !/\btest\b/i.test(cmd)) {
      return false;
    }
    const result = c.result;
    if (result && typeof result === "object" && "exitCode" in result) {
      return Number(result.exitCode) === 0;
    }
    // String results from older/shell formatting — treat ok tool call as success.
    return true;
  });
}

/**
 * Whether mutating tools were used before any run_command (test-fix violation).
 * @param {Array<object>} calls
 * @returns {boolean}
 */
export function mutatedBeforeTestRun(calls) {
  let sawRun = false;
  for (const call of calls) {
    if (call.name === "run_command") {
      sawRun = true;
      continue;
    }
    if (MUTATING_TOOL_NAMES.has(call.name) && call.ok && !sawRun) return true;
  }
  return false;
}

/**
 * Extract likely verify commands mentioned in the goal (node …).
 * @param {string} goal
 * @returns {string[]}
 */
export function extractNamedNodeCommands(goal) {
  const text = String(goal ?? "");
  const found = [];
  const re = /\bnode\s+[\w./-]+(?:\s+[\w./=-]+)*/gi;
  let m;
  while ((m = re.exec(text))) {
    const cmd = m[0].replace(/\s+/g, " ").trim();
    if (!found.includes(cmd)) found.push(cmd);
  }
  return found;
}

/**
 * @param {string} goal
 * @returns {boolean}
 */
export function goalRequiresTestVerify(goal) {
  const hints = detectTaskHints(goal);
  if (hints.some((h) => h.id === "test-fix" || h.id === "test-verify")) return true;
  return /\brun\b.{0,40}\b(test\.mjs|tests?)\b/i.test(String(goal ?? ""));
}

/**
 * Soft-block mutating tools until a pre-fix test run for test-fix goals.
 * @param {object} input
 * @param {string} input.goal
 * @param {string} input.toolName
 * @param {Array<{toolCalls?: Array<object>}>} input.steps
 * @returns {string|null} Error message to return instead of executing, or null.
 */
export function mutationBlockedUntilPretest({ goal, toolName, steps }) {
  if (!MUTATING_TOOL_NAMES.has(toolName)) return null;
  const hints = detectTaskHints(goal);
  if (!hints.some((h) => h.id === "test-fix")) return null;
  const calls = flattenToolCalls(steps);
  if (hasRunCommand(calls)) return null;
  return MUTATION_BLOCKED_PRETEST;
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
 * Rubric-aware self-check before completion: missing pretest / verify runs.
 * @param {object} input
 * @param {string} input.goal
 * @param {string} input.answerText
 * @param {Array<{toolCalls?: Array<object>}>} input.steps
 * @param {number} input.nudgeCount
 * @returns {string|null}
 */
export function completionVerifyNudge({ goal, answerText, steps, nudgeCount }) {
  const MAX_TOOL_NUDGES = 2;
  if (nudgeCount >= MAX_TOOL_NUDGES) return null;

  const calls = flattenToolCalls(steps);
  const hints = detectTaskHints(goal);
  const answer = String(answerText ?? "");
  const claimsSuccess = SUCCESS_CLAIM.test(answer);

  if (hints.some((h) => h.id === "test-fix")) {
    if (!hasRunCommand(calls)) return TOOL_NUDGE_PRETEST;
    if (mutatedBeforeTestRun(calls) && !hasSuccessfulTestRun(calls)) {
      return TOOL_NUDGE_PRETEST;
    }
    // Edits happened — require a post-fix verify run (any successful test run after last mutate).
    const lastMutateIdx = (() => {
      let idx = -1;
      for (let i = 0; i < calls.length; i++) {
        if (MUTATING_TOOL_NAMES.has(calls[i].name) && calls[i].ok) idx = i;
      }
      return idx;
    })();
    if (lastMutateIdx >= 0) {
      const after = calls.slice(lastMutateIdx + 1);
      if (!hasSuccessfulTestRun(after)) return TOOL_NUDGE_VERIFY;
    }
  }

  if (goalRequiresTestVerify(goal)) {
    if (!hasSuccessfulTestRun(calls)) {
      if (claimsSuccess || substantiveToolsUsed(steps).size > 0) return TOOL_NUDGE_VERIFY;
    }
  }

  // Named node commands in the goal should appear in a successful run_command.
  const named = extractNamedNodeCommands(goal).filter((c) => !/\btest\.mjs\b/i.test(c));
  if (named.length > 0 && claimsSuccess) {
    const missing = named.filter((cmd) => {
      const needle = cmd.toLowerCase();
      return !calls.some((c) => {
        if (c.name !== "run_command" || !c.ok) return false;
        return runCommandText(c).toLowerCase().includes(needle.replace(/^node\s+/, ""));
      });
    });
    // Only nudge when a non-test CLI was named and never run (e.g. filter.mjs --active).
    if (missing.length > 0 && hints.some((h) => h.id === "cli-module" || h.id === "http-server")) {
      return [
        `Do not finish yet — run these named commands with run_command and confirm exit 0: ${missing.join("; ")}.`,
      ].join(" ");
    }
  }

  return null;
}

/**
 * Combined nudge used by the agent loop when the model tries to finish.
 * @param {object} input
 * @returns {string|null}
 */
export function finalAnswerNudge(input) {
  return prematureFinalNudge(input) ?? completionVerifyNudge(input);
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
