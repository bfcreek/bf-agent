/**
 * Prompt enhancements for weaker models: task-type heuristics, a planning
 * pre-pass on first turns, and Ollama native-thinking configuration.
 */

import { detectCapabilities, parseParamsBillions } from "./model-routing.mjs";

export const COMPLEX_GOAL_MIN_WORDS = 10;

/**
 * Empty-workspace / app-skeleton goals. Distinct from "write a shell script":
 * "the shell of an Electron app" means the project skeleton.
 * @param {string} goal
 * @returns {boolean}
 */
export function isGreenfieldScaffoldGoal(goal) {
  const text = String(goal ?? "");
  if (/\b(?:bash|powershell)\s+scripts?\b|\bshell\s+scripts?\b/i.test(text)) {
    if (!/\b(?:empty workspace|workspace is empty|from scratch|scaffold|electron\s+app)\b/i.test(text)) {
      return false;
    }
  }
  return (
    /\b(?:empty workspace|workspace is empty|from scratch|scaffold)\b/i.test(text) ||
    /\b(?:create|build|make)\b.{0,100}\b(?:the\s+)?shell\s+(?:of|for)\b/i.test(text) ||
    /\b(?:app|application|project|electron)\s+shell\b/i.test(text) ||
    /\b(?:create|build|make)\b.{0,80}\belectron\b/i.test(text)
  );
}

/**
 * Task-type patterns. First match wins per category; multiple categories
 * can apply. Keep constraints short — they ride in the user message.
 */
const TASK_HINT_RULES = [
  {
    id: "test-fix",
    test: /\b(failing tests?|tests?\s+fail|\bit fails?\b|fix.{0,60}\btests?\b|(?:test|spec|suite).{0,40}\b(fail|fails|broken|error)\b)\b/i,
    constraint:
      "Mandatory first step: run_command the failing test (e.g. node test.mjs, python test.py, or dotnet run) and record exit code/output before any edit_file or write_file. If that run already exits 0, read the named implementation file, confirm it matches the tests, and finish — do not add validation, docstrings, or extra features. If it fails, fix only the broken logic, then re-run the same command. Checklist: reproduce → diagnose → fix → verify. Do not rewrite the test file. After the failing run, edit_file the named implementation immediately (often inverted operators or swapped return values), then re-run the same test command. If edit_file says old_string is ambiguous, include the enclosing def/class (e.g. def mul(a, b): plus the return line) and never set replace_all on a return/statement. If a Python test imports a function whose module has the same name (greet.py / greet()), use `from greet import greet` — `import greet` then greet() calls the module.",
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
    test: /\b(where is|find|locate|search for|look for|which file)\b.{0,80}\b(defin(?:ed|ition|es)|used|implemented|exports?)\b/i,
    constraint:
      "Use grep_search (or find_files) to locate symbols — do not list_dir to hunt for a definition. Prefer the file that defines the symbol, not an import/call site. After the search hit, reply with the relative path if that is all the user asked for — do not stop on an empty message.",
  },
  {
    id: "path-answer",
    test:
      /\b(reply with|answer with)\b.{0,40}\b(just|only)\b.{0,40}\b(number|path)\b|\bwhich file\b.{0,80}\b(defin|path|relative)\b|\brelative to the workspace\b/i,
    constraint:
      "You must emit a non-empty final answer. Reply with only the requested value (workspace-relative path or number) — no quotes, explanation, or extra text. For path questions, give the file that DEFINES the symbol (e.g. lib/tax.py), not an import site. After tools return, state that value immediately.",
  },
  {
    id: "test-verify",
    test:
      /\b(run|confirm).{0,50}\b(test\.mjs|test\.py|tests?|dotnet\s+run)\b.{0,40}\b(pass|succeed|ok)\b|\b(test\.mjs|test\.py|dotnet\s+run)\b.{0,40}\b(run|pass|confirm)\b/i,
    constraint:
      "Run the test/verify command with run_command (e.g. node test.mjs, python test.py, or dotnet run) as your last tool step, then state the pass/fail output in your final answer. Do not claim success if the exit code is non-zero, or if a CLI that should print records exited 0 with empty stdout or []. Once it passes (exit 0 with the expected output), finish immediately — no further exploratory commands.",
  },
  {
    id: "cli-module",
    test:
      /\b(create|write|implement)\b.{0,80}\b(\.mjs|cli)\b|\bnode\s+[\w./-]+\.mjs\b.{0,40}\b(--|\bprints?\b)/i,
    constraint:
      ".mjs is ESM (import/export only). If the script exports helpers and also runs as a CLI, guard entry-point code with import.meta.url === pathToFileURL(process.argv[1]).href so tests can import safely — never new URL(process.argv[1]) or URL.pathname (wrong on Windows). Prefer tests that spawn the CLI with fileURLToPath(new URL('./cli.mjs', import.meta.url)), never pathToFileURL(...).pathname. Validate required args and wrap file I/O in try/catch with a user-facing error and non-zero exit. Write the implementation before running tests.",
  },
  {
    id: "csharp-json",
    test:
      /\bdotnet\b[\s\S]{0,400}\bJSON array\b|\bJSON array\b[\s\S]{0,400}\bdotnet\b|\bJsonSerializer\b|\bJsonNamingPolicy\b/i,
    constraint:
      "Read the input JSON file before writing C# models. Deserialize with JsonSerializerOptions { PropertyNameCaseInsensitive = true } (JSON keys are camelCase; C# properties are PascalCase). Serialize with PropertyNamingPolicy = JsonNamingPolicy.CamelCase. After dotnet run, read stdout: exit 0 with [] or empty output is a failure if records were expected. For new console apps, use a Program class with static void Main(string[] args) instead of mixing top-level statements with type declarations (CS8803). If you keep top-level statements, they must come before any type or namespace, and never declare a local `args` (CS0136 shadows implicit Main args — use `cliArgs`). Never use `out` variables inside `||`/`&&` (CS0165) — assign TryParse to a bool, then test it.",
  },
  {
    id: "python-import",
    test:
      /\b(greet|slugify|filter)\.py\b|[\s\S]{0,80}\bfrom\s+\w+\s+import\s+\w+|\bpython3?\s+test\.py\b/i,
    constraint:
      "If Foo.py defines foo(), tests and callers must `from foo import foo` (or `import foo as foo_mod`). `import foo` then foo() calls the module and raises TypeError. Do not add optional CLI modes the goal did not name. Omit unused imports. For JSON flags, test the boolean strictly (`active is True` / `=== true`), not truthiness.",
  },
  {
    id: "python-json",
    test:
      /\bpython3?\s+[\w./-]+\.py\b[\s\S]{0,200}--|\bpython3?\b[\s\S]{0,300}\bJSON array\b/i,
    constraint:
      "Read the JSON fixture before writing code. Implement only flags the goal names — do not add extra modes or a no-flag dump path unless asked. Filter flag fields with a strict boolean check (`active is True`), not truthiness. Omit unused imports. If the module is also imported, guard CLI with if __name__ == '__main__'. After python test.py passes, run the named python ... --flag command once; exit 0 with [] or empty stdout is a failure. Then finish — do not re-run extra CLI probes.",
  },
  {
    id: "csharp-cli",
    test:
      /\bcatalog\.json\b[\s\S]{0,1200}\bdotnet\s+run|\bdotnet\s+run\s+--[\s\S]{0,800}\b(list|find|low\s+--threshold|category)\b/i,
    constraint:
      "After implementing the CLI, smoke-test each named subcommand with run_command (list, find, total, low, category, and one unknown command) — do not stop after only `dotnet build` or `dotnet run -- list`. Unknown commands should exit non-zero. Deserialize JSON with PropertyNameCaseInsensitive = true. Exit 0 with qty=0 / missing SKUs is a failure — fix binding and re-run. `low --threshold n` is inclusive (qty <= n, not < n); smoke-test a threshold equal to an item's qty and confirm that SKU is printed. Prefer `static void Main(string[] args)` over top-level statements; never declare a local `args` (CS0136). Split `int.TryParse(...)` out of `||`/`&&` into its own statement (CS0165). After the first compile error, apply the canonical fix for that CS code once — do not loop on cosmetic renames; cap retries at 2 per distinct error code.",
  },
  {
    id: "csharp-tests",
    test: /\bdotnet\s+test\b|\b(xunit|nunit|mstest)\b|\bseparate test project\b/i,
    constraint:
      "Create a real test project (dotnet new xunit or equivalent), not asserts in Program.cs. After the app compiles, run `dotnet test` from the workspace root and only claim success if it exits 0. If the CLI is not the only project, invoke it with `dotnet run --project <csproj> -- <args>`. Persist CLI state to the named file so later commands see earlier adds. Locate the workspace via `.sln`, `.slnx`, or the known csproj — `dotnet new sln` may write `.slnx`, so do not hardcode a single solution filename. In C#, do not name a method the same as its class (CS0542). Validation tests must call shared app validation or spawn the CLI — do not duplicate CLI rules in a local test helper.",
  },
  {
    id: "follow-up",
    test:
      /\bthis is a new request\b|\balready contains a working\b|\bdo not rewrite(?: the project)? from scratch\b/i,
    constraint:
      "This is mandatory new work on an existing project. Read the current source, implement every newly named command with edit_file (prefer patch over rewrite), then smoke-test original plus new commands. Passing `dotnet build` or existing commands is not completion. Do not stop with 'no files were edited'. Before changing test assertions, trace state against the spec — if the implementation already matches, keep it and fix the test.",
  },
  {
    id: "greenfield-scaffold",
    test: isGreenfieldScaffoldGoal,
    constraint:
      "This is a from-scratch project. Create the real app files yourself with write_file (manifest + entry/source files, e.g. package.json, main process, renderer HTML) and run installs/builds with run_command. Do not write a setup/install script as a substitute — you must perform each step. 'Shell of an app' means the skeleton, not a shell script. For npm/yarn/pnpm install of large packages (electron), omit timeout_seconds or set it to at least 180.",
  },
  {
    id: "shell-script",
    test:
      /\b(bash|shell|powershell)\s+scripts?\b|\bscripts?\.(sh|ps1|bash)\b|\b(create|write|make)\b.{0,50}\b(a\s+)?scripts?\b(?!\s*\.(mjs|js|ts|py|cs))/i,
    constraint:
      "On Windows, new shell scripts must be PowerShell (.ps1), not bash/.sh, unless the user asked for bash. Run them with run_command using PowerShell syntax (chain with ';'). On POSIX, write .sh and use POSIX sh syntax. If the user asked for an app/project shell (skeleton), that is not a shell script — write the app files instead.",
  },
  {
    id: "smoke-cli",
    test: /\bsmoke-test\b/i,
    constraint:
      "Before finishing, run each named smoke-test command with run_command. On Windows PowerShell chain with ';' not '&&'. After a command exits 0, do not re-run that same command; `dotnet build` is separate from `dotnet run` smoke tests. Treat verificationComplete:true as terminal success and give the final answer.",
  },
  {
    id: "http-server",
    test: /\b(http|server\.mjs|listens?\s+on\s+port|PORT\s+env)\b|\/health|\/echo/i,
    constraint:
      "If tests import an exported handler and create their own server, add only the requested route — do not add import.meta.url listen/bootstrap or formatting-only edits. If the task says the file listens when run as node server.mjs, include that main check. After documenting a run command in README.md, run that exact command once. Do not start a long-running server in the foreground after tests already passed. For outbound HTTP in tests, use `import { request } from 'node:http'` (or fetch against a listening server) — `createServer()` returns a server, not a request factory.",
  },
  {
    id: "extract-shared",
    test: /\b(extract|shared|refactor).{0,60}\b(module|util|slugify|common)\b|\binto\s+(?:a\s+)?shared\b/i,
    constraint:
      "Write the shared module file first, then update importers to use it, then run tests — avoid a broken import window. In C#, do not name a method the same as its enclosing class (CS0542); keep the class/file name (e.g. Slugify) and rename the method (e.g. ToSlug). JSON printed from C# CLIs should use camelCase (JsonNamingPolicy.CamelCase) and deserialize with PropertyNameCaseInsensitive = true.",
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
      "Include at least one negative-path check (missing args/file or unknown subcommand) via a test assertion or a one-off run_command before finishing. Validate required args; wrap file I/O in try/catch with a user-facing error and non-zero exit rather than letting the process throw.",
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
      "If the workspace already has similar code, grep_search and match its patterns before writing new code. If it is empty, write the new files with write_file — do not search first and do not write a setup script instead.",
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

export const PLANNING_USER_MESSAGE = [
  "Before using any tools, write a short numbered plan (3–6 steps) for the task above.",
  "Name the specific tools you will use (read_file, grep_search, run_command, etc.).",
  "If the task needs no tools, the plan is one line: 'No tools — answer directly.'",
  "Before the first edit, plan to read the target file and any existing tests that define the expected interface (flag names, signatures, output format).",
  "For fix/debug tasks use: reproduce (run failing command) → diagnose → fix all related sites in one change → verify.",
  "If a replace_all or an ambiguous edit would touch more than one function, re-read the file and plan one unique per-function edit — do not ping-pong a shared statement.",
  "For create/CLI/server tasks include a final verify step that runs every named command and the tests; do not plan to claim success without that run. Chain smoke commands in one run_command when the task lists several.",
  "For follow-up / 'new request' tasks, map each new command to a planned file edit before any verify run — existing build/list success is not done.",
  "Implement only what the task asks: no extra entrypoints, listeners, or formatting-only edits. Name deliverable files before the first write_file.",
  "For empty-workspace / 'app shell' tasks, plan write_file of the real source files then run_command the install — never a setup/install script as the deliverable.",
  "End the plan at that verify step — once every named check passes, give the final answer with no extra exploratory commands.",
  "After tool results return, synthesize findings into a non-empty final answer — never end on an empty message. For path questions, reply with only the defining file's relative path.",
  "If a compile fails, classify the CS error (CS0136 args shadowing vs CS0165 definite assignment vs CS0542) and apply the canonical fix once; cap retries at 2 per distinct error code.",
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

export const TOOL_NUDGE_EMPTY_AFTER_TOOLS = [
  "Your answer was empty. The user needs a non-empty final reply.",
  "Synthesize what you learned from the tool results into a plain-text answer now.",
  "Do not call more tools unless a required verification command has not yet succeeded.",
].join(" ");

export const TOOL_NUDGE_EMPTY_VALUE = [
  "Your answer was empty. Reply now with only the requested value",
  "(workspace-relative path or number) — no quotes, explanation, or extra text.",
  "For path questions, give the file that DEFINES the symbol, not an import site.",
  "Do not call more tools.",
].join(" ");

export const TOOL_NUDGE_NEAR_LIMIT = [
  "You are on your last tool step.",
  "If you already diagnosed a compile or test failure, apply that exact fix now.",
  "Then give a non-empty final answer. Do not explore or re-run passing commands.",
].join(" ");

export const TOOL_NUDGE_VERIFY = [
  "Do not finish yet — run the verification command(s) the task requires with run_command",
  "(e.g. node test.mjs, python test.py, or dotnet run, plus any named CLI invocation) and only claim success if the exit code is 0.",
].join(" ");

export const TOOL_NUDGE_PRETEST = [
  "This task requires reproducing failing tests before edits.",
  "Call run_command with the test command first, then fix, then re-run.",
].join(" ");

export const TOOL_NUDGE_ALREADY_VERIFIED = [
  "Verification already succeeded (exit 0).",
  "verificationComplete: true",
  "Stop calling tools and give your final answer now.",
  "Do not re-run the same command, and do not run diagnostic commands like node -v.",
  "In the final answer, mention only files you changed and the command that exited 0 — never mention blocked diagnostics.",
].join(" ");

export const TOOL_NUDGE_FOLLOW_UP = [
  "This is a new request on an existing project.",
  "Do not stop because build or existing commands still pass.",
  "Edit the existing source to implement every newly named command,",
  "then smoke-test original plus new commands.",
].join(" ");

export const TOOL_NUDGE_SCAFFOLD = [
  "Do not finish yet. A setup/install script is not the project.",
  "write_file the actual app files (package.json, main process, HTML/renderer, or the named sources),",
  "then run_command the install yourself. 'App shell' means the skeleton, not a shell script.",
].join(" ");

export const TOOL_NUDGE_FIX_IMPL = [
  "Tests failed as the task predicted.",
  "Read the implementation file, fix only the broken logic with edit_file or write_file",
  "(no extra validation, docstrings, or features), then re-run the tests.",
].join(" ");

export const TOOL_NUDGE_READ_IMPL = [
  "The first test run already exited 0.",
  "Read the named implementation file (not only the tests) and compare it to the assertions.",
  "If it is already correct, stop and say so. Do not add validation, docstrings, or extra features.",
].join(" ");

export const TOOL_NUDGE_AMBIGUOUS_EDIT = [
  "That edit_file was ambiguous or changed more than one function.",
  "read_file the current file now, then plan one unique edit per function",
  "using enclosing def/class context (for example old_string: def mul(a, b):\\n    return a + b).",
  "Omit replace_all unless you are renaming a single identifier everywhere.",
  "Do not flip the same global snippet back and forth.",
].join(" ");

/**
 * After an ambiguous edit_file (or a non-identifier replace_all that hit
 * multiple sites), force a re-read and per-function plan so the model
 * does not ping-pong global replacements.
 * @param {{ steps?: Array<{ toolCalls?: Array<object> }> }} input
 * @returns {string|null}
 */
export function ambiguousEditRecoveryNudge({ steps } = {}) {
  const last = steps?.[steps.length - 1];
  const calls = last?.toolCalls ?? [];
  const failedAmbiguous = calls.some((c) => {
    if (c.name !== "edit_file" || c.ok) return false;
    return /appears \d+ times|replace_all is for identifier|enclosing function/i.test(
      String(c.error ?? ""),
    );
  });
  if (failedAmbiguous) return TOOL_NUDGE_AMBIGUOUS_EDIT;

  const multiReplace = calls.some((c) => {
    if (c.name !== "edit_file" || !c.ok) return false;
    const n = Number(c.result?.replacements ?? 0);
    const old = String(c.args?.old_string ?? "").trim();
    if (/^[\w.]+$/.test(old)) return false;
    return n > 1;
  });
  return multiReplace ? TOOL_NUDGE_AMBIGUOUS_EDIT : null;
}

export const MUTATION_BLOCKED_PRETEST =
  "Blocked: this task mentions failing tests. Run the test command with run_command and inspect the failure before edit_file or write_file.";

const ACTION_GOAL =
  /\b(create|write|build|fix|edit|change|update|implement|modify|extract|refactor|rename|move|persist|include)\b/i;
const RUN_TEST_GOAL = /\b(run|test)\b.{0,40}\b(node|npm|python|py|dotnet|test|spec|\.mjs|\.js|\.ts|\.py|\.cs)\b/i;
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
 * Read an exit code from a run_command result. Accepts both `exitCode` and
 * `exitCode`, plus a leading `status` of success/FAILED.
 * @param {unknown} result
 * @returns {number|null}
 */
export function commandExitCode(result) {
  if (result == null) return null;
  if (typeof result === "object") {
    const raw = result.exitCode ?? result.exitCode;
    if (raw != null && raw !== "") return Number(raw);
    const status = String(result.status ?? "");
    if (/^success$/i.test(status)) return 0;
    if (/FAILED|TIMED OUT/i.test(status)) return 1;
  }
  if (typeof result === "string") {
    const exitMatch = result.match(/exit(?:Code| code)\s*[:=]?\s*(-?\d+)/i);
    if (exitMatch) return Number(exitMatch[1]);
    if (/TIMED OUT|FAILED/i.test(result)) return 1;
    if (/^status:\s*success\b/im.test(result)) return 0;
  }
  return null;
}

/**
 * Test-suite runners. `dotnet run` is a CLI smoke, not a test suite.
 * @param {string} cmd
 * @returns {boolean}
 */
export function isTestSuiteCommand(cmd) {
  return /\b(test\.mjs|test\.py|npm\s+test|node\s+--test|dotnet\s+test|pytest)\b/i.test(
    String(cmd ?? ""),
  );
}

/**
 * @param {string} cmd
 * @returns {boolean}
 */
export function isTestCommand(cmd) {
  const text = String(cmd ?? "");
  if (isTestSuiteCommand(text)) return true;
  return /\bdotnet\s+run\b/i.test(text) || /\btest\b/i.test(text);
}

/**
 * Structured tool result so a blocked duplicate looks like terminal success,
 * not a retriable error.
 * @param {string} [message]
 */
export function verificationCompleteOutcome(message = TOOL_NUDGE_ALREADY_VERIFIED) {
  return {
    ok: true,
    result: {
      status: "verification already succeeded",
      exitCode: 0,
      verificationComplete: true,
      stdout: "",
      stderr: "",
      note: message,
    },
  };
}

export function isTerminalVerificationMessage(message) {
  const text = String(message ?? "");
  return text === TOOL_NUDGE_ALREADY_VERIFIED || /verificationComplete:\s*true/i.test(text);
}

/**
 * Bare interpreter / version probes that burn a step after tests already passed.
 * @param {string} cmd
 * @returns {boolean}
 */
export function isDiagnosticCommand(cmd) {
  return /^(node|nodejs|python3?|py)(\s+(-v|--version|-V))?$/i.test(String(cmd ?? "").trim());
}

/**
 * @param {object} call
 * @returns {boolean}
 */
export function isSuccessfulTestCall(call) {
  if (call?.name !== "run_command" || !call.ok) return false;
  if (call.result?.verificationComplete) return false;
  if (!isTestCommand(runCommandText(call))) return false;
  if (commandExitCode(call.result) !== 0) return false;
  const stdout = commandStdout(call.result).trim();
  if (looksVacuousCliStdout(stdout, runCommandText(call))) return false;
  return true;
}

/**
 * Exit 0 with no useful payload: empty, [], or qty=0 rows and no SKUs.
 * @param {string} stdout
 * @param {string} [command]
 * @param {string} [goal]
 */
export function looksVacuousCliStdout(stdout, command = "", goal = "") {
  const out = String(stdout ?? "").trim();
  if (out === "[]") return true;
  const cmd = String(command ?? "");
  const g = String(goal ?? "");
  const isCli =
    /\bdotnet\s+run\b/i.test(cmd) ||
    (/\bpython3?\s+\S+\.py\b/i.test(cmd) && !/\btest\.py\b/i.test(cmd)) ||
    /\b(sku|catalog|qty)\b/i.test(g);
  if (!isCli) return false;
  if (!out) return true;
  if (/qty\s*=\s*0/i.test(out)) {
    const stripped = out.replace(/\b(qty|total|price|name|sku)\b/gi, "");
    if (!/[A-Z]{2,}[-_]?\d|[A-Za-z]{3,}/.test(stripped)) return true;
  }
  return false;
}

function commandStdout(result) {
  if (result && typeof result === "object") return String(result.stdout ?? "");
  if (typeof result === "string") {
    const match = result.match(/^stdout:\n([\s\S]*)/m);
    return match ? match[1] : "";
  }
  return "";
}

/**
 * @param {Array<object>} calls
 * @returns {boolean}
 */
export function hasSuccessfulTestRun(calls) {
  return calls.some(isSuccessfulTestCall);
}

function hasSuccessfulMutation(calls) {
  return calls.some((c) => MUTATING_TOOL_NAMES.has(c.name) && c.ok);
}

/**
 * @param {Array<object>} calls
 * @returns {boolean}
 */
function hasFailedTestRun(calls) {
  return calls.some((c) => {
    if (c?.name !== "run_command" || !c.ok) return false;
    if (!isTestCommand(runCommandText(c))) return false;
    const code = commandExitCode(c.result);
    return code != null && code !== 0;
  });
}

/**
 * A successful read of a non-test, non-doc file (the implementation).
 * @param {Array<object>} calls
 * @returns {boolean}
 */
function hasReadImplementationFile(calls) {
  return calls.some((c) => {
    if (c?.name !== "read_file" || !c.ok) return false;
    const p = String(c.args?.path ?? c.args?.file ?? "");
    if (!p) return false;
    const base = p.replace(/\\/g, "/").split("/").pop() ?? "";
    return !/^test\.(mjs|py|cs)$/i.test(base) && !/\.(md|txt)$/i.test(base);
  });
}

function lastMutationIndex(calls) {
  let idx = -1;
  for (let i = 0; i < (calls ?? []).length; i++) {
    if (MUTATING_TOOL_NAMES.has(calls[i].name) && calls[i].ok) idx = i;
  }
  return idx;
}

function normalizeCommand(cmd) {
  return String(cmd ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isActualRun(call) {
  return call?.name === "run_command" && call.ok && !call.result?.verificationComplete;
}

function commandAlreadySucceeded(calls, cmd) {
  const needle = normalizeCommand(cmd);
  if (!needle) return false;
  return (calls ?? []).some((c) => {
    if (!isActualRun(c)) return false;
    if (commandExitCode(c.result) !== 0) return false;
    return normalizeCommand(runCommandText(c)) === needle;
  });
}

const SMOKE_SKIP_WORDS = new Set([
  "the", "cli", "a", "an", "one", "invalid", "original", "new", "ones",
  "commands", "command", "plus", "and", "or", "then", "also", "each",
  "named", "required", "main", "both", "all", "with", "from", "for",
  "unknown", "missing", "args", "usage", "json", "node", "python",
  "dotnet", "run", "test", "build", "project", "file", "files",
]);

/**
 * Subcommands named in smoke-test lists or CLI command docs.
 * @param {string} goal
 * @returns {string[]}
 */
export function extractSmokeSubcommands(goal) {
  const text = String(goal ?? "");
  const found = [];
  const pushTokens = (chunk) => {
    for (const part of String(chunk).split(/\s*(?:\/|,|;|\band\b|\bplus\b)\s*/i)) {
      const token = part
        .trim()
        .replace(/^`+|`+$/g, "")
        .replace(/[.:]+$/, "")
        .split(/\s+/)[0];
      if (!token || !/^[a-z][\w-]*$/i.test(token)) continue;
      const lower = token.toLowerCase();
      if (SMOKE_SKIP_WORDS.has(lower)) continue;
      if (!found.includes(lower)) found.push(lower);
    }
  };

  for (const m of text.matchAll(/\bsmoke-test(?:\s+(?:the\s+)?(?:CLI|commands?))?[:\s]+([^.;]+)/gi)) {
    pushTokens(m[1]);
  }

  if (/\b(CLI|dotnet\s+run|subcommand)\b/i.test(text)) {
    for (const m of text.matchAll(/`([a-z][\w-]*)(?:\s+<[^`]+>)?`/gi)) {
      const name = m[1].toLowerCase();
      if (SMOKE_SKIP_WORDS.has(name) || found.includes(name)) continue;
      found.push(name);
    }
  }

  for (const m of text.matchAll(/\bdotnet\s+run(?:\s+--project\s+\S+)?\s+--\s+([a-z][\w-]*)/gi)) {
    const name = m[1].toLowerCase();
    if (!found.includes(name)) found.push(name);
  }

  const trailing = text.match(
    /\bCommands?:\s*`?dotnet\s+run\s+--\s+[a-z][\w-]*`?[,\s]+([^.;]+)/i,
  );
  if (trailing) pushTokens(trailing[1]);

  return found;
}

export function isFollowUpGoal(goal) {
  const text = String(goal ?? "");
  return (
    /\bthis is a new request\b/i.test(text) ||
    /\balready contains a working\b/i.test(text) ||
    /\bdo not rewrite(?: the project)? from scratch\b/i.test(text)
  );
}

function commandCoversSubcommand(cmd, sub) {
  const text = String(cmd ?? "").toLowerCase();
  const s = String(sub ?? "").toLowerCase();
  if (!s) return false;
  const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`--\\s+${escaped}(?:\\s|$)`).test(text) ||
    new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(text)
  );
}

function ranSubcommand(calls, sub) {
  return (calls ?? []).some((c) => {
    if (!isActualRun(c)) return false;
    return commandCoversSubcommand(runCommandText(c), sub);
  });
}

function ranNamedCommand(calls, named) {
  const needle = String(named ?? "")
    .toLowerCase()
    .replace(/^(node|python3?|py)\s+/, "");
  if (!needle) return false;
  return (calls ?? []).some((c) => {
    if (!isActualRun(c)) return false;
    if (commandExitCode(c.result) !== 0) return false;
    return runCommandText(c).toLowerCase().includes(needle);
  });
}

function hasCliSmokeRun(calls) {
  return (calls ?? []).some((c) => {
    if (!isActualRun(c)) return false;
    const cmd = runCommandText(c);
    if (isTestSuiteCommand(cmd) || isDiagnosticCommand(cmd)) return false;
    return commandExitCode(c.result) != null;
  });
}

/**
 * Required verification that has not yet been recorded.
 * @param {string} goal
 * @param {Array<object>} calls
 * @returns {string[]}
 */
export function missingRequiredVerification(goal, calls) {
  const missing = [];
  if (isFollowUpGoal(goal) && !hasSuccessfulMutation(calls)) {
    missing.push("implement the newly requested commands (edit existing files)");
  }
  if (goalRequiresTestVerify(goal) && !hasSuccessfulTestRun(calls)) {
    missing.push("run the test command until it exits 0");
  }
  const named = extractNamedNodeCommands(goal).filter(
    (c) => !/\btest\.(mjs|py)\b/i.test(c) && !/\bdotnet\s+test\b/i.test(c),
  );
  for (const cmd of named) {
    if (!ranNamedCommand(calls, cmd)) missing.push(cmd);
  }
  const smoke = extractSmokeSubcommands(goal);
  if (smoke.length > 0) {
    for (const sub of smoke) {
      if (!ranSubcommand(calls, sub)) missing.push(`smoke ${sub}`);
    }
  } else if (/\bsmoke-test\b/i.test(String(goal ?? "")) && !hasCliSmokeRun(calls)) {
    missing.push("smoke-test the CLI with at least one run_command");
  }
  return missing;
}

/**
 * Refuse re-running the same command or diagnostics after a successful
 * verify. Different smoke commands stay allowed until the task checklist
 * is complete.
 * @param {object} input
 * @param {string} [input.goal]
 * @param {Array<{toolCalls?: Array<object>}>} input.steps
 * @param {string} input.toolName
 * @param {object} [input.args]
 * @returns {string|null}
 */
export function redundantVerifyBlock({ goal, steps, toolName, args }) {
  if (toolName !== "run_command") return null;
  const cmd = String(args?.command ?? args?.cmd ?? "");
  const calls = flattenToolCalls(steps);
  const mutateIdx = lastMutationIndex(calls);
  const since = mutateIdx >= 0 ? calls.slice(mutateIdx + 1) : calls;
  const missing = missingRequiredVerification(goal, calls);

  if (commandAlreadySucceeded(since, cmd)) {
    if (missing.length > 0) {
      return [
        "That exact command already exited 0 — do not re-run it.",
        `Still required: ${missing.slice(0, 5).join("; ")}.`,
      ].join(" ");
    }
    return TOOL_NUDGE_ALREADY_VERIFIED;
  }

  if (
    isDiagnosticCommand(cmd) &&
    since.some((c) => isActualRun(c) && commandExitCode(c.result) === 0)
  ) {
    return missing.length > 0
      ? `Do not run diagnostic commands. Still required: ${missing.slice(0, 5).join("; ")}.`
      : TOOL_NUDGE_ALREADY_VERIFIED;
  }

  if (missing.length > 0) return null;
  const verifiedSince = since.some(
    (c) => isActualRun(c) && commandExitCode(c.result) === 0,
  );
  if (!verifiedSince) return null;
  if (
    hasSuccessfulTestRun(calls) ||
    extractNamedNodeCommands(goal).length > 0 ||
    extractSmokeSubcommands(goal).length > 0 ||
    hasCliSmokeRun(calls)
  ) {
    return TOOL_NUDGE_ALREADY_VERIFIED;
  }
  return null;
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
  const patterns = [
    /\bnode\s+[\w./-]+(?:\s+[\w./=-]+)*/gi,
    /\bpython3?\s+[\w./-]+(?:\s+[\w./=-]+)*/gi,
    /\bpy\s+[\w./-]+(?:\s+[\w./=-]+)*/gi,
    /\bdotnet\s+(?:run|test|build)(?:\s+[\w./=-]+)*/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) {
      const cmd = m[0]
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[.,;:]+$/, "");
      if (!found.includes(cmd)) found.push(cmd);
    }
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
  return /\brun\b.{0,50}\b(test\.mjs|test\.py|tests?|dotnet\s+run)\b/i.test(String(goal ?? ""));
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
 * Pull C# / compiler diagnostic lines out of command output so failures are
 * not buried in build noise.
 * @param {string} text
 * @returns {string}
 */
export function extractCompilerDiagnostics(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const hits = lines.filter((line) =>
    /\berror\s+CS\d{4}\b|\bCS\d{4}\b|\berror\s+[A-Z]{2}\d{3,4}\b/i.test(line),
  );
  return [...new Set(hits.map((l) => l.trim()))].slice(0, 20).join("\n");
}

/**
 * Block completion when the model tries to finish with an empty message.
 * @param {object} input
 * @param {string} input.goal
 * @param {string} input.answerText
 * @param {Array<{toolCalls?: Array<{name: string, ok?: boolean}>}>} input.steps
 * @param {number} input.nudgeCount
 * @returns {string|null}
 */
export function emptyFinalAnswerNudge({ goal, answerText, steps, nudgeCount }) {
  const MAX_TOOL_NUDGES = 2;
  if (nudgeCount >= MAX_TOOL_NUDGES) return null;
  if (String(answerText ?? "").trim()) return null;

  const hints = detectTaskHints(goal);
  const usedTools = substantiveToolsUsed(steps).size > 0 || anyToolCallsExecuted(steps);
  if (hints.some((h) => h.id === "path-answer") || isQuestionGoal(goal)) {
    return usedTools ? TOOL_NUDGE_EMPTY_VALUE : TOOL_NUDGE_EMPTY_ANSWER;
  }
  if (usedTools) return TOOL_NUDGE_EMPTY_AFTER_TOOLS;
  if (goalNeedsSubstantiveTools(goal)) return TOOL_NUDGE_EMPTY_ANSWER;
  return TOOL_NUDGE_EMPTY_AFTER_TOOLS;
}

export function prematureFinalNudge({ goal, answerText, steps, nudgeCount }) {
  const MAX_TOOL_NUDGES = 2;
  if (nudgeCount >= MAX_TOOL_NUDGES) return null;

  const empty = emptyFinalAnswerNudge({ goal, answerText, steps, nudgeCount });
  if (empty) return empty;

  if (!goalNeedsSubstantiveTools(goal)) return null;
  if (substantiveToolsUsed(steps).size > 0) return null;
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
    if (hasFailedTestRun(calls) && !hasSuccessfulMutation(calls)) return TOOL_NUDGE_FIX_IMPL;
    if (!hasSuccessfulMutation(calls) && !hasReadImplementationFile(calls)) {
      return TOOL_NUDGE_READ_IMPL;
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

  const missing = missingRequiredVerification(goal, calls).filter(
    (item) => item !== "run the test command until it exits 0",
  );
  if (missing.length > 0 && (claimsSuccess || substantiveToolsUsed(steps).size > 0)) {
    if (missing.includes("implement the newly requested commands (edit existing files)")) {
      return TOOL_NUDGE_FOLLOW_UP;
    }
    return `Do not finish yet — still need: ${missing.slice(0, 5).join("; ")}.`;
  }

  return null;
}

/**
 * Combined nudge used by the agent loop when the model tries to finish.
 * @param {object} input
 * @returns {string|null}
 */
export function finalAnswerNudge(input) {
  return emptyFinalAnswerNudge(input) ?? prematureFinalNudge(input) ?? completionVerifyNudge(input);
}

/**
 * After tools have already satisfied verification, tell the model to stop
 * instead of re-running tests or launching diagnostics (node -v, etc.).
 * @param {object} input
 * @returns {string|null}
 */
export function alreadyVerifiedFinishNudge({ goal, steps, nudgeCount }) {
  const MAX_TOOL_NUDGES = 2;
  if (nudgeCount >= MAX_TOOL_NUDGES) return null;
  if (!steps?.length) return null;
  const last = steps[steps.length - 1];
  const lastCalls = last?.toolCalls ?? [];
  if (!lastCalls.some((c) => c.name === "run_command")) return null;
  const lastRun = [...lastCalls].reverse().find((c) => c.name === "run_command");
  const complete = lastRun?.result?.verificationComplete === true;
  if (!complete && commandExitCode(lastRun?.result) !== 0) return null;
  if (
    !complete &&
    looksVacuousCliStdout(commandStdout(lastRun?.result), runCommandText(lastRun), goal)
  ) {
    return null;
  }
  if (missingRequiredVerification(goal, flattenToolCalls(steps)).length > 0) return null;
  const stillNeedsVerify = completionVerifyNudge({
    goal,
    answerText: "completed successfully",
    steps,
    nudgeCount: 0,
  });
  if (stillNeedsVerify) return null;
  const calls = flattenToolCalls(steps);
  if (
    !hasSuccessfulTestRun(calls) &&
    extractNamedNodeCommands(goal).length === 0 &&
    extractSmokeSubcommands(goal).length === 0 &&
    !complete
  ) {
    return null;
  }
  return TOOL_NUDGE_ALREADY_VERIFIED;
}

/**
 * Duplicate-call guard copy. When verification already passed, point the
 * model at the final answer instead of `node -v`.
 * @param {object} input
 * @returns {string}
 */
export function repeatedToolCallMessage({ repeatedCount, goal, steps }) {
  const verified = alreadyVerifiedFinishNudge({ goal, steps, nudgeCount: 0 });
  const base =
    `You have made this exact tool call ${repeatedCount + 1} times in a row; ` +
    "it was not executed again.";
  if (verified) return `${base} ${verified}`;
  return (
    `${base} Do something different: change the arguments, use another tool, ` +
    "or give your final answer now."
  );
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
    const matched =
      typeof rule.test === "function" ? rule.test(text) : rule.test?.test?.(text) === true;
    if (matched && !seen.has(rule.id)) {
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
 * Whether the first turn should run a planning pre-pass.
 * Word count is not complexity: "create an Electron app" is short and hard.
 * Skip only empty prompts and simple read-and-answer goals, where a plan
 * fights "reply with just the number." `--no-plan` still disables all planning.
 * @param {string} goal
 * @returns {boolean}
 */
export function shouldPlanGoal(goal) {
  const text = String(goal ?? "").trim();
  if (!text) return false;
  if (isSimpleReadAnswerGoal(text)) return false;
  return true;
}

/**
 * @param {string} goal
 * @returns {boolean}
 */
export function isComplexGoal(goal) {
  return shouldPlanGoal(goal);
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
