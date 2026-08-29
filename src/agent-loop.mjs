/**
 * Core agent loop: send the conversation to the model, execute any tool
 * calls it makes, feed results back, and repeat until the model answers in
 * plain text or a stop condition trips.
 */

import { compactMessages, DEFAULT_CONTEXT_FRACTION } from "./compaction.mjs";
import {
  acceptanceFailureNudge,
  buildAcceptanceContract,
  CONTRACT_PROGRESS_CRITIQUE,
  CRITIQUE_USER_MESSAGE,
  formatAcceptanceContract,
  isVerifyOutstandingOnly,
  verifyAcceptanceContract,
} from "./acceptance.mjs";
import { listWorkspaceTopLevel } from "./context-builder.mjs";
import {
  computeStruggleScore,
  DEFAULT_ESCALATION_THRESHOLD,
  EscalationController,
} from "./escalation.mjs";
import {
  maybeWriteLesson,
  recordLessonOutcomes,
  retrieveMemoryHints,
} from "./memory-store.mjs";
import {
  ADJUST_PLAN_MESSAGE,
  createPlanState,
  findLastPlanText,
  formatCheckpoint,
  markProgress,
  MAX_REMAINING_REPLANS,
  missingKey,
  parsePlanSteps,
  REPLAN_REMAINING_MESSAGE,
} from "./plan-state.mjs";
import { gatherFirstTurnProjectContext } from "./project-index.mjs";
import {
  alreadyVerifiedFinishNudge,
  ambiguousEditRecoveryNudge,
  blockedCommandOutcome,
  countConsecutiveFailedWorkCommands,
  detectTaskHints,
  extractCompilerDiagnostics,
  finalAnswerNudge,
  flattenToolCalls,
  formatExplicitGoals,
  formatTaskConstraints,
  goalNeedsSubstantiveTools,
  shouldPlanGoal,
  isTerminalVerificationMessage,
  mutationBlockedUntilPretest,
  PLANNING_USER_MESSAGE,
  redundantVerifyBlock,
  buildDepsInstallRerunNudge,
  repeatedEditMissNudge,
  repeatedSearchLoopNudge,
  repeatedToolCallMessage,
  secretHitWithoutEditNudge,
  deliverableDriftNudge,
  emptyResponseRecoveryNudge,
  formatZeroTokenDiagnostic,
  heredocRetryBlock,
  isEmptyAssistantResponse,
  isThinkingOnlyResponse,
  shouldFailOnEmptyResponses,
  substantiveToolsUsed,
  synthesizeFinalAnswer,
  TOOL_NUDGE_NEAR_LIMIT,
  verificationCompleteOutcome,
} from "./prompt-enhancements.mjs";

/**
 * Sent as a final user message when the loop runs out of steps, so the run
 * still ends with a useful answer instead of empty text.
 */
const WRAP_UP_PROMPT = [
  "You have used all available tool steps for this task.",
  "Answer the user now in plain text using what you have learned.",
  "Your reply must be non-empty and must directly answer the question.",
  "If you were asked for a path or number, reply with only that value",
  "(the defining file's relative path, not an import site).",
  "If you diagnosed a compile or test fix you did not apply, state that exact remaining change.",
  "If the task is not finished, say clearly what was done and what remains.",
  "Do not call any more tools.",
].join(" ");

/** Consecutive identical tool-call steps allowed before execution is refused. */
const MAX_REPEATED_STEPS = 2;

/**
 * Blocks the acceptance gate may spend, as a share of the step budget. Each
 * block costs a step, so the loop always terminates; this only stops a contract
 * the model cannot satisfy from consuming the entire budget. Too small a budget
 * lets a model that keeps claiming done finish with work outstanding.
 */
const ACCEPTANCE_NUDGE_BUDGET_RATIO = 1 / 3;
const MIN_ACCEPTANCE_NUDGES = 2;

/**
 * How many times to recover when Ollama rejects a malformed tool call
 * (`error parsing tool call`). gpt-oss and similar models sometimes leak
 * reasoning into the tool-call channel; a nudge + retry usually clears it.
 */
const MAX_TOOL_CALL_PARSE_RECOVERIES = 2;

const TOOL_CALL_PARSE_NUDGE = [
  "Your previous response was rejected: it mixed free-form text into the",
  "tool-call channel (Ollama could not parse the tool call).",
  "Call tools using the native tool-calling format only — function name plus",
  "JSON arguments matching the schema. Put reasoning in thinking, not inside",
  "the tool call.",
  "For write_file/edit_file, content and old_string/new_string must be valid JSON",
  "strings — escape quotes as \\\" and newlines as \\n; never paste raw multiline",
  "text outside JSON string quotes.",
  "For multi-line Python/shell, do not put a large heredoc in run_command:",
  "write_file a .py/.sh path, then run_command that path (e.g. python script.py).",
  "Retry with a short, valid tool call now.",
].join(" ");
/**
 * Written for small local models, which need procedural guidance, not just
 * permission to use tools: each rule below maps to a known failure mode
 * (guessing instead of reading, re-reading files instead of searching,
 * blind edits, repeating failed calls, never finishing).
 */
export const DEFAULT_SYSTEM_PROMPT = [
  "You are a capable local assistant that completes tasks using tools.",
  "Call tools with valid arguments matching their schemas.",
  "",
  "Goals:",
  "- At the start of every task, make success explicit: what artifacts must exist,",
  "  which commands must exit 0 (and with what output), and what shape the final",
  "  answer must take. The user message may include a ## Goals section — treat",
  "  those bullets as acceptance criteria and do not finish until each is satisfied.",
  "  When planning, restate or refine those goals before your numbered steps.",
  "  Goals, the numbered plan, and ## Acceptance are internal working notes —",
  "  do not include them in your final answer unless the user asked for a plan.",
  "",
  "Rules:",
  "- Ground answers in facts from tools; never guess. For questions about this",
  "  project, use the README and auto-retrieved passages from the first turn,",
  "  then read_file, grep_search, or find_files for more detail. Only use",
  "  search_project if that tool is listed in your available tools.",
  "- For current events, upstream docs, release notes, or anything outside",
  "  this workspace, use web_search, then fetch_url on promising links.",
  "  Pass a query to fetch_url so micro-RAG returns relevant passages instead",
  "  of the whole page.",
  "- To find where something is defined or used, use grep_search or find_files",
  "  first — do not list_dir to hunt for a symbol. Read the matching file after",
  "  the search hit. Do not call search_project or a bare `tail` tool unless",
  "  those tools appear in your available tool list — use grep_search,",
  "  read_file, and run_command instead.",
  "- Multi-line scripts: write_file (or cat/heredoc redirected to a file) then",
  "  run that path. Never embed large heredocs or nested quote soup as",
  "  run_command arguments — tool JSON mangles them.",
  "- Read a file before editing it. Before your first edit, also read any",
  "  existing tests or callers that define the expected interface (flag names,",
  "  function signatures, output format) so your first attempt matches them.",
  "  Use edit_file for changes to existing files; use write_file only for new",
  "  files or full rewrites. If asked to fix or edit a named file, read it first.",
  "  If that file does not exist, report that and stop — do not write_file to",
  "  create it unless the task asked you to create that file. Prefer the",
  "  smallest exact replacement (one key or one line, e.g. '\"debug\": false' ->",
  "  '\"debug\": true') over rewriting the file.",
  "- After changing files, verify the result: re-read the changed part, or run",
  "  commands explicitly named in the user instruction with run_command.",
  "  Generic examples like test.mjs or test.py are not verification unless the",
  "  instruction names them. If no such command exists after the artifact is",
  "  written, re-read the output file and stop.",
  "  Never declare completion without running every acceptance command named",
  "  in the instruction and confirming exit 0 plus expected output shape.",
  "  Once a required verification command exits 0 with the expected output,",
  "  do not re-run that same command. Different named checks (dotnet build vs a",
  "  smoke-test subcommand, or test.mjs vs a CLI invocation) still each need",
  "  their own run_command. After all named checks pass, stop immediately — no",
  "  diagnostics. If a tool result includes verificationComplete: true, that is",
  "  terminal success: give the final answer listing changed files and the",
  "  passing command. Implement only what the task asks; do not add standalone",
  "  entrypoints, listen() bootstraps, or formatting-only edits unless requested",
  "  or required for tests. On Windows, run_command is PowerShell: chain with ';' not",
  "  '&&', and write new shell scripts as .ps1 (not bash/.sh) unless the user asked",
  "  for bash.",
  "  Exit 0 with empty stdout is not success for a CLI that should print:",
  "  fix the entry-point guard, then re-run. A repeated-call refusal after a",
  "  passing verification means the task is done: give your final answer, do",
  "  not run node -v or other diagnostics, and do not mention blocked commands.",
  "- For build/install tasks (apt install, wget, tar, ./configure, make): each",
  "  step needs its own successful run_command. When the instruction names a",
  "  specific source channel (Debian packages, apt), stay on that channel —",
  "  do not switch mirrors because fetch_url failed. System paths (/etc/apt,",
  "  /usr/local/bin) require run_command, not write_file. After installing",
  "  build-essential, re-run the last failed compile/make before new strategies.",
  "  step needs its own successful run_command. Environment probes (apt-get",
  "  --version, apt-cache policy, uname, which, diff, awk, head) are not task",
  "  completion. Finish only after a smoke test matching the instruction path",
  "  (e.g. /tmp/CompCert/ccomp --version).",
  "- For 7z/archive commands: exit 0 with 'No files to process' or 'Files: 0'",
  "  is not successful extraction — use -p'' to fail fast without a password, or",
  "  supply -pPASSWORD; confirm extracted files exist before finishing.",
  "  When grep finds *2john converters (7z2john.pl), run them before manual",
  "  password guessing: converter → build john → john --wordlist=….",
  "- For artifact-creation (write X to file Y, or an output titled foo.fasta):",
  "  you must write_file that path before finishing. Exit 0 alone does not mean",
  "  the task is done unless the required output artifact exists. If no files",
  "  were changed, keep working or report failure — do not stop.",
  "  If the named output is still missing after several steps, refuse to finish",
  "  with an empty or success-only answer until write_file succeeds.",
  "  File paths are relative to the workspace root. If the root is /app, write",
  "  filter.py — not app/filter.py or /app/filter.py (those create /app/app/filter.py).",
  "  File-exists checks (test -f, ls) are not functional acceptance: an empty or",
  "  stub file does not satisfy behavioral output (sim must print values, etc.).",
  "  After creating the artifact, run the instruction's named verification command",
  "  and confirm stdout matches before stopping.",
  "- For script deliverables (.py/.sh/.ps1), smoke-test before finishing:",
  "  python -m py_compile <file> (or equivalent) and at least one run with the",
  "  instruction's demo paths when available. Do not mark done if the file fails",
  "  to parse. After write/edit, re-read the deliverable so the final answer",
  "  matches on-disk contents.",
  "- For PyTorch/ML tasks: read tests and callers before implementing. Keep token",
  "  IDs and label indices as integer (torch.long); only activations/hidden",
  "  states/gradients use the passed float dtype. py_compile is not enough — run",
  "  pytest on /tests when present. Avoid module-level print() that runs on import.",
  "  In Docker /app workspaces, uv/pytest may be available; try pytest first, or a",
  "  minimal python -c import smoke with fake tensors when deps are heavy.",
  "- For weights.json + cli_tool tasks: export real JSON weights (never cp a .pth to",
  "  weights.json), validate with json.load, then run ./cli_tool weights.json",
  "  <image.png> and confirm exit 0 with a single-digit stdout before finishing.",
  "  When lodepng/cJSON sources are in the workspace and the task wants a binary",
  "  cli_tool, compile the native C path (gcc/make) instead of delegating to Python.",
  "- Threshold / optimization tasks: measure against the stated metric and",
  "  iterate until the threshold passes or the step budget is gone. Helper or",
  "  baseline scripts are not completion — and they may overwrite output_data;",
  "  re-run your packer/solver after any baseline that clobbers outputs.",
  "- Secret-sanitize tasks: search literal token patterns (AKIA*, ghp_*, hf_*)",
  "  and values after '=', not only env var names. After edits, grep again to",
  "  prove secrets are gone. Do not claim files were changed if write_file/",
  "  edit_file never succeeded.",
  "- When instructions describe RPC/message fields in English (e.g. 'a value (int)'),",
  "  use that exact identifier as the proto/JSON field name unless a different name",
  "  is quoted; do not shorten value to val.",
  "- For numeric artifacts (fits, peaks, eigenvalues), check that written values",
  "  sit in the stated domain range before finishing; file-exists plus exit 0 is",
  "  not enough when numbers look physically absurd.",
  "- For HTML/JS sanitization, prefer a parser and allowlist over regex-only",
  "  stripping, and regression-test common XSS bypasses before finishing.",
  "- After 2–3 identical tool failures (same URL, query, or edit), stop repeating",
  "  that call. Switch approach: curl/wget instead of fetch_url, archive.org or",
  "  apt-cache instead of a 404 page, write_file instead of another edit_file.",
  "- Do not finish with a proposed patch table. Apply changes with write_file or",
  "  edit_file. Outline-only stubs and unimplemented syscalls are not done.",
  "- For download/build tasks use run_command (curl/wget) for the archive, not",
  "  fetch_url. Then extract, compile, install, and run the named sanity command.",
  "- When the instruction pins a package/version/revision, import that package",
  "  first. For reverse-engineering, start with objdump/readelf/strings; do not",
  "  overwrite the provided binary. For truncated SQLite, carve pages, do not guess.",
  "- Keep reasoning in thinking or plain content only. When you call tools,",
  "  leave assistant content empty or minimal so the tool-call JSON is not",
  "  rejected. Do not mix prose into the tool-call channel.",
  "- Internal thinking/reasoning never counts as task progress. For",
  "  artifact-creation or implementation tasks, your first actionable turn",
  "  must be a tool call (write_file or run_command), not an empty assistant",
  "  message with only thinking.",
  "- When the task mentions failing tests, your first tool step must be",
  "  run_command with that test command; do not edit until you have seen the",
  "  failure exit code and output. If the first run already exits 0, read the",
  "  implementation and stop — do not add validation, docstrings, or extras.",
  "  If it fails, fix only the broken logic, then re-run the tests.",
  "- Before claiming success, run every command the task names (e.g. node",
  "  test.mjs, python test.py, or `dotnet run`) with run_command.",
  "  Only claim pass/success when the exit code is 0 AND stdout matches what",
  "  the task asked to print. Empty stdout or [] is a failure for a CLI that",
  "  should print records — read stdout, do not stop on exit 0 alone.",
  "  run_command results start with a status field: FAILED or TIMED OUT means",
  "  the command did not succeed even though the tool call returned — read",
  "  stderr, do not assume success. A non-zero exitCode is always failure.",
  "- For lookup-and-write tasks (leaderboard/MTEB): fetch once, compute,",
  "  write_file the required output path, verify — never finish describing",
  "  remaining work. After one heredoc rejection, use write_file + script only.",
  "- When the instruction lists numbered deliverable files, every one must exist on",
  "  disk (write_file or confirmed test -f) before finishing — do not stop after",
  "  creating only the first output.",
  "- Never launch a bare interpreter or shell (node, python, bash, ...) with",
  "  no script or inline code: commands run with no input, so a REPL hangs",
  "  until the timeout. A timed-out command is a failure — change the command",
  "  instead of repeating it, and do not spend your final answer explaining",
  "  shell behavior.",
  "- Files ending in .mjs are ES modules: use import/export, never require or",
  "  module.exports. Resolve sibling files with fileURLToPath(new URL('./file',",
  "  import.meta.url)), never URL.pathname — that is wrong on Windows. When",
  "  tests spawn a sibling CLI, use that same fileURLToPath URL, never",
  "  pathToFileURL(absPath).pathname.",
  "- When a .mjs file is both a CLI entry and importable, guard top-level CLI",
  "  code with import.meta.url === pathToFileURL(process.argv[1]).href (or keep",
  "  lib and bin separate) so importing from tests does not call process.exit.",
  "  Prefer tests that spawn the CLI (or assert stdout) over importing a CLI",
  "  module that exits on load.",
  "- When a task says a server listens on a port, the entry module must call",
  "  listen when executed directly (same import.meta.url main check), not only",
  "  export a start helper for tests. Insert new routes above any catch-all",
  "  404 handler so existing fallback behavior stays intact. Do not start a",
  "  long-running server in the foreground after tests already passed. Outbound",
  "  HTTP in tests should use `import { request } from 'node:http'` (or fetch);",
  "  createServer() returns a server, not a request factory.",
  "- When renaming or fixing a misspelled identifier, update every declaration,",
  "  export, and reference in one edit_file call (set replace_all when the old",
  "  string is the typo alone — never replace_all on a return/statement line).",
  "- When edit_file reports that old_string is ambiguous, include the enclosing",
  "  function or class (for example `def mul(a, b):\\n    return a + b`) and omit",
  "  replace_all unless you intend to change every occurrence. Then verify once.",
  "- When extracting a shared module, write the shared file first, then update",
  "  importers, then run tests. When a sample/fixture file is named, read it",
  "  before writing the implementation. In C#, do not name a method the same",
  "  as its class (CS0542) — keep the class name, rename the method. JSON from C#",
  "  CLIs: deserialize with PropertyNameCaseInsensitive = true and serialize",
  "  with JsonNamingPolicy.CamelCase (input keys are usually camelCase). Python JSON CLIs: named flags only; empty/[] is failure; stop after test.py and the named invocation pass. If Foo.py defines foo(), use from foo import foo. For new",
  "  C# console apps, prefer a Program class with static void Main(string[] args)",
  "  over mixing top-level statements with type declarations (CS8803). Never",
  "  declare a local `args` in a top-level program (CS0136 shadows implicit Main",
  "  args — use `cliArgs`). Never use `out` variables inside `||`/`&&` (CS0165);",
  "  assign TryParse to a bool, then test it. After the first compile error,",
  "  apply the canonical fix for that CS code once. Locate a .NET solution via",
  "  .sln, .slnx, or the known csproj — do not hardcode one filename.",
  "- For CLIs: validate required args, wrap file I/O in try/catch with a",
  "  user-facing error and non-zero exit, then run tests.",
  "- In your final answer, mention only files you actually created or edited;",
  "  do not claim you added tests or docs you did not write. If tests were",
  "  already present and left unchanged, say so. Never mention blocked",
  "  diagnostic commands such as node -v. Do not paste Goals, Acceptance, or",
  "  the numbered plan into the final answer — those stay in the planning turn.",
  "- Deleting files is destructive. Delete a file only when the user",
  "  explicitly named it for deletion, and never delete a file the user asked",
  "  to keep. If the task implies deleting files the user did not name (e.g.",
  "  'clean up'), do not delete anything — finish and ask the user to confirm",
  "  exactly which files may be removed.",
  "- If a tool call fails, read the error and change your approach. Never",
  "  repeat a call that just failed with the same arguments.",
  "- Never finish with an empty message. After tools return, synthesize a",
  "  non-empty final answer. When the user asks for only a path, number, or",
  "  other single value, reply with that value alone (the file that DEFINES",
  "  a symbol, not an import site) and do not call more tools.",
  "- When creating or fixing tests, run them with run_command before finishing",
  "  and report whether they passed in your final answer.",
  "- After a git merge CONFLICT, do not stop after inspecting both sides",
  "  (git show). Resolve <<<<<<< markers with edit_file or write_file, then",
  "  git add and git commit, then run named verification (e.g. examples.json).",
  "  An empty reply with no further tools is incomplete while conflict markers",
  "  remain or that verification has not run — keep going.",
  "- Keep going until the task is done, then reply to the user in plain text",
  "  with no tool calls. State what you did and what, if anything, remains.",
  "- If the user says this is a new request or the workspace already contains a",
  "  working project, that is mandatory new work: edit files for every newly",
  "  named command before verifying. Passing build or old commands is not done.",
  "- Before editing tests on failure, trace program state against the spec; if",
  "  the implementation already matches, keep it and fix the assertion.",
].join("\n");

/**
 * @typedef {object} AgentStep
 * @property {number} index 1-based model round-trip number.
 * @property {"tool-calls"|"final"|"plan"|"escalation"|"tool-parse-error"|"failed"} kind What the model did this step.
 * @property {string} content Assistant text for this step (may be empty).
 * @property {Array<{name: string, args: object, ok: boolean, result?: unknown, error?: string}>} toolCalls
 */

/**
 * @typedef {object} AgentRunResult
 * @property {string} text Final assistant answer ("" if the loop was cut off).
 * @property {"completed"|"max-steps"|"aborted"|"failed"} stopReason
 * @property {AgentStep[]} steps
 * @property {Array<object>} messages Full transcript, replayable into another run.
 * @property {{passed: boolean, checks: Array<object>, missing: string[]}} [verification]
 * @property {number} [escalationCount]
 * @property {boolean} [cloudUsed]
 * @property {string[]} [memoryLessonIds]
 */

export class AgentLoop {
  /**
   * @param {object} options
   * @param {{chat: Function}} options.client Ollama client (or any object with
   *   a compatible `chat({messages, tools, signal})`).
   * @param {import("./tool-registry.mjs").ToolRegistry} options.registry
   * @param {string} [options.systemPrompt]
   * @param {number} [options.maxSteps] Max model round-trips per run.
   * @param {(step: AgentStep) => void} [options.onStep] Observer for tracing.
   * @param {(delta: string) => void} [options.onDelta] Live content tokens from
   *   the model (main loop only; planning/critique are silent). Fired as Ollama
   *   streams when the client supports `chatStream`.
   * @param {{maxChars?: number, maxTokens?: number, keepRecent?: number}|false} [options.compaction]
   *   Summarize old turns when the transcript exceeds the budget. Off by
   *   default. When the client exposes `numCtx` (OllamaClient does), the
   *   token budget defaults to a fraction of it and the trigger uses actual
   *   token counts reported by the model.
   * @param {object|false} [options.projectBootstrap]
   *   On the first turn of a conversation, force README + goal-specific RAG into
   *   the user message before the model is called. `{ workspaceRoot, client?,
   *   embeddingModel?, onProgress? }`.
   * @param {(info: {readme: boolean, ragHits: number}) => void} [options.onBootstrap]
   * @param {boolean} [options.planning] Pre-pass plan on first turns (default true).
   *   Skips only empty goals and simple read-and-answer prompts.
   * @param {boolean} [options.replan] Mid-run remaining-step replan + follow-up adjust (default true).
   *   Ignored when `planning` is false.
   * @param {boolean} [options.taskHints] Append task-type constraints to the user message (default true).
   * @param {boolean} [options.memory] Retrieve episodic memory hints (default true when embed client available).
   * @param {boolean} [options.memoryReadonly] Do not write or update memory stats.
   * @param {string} [options.embeddingModel] Embedding model for memory retrieval.
   * @param {boolean} [options.acceptance] Verify acceptance contract before completion (default true).
   * @param {boolean} [options.critique] Self-critique pass after planning (default true).
   * @param {import("./escalation.mjs").EscalationController|false} [options.escalation]
   * @param {(info: {plan: string, hints: Array<{id: string, constraint: string}>}) => void} [options.onPlan]
   */
  constructor({
    client,
    registry,
    systemPrompt,
    maxSteps = 10,
    onStep,
    onDelta,
    compaction = false,
    projectBootstrap = false,
    onBootstrap,
    planning = true,
    replan = true,
    taskHints = true,
    memory = true,
    memoryReadonly = false,
    embeddingModel,
    acceptance = true,
    critique = true,
    escalation = false,
    onPlan,
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
    this.projectBootstrap = projectBootstrap;
    this.onBootstrap = onBootstrap;
    this.planning = planning;
    this.replan = replan;
    this.taskHints = taskHints;
    this.memory = memory;
    this.memoryReadonly = memoryReadonly;
    this.embeddingModel = embeddingModel;
    this.acceptance = acceptance;
    this.critique = critique;
    this.escalation = escalation instanceof EscalationController ? escalation : false;
    this.onPlan = onPlan;
  }

  /**
   * Run one goal to completion.
   *
   * @param {string} goal User task.
   * @param {object} [options]
   * @param {Array<object>} [options.history] Prior transcript (from a previous
   *   run's `messages`) to continue a session. Must already include a system
   *   message if it is non-empty.
   * @param {string[]} [options.images] Ollama-format base64 images for the
   *   new user turn (when the goal came with attachments).
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<AgentRunResult>}
   */
  async run(goal, { history, signal, images } = {}) {
    // Give tools the user's own words for safety decisions (e.g. the shell
    // tool only deletes files the goal explicitly names).
    this.registry.setRunContext?.({ goal });
    const freshTurn = isFreshTurn(history);
    let messages =
      history && history.length > 0
        ? [...history]
        : [{ role: "system", content: this.systemPrompt }];
    let userContent = goal;
    if (freshTurn) {
      const explicitGoals = formatExplicitGoals(goal);
      if (explicitGoals) userContent = `${explicitGoals}\n\n${userContent}`;
    }
    const workspaceRoot = this.projectBootstrap?.workspaceRoot ?? process.cwd();
    let workspaceEntries = [];
    if (freshTurn) {
      try {
        workspaceEntries = await listWorkspaceTopLevel(workspaceRoot);
      } catch {
        workspaceEntries = [];
      }
    }
    const hints = this.taskHints ? detectTaskHints(goal, { workspaceEntries }) : [];
    const taskFocus = this.taskHints ? formatTaskConstraints(hints) : "";
    let memoryLessonIds = [];
    let memoryFocus = "";
    if (this.memory && this.client?.embed && freshTurn) {
      try {
        const mem = await retrieveMemoryHints({
          goal,
          client: this.client,
          embeddingModel: this.embeddingModel,
          readonly: this.memoryReadonly,
        });
        memoryFocus = mem.text;
        memoryLessonIds = mem.lessonIds;
      } catch {
        // Memory is best-effort.
      }
    }
    const focusBlocks = [memoryFocus, taskFocus].filter(Boolean).join("\n\n");
    if (focusBlocks) userContent = `${focusBlocks}\n\n${userContent}`;

    const userMessage = { role: "user", content: userContent };
    if (Array.isArray(images) && images.length > 0) {
      userMessage.images = images;
    }
    messages.push(userMessage);

    if (this.projectBootstrap && freshTurn) {
      const bootstrap = await gatherFirstTurnProjectContext({
        workspaceRoot: this.projectBootstrap.workspaceRoot,
        goal,
        client: this.projectBootstrap.client,
        embeddingModel: this.projectBootstrap.embeddingModel,
        signal,
        onProgress: this.projectBootstrap.onProgress,
      });
      userContent = `${userContent}\n\n${bootstrap.text}`;
      this.onBootstrap?.({ readme: bootstrap.readme, ragHits: bootstrap.ragHits });
    }

    messages[messages.length - 1].content = userContent;

    const steps = [];
    let acceptanceContract = buildAcceptanceContract(goal);
    let planText = "";
    /** @type {import("./plan-state.mjs").PlanState|null} */
    let planState = null;

    const applyPlanText = (nextPlan, { critique = false } = {}) => {
      if (!nextPlan) return;
      planText = nextPlan;
      planState = createPlanState(planText);
      acceptanceContract = buildAcceptanceContract(goal, planText);
      this.onPlan?.({ plan: planText, hints });
      if (!critique) {
        const contractBlock = formatAcceptanceContract(acceptanceContract);
        if (contractBlock) {
          userContent = `${userContent}\n\n${contractBlock}`;
          const userMsg = messages.find((m) => m.role === "user");
          if (userMsg) userMsg.content = userContent;
        }
      }
    };

    if (this.planning && freshTurn && shouldPlanGoal(goal) && !signal?.aborted) {
      try {
        const planMessages = [
          ...messages,
          { role: "user", content: PLANNING_USER_MESSAGE },
        ];
        const { message } = await chatWithRetry(this.client, {
          messages: planMessages,
          signal,
        });
        const firstPlan = textOf(message.content).trim();
        if (firstPlan) {
          messages.push({ role: "user", content: PLANNING_USER_MESSAGE });
          messages.push({ role: "assistant", content: firstPlan });
          const planStep = { index: 0, kind: "plan", content: firstPlan, toolCalls: [] };
          steps.push(planStep);
          this.onStep?.(planStep);
          applyPlanText(firstPlan);

          if (this.critique && !signal?.aborted) {
            try {
              const critiqueMessages = [
                ...messages,
                { role: "user", content: CRITIQUE_USER_MESSAGE },
              ];
              const { message: critiqueMsg } = await chatWithRetry(this.client, {
                messages: critiqueMessages,
                signal,
              });
              const critiqueText = textOf(critiqueMsg.content).trim();
              if (critiqueText) {
                messages.push({ role: "user", content: CRITIQUE_USER_MESSAGE });
                messages.push({ role: "assistant", content: critiqueText });
                const critiqueStep = {
                  index: 0,
                  kind: "plan",
                  content: critiqueText,
                  toolCalls: [],
                };
                steps.push(critiqueStep);
                this.onStep?.(critiqueStep);
                applyPlanText(critiqueText, { critique: true });
              }
            } catch {
              // Critique is best-effort.
            }
          }
        }
      } catch {
        // Planning is best-effort — proceed without it.
      }
    } else if (
      this.planning &&
      this.replan &&
      !freshTurn &&
      shouldPlanGoal(goal) &&
      !signal?.aborted
    ) {
      try {
        const priorPlan = findLastPlanText(messages);
        if (priorPlan) {
          const adjustMessages = [
            ...messages,
            {
              role: "user",
              content: `Prior plan for context:\n${priorPlan}`,
            },
            { role: "user", content: ADJUST_PLAN_MESSAGE },
          ];
          const { message } = await chatWithRetry(this.client, {
            messages: adjustMessages,
            signal,
          });
          const adjusted = textOf(message.content).trim();
          if (adjusted && isUsablePlanText(adjusted)) {
            messages.push({
              role: "user",
              content: `Prior plan for context:\n${priorPlan}`,
            });
            messages.push({ role: "user", content: ADJUST_PLAN_MESSAGE });
            messages.push({ role: "assistant", content: adjusted });
            const adjustStep = { index: 0, kind: "plan", content: adjusted, toolCalls: [] };
            steps.push(adjustStep);
            this.onStep?.(adjustStep);
            applyPlanText(adjusted);
          }
        }
      } catch {
        // Adjust-plan is best-effort.
      }
    }

    const tools = this.registry.schemas();
    // Actual context usage (prompt + completion tokens) from the last model
    // response — a far better compaction trigger than counting characters.
    let observedTokens = 0;
    // Small models get stuck repeating one tool call verbatim; track
    // consecutive identical steps so we can break the cycle.
    let repeatedKey = "";
    let repeatedCount = 0;
    let toolNudgeCount = 0;
    let nearLimitNudged = false;
    let consecutiveEmpty = 0;
    let totalEvalCount = 0;
    let parseRecoveries = 0;
    const runStarted = Date.now();

    let budgetPressure = 0;
    let workOutstanding =
      this.acceptance &&
      goalNeedsSubstantiveTools(goal) &&
      !(acceptanceContract?.checks?.length);
    let escalationBlockReported = false;
    let acceptanceNudgeCount = 0;
    let replanCount = 0;
    let checkpointInjected = false;
    let lastMissingFingerprint = "";
    let stuckMissingCount = 0;
    let lastReplanPaidSteps = -Infinity;
    let verifyOutstandingOnly = false;
    let contractCritiqueInjected = false;
    const maxAcceptanceNudges = Math.max(
      MIN_ACCEPTANCE_NUDGES,
      Math.floor(this.maxSteps * ACCEPTANCE_NUDGE_BUDGET_RATIO),
    );

    const struggleState = () => ({
      repeatedCount,
      consecutiveEmpty,
      toolNudgeCount,
      parseRecoveries,
      editMissLoop: Boolean(ambiguousEditRecoveryNudge({ steps })),
      searchLoop: Boolean(repeatedSearchLoopNudge({ steps })),
      budgetPressure,
      workOutstanding,
      hollowCompletion: goalNeedsSubstantiveTools(goal) && substantiveToolsUsed(steps).size === 0,
      paidSteps,
      consecutiveFailedRuns: countConsecutiveFailedWorkCommands(flattenToolCalls(steps), goal),
      verifyOutstandingOnly,
    });

    const finalizeRun = async (result) => {
      const struggleScore = computeStruggleScore(struggleState());
      let verification = result.verification;
      if (this.acceptance && !verification) {
        verification = await verifyAcceptanceContract({
          contract: acceptanceContract,
          steps: result.steps,
          goal,
          workspaceRoot,
        });
      }
      const passed =
        result.stopReason === "completed" &&
        (verification?.passed !== false || !this.acceptance);
      if (memoryLessonIds.length && !this.memoryReadonly) {
        await recordLessonOutcomes(memoryLessonIds, passed);
      }
      if (this.memory && this.client?.embed && !this.memoryReadonly) {
        await maybeWriteLesson({
          client: this.client,
          goal,
          steps: result.steps,
          verificationPassed: verification?.passed ?? passed,
          struggleScore,
          stopReason: result.stopReason,
          embeddingModel: this.embeddingModel,
          readonly: this.memoryReadonly,
        });
      }
      return {
        ...result,
        verification,
        escalationCount: this.escalation?.escalationCount ?? 0,
        cloudUsed: this.escalation?.cloudUsed ?? false,
        memoryLessonIds,
      };
    };

    let paidSteps = 0;
    while (paidSteps < this.maxSteps) {
      const index = paidSteps + 1;
      if (signal?.aborted) {
        return finalizeRun({ text: "", stopReason: "aborted", steps, messages });
      }

      budgetPressure = this.maxSteps > 0 ? paidSteps / this.maxSteps : 0;

      if (this.acceptance) {
        const progress = await verifyAcceptanceContract({
          contract: acceptanceContract,
          steps,
          goal,
          workspaceRoot,
        });
        workOutstanding = !progress.passed;
        verifyOutstandingOnly = isVerifyOutstandingOnly(progress);
        const fingerprint = missingKey(progress.missing);
        if (!progress.passed && fingerprint) {
          if (fingerprint === lastMissingFingerprint) stuckMissingCount += 1;
          else {
            lastMissingFingerprint = fingerprint;
            stuckMissingCount = 1;
          }
        } else {
          lastMissingFingerprint = "";
          stuckMissingCount = 0;
        }
        // Cheaper than escalating: once the same unmet checks repeat, force a
        // contract-vs-plan critique that ends in a tool call.
        if (
          !contractCritiqueInjected &&
          stuckMissingCount >= 2 &&
          progress.missing?.length
        ) {
          contractCritiqueInjected = true;
          messages.push({ role: "user", content: CONTRACT_PROGRESS_CRITIQUE });
        }
      }

      if (budgetPressure >= 0.5) {
        if (planState?.steps?.length && !checkpointInjected) {
          planState = markProgress(planState, { steps });
          const checkpoint = formatCheckpoint(planState);
          if (checkpoint) {
            messages.push({ role: "user", content: checkpoint });
            const checkpointStep = {
              index,
              kind: "checkpoint",
              content: checkpoint,
              toolCalls: [],
            };
            steps.push(checkpointStep);
            this.onStep?.(checkpointStep);
            checkpointInjected = true;
          }
        }
      }

      if (
        this.planning &&
        this.replan &&
        planState &&
        replanCount < MAX_REMAINING_REPLANS &&
        paidSteps >= 1 &&
        paidSteps - lastReplanPaidSteps >= 2 &&
        !signal?.aborted
      ) {
        const state = struggleState();
        // Hollow / no-tool runs need a tool call or a stronger model, not another
        // plan revision — that is the failure mode that accepts a hollow finish.
        const struggle = computeStruggleScore({ ...state, hollowCompletion: false });
        const shouldReplan =
          struggle >= DEFAULT_ESCALATION_THRESHOLD ||
          (stuckMissingCount >= 2 && !state.hollowCompletion) ||
          repeatedCount >= MAX_REPEATED_STEPS ||
          Boolean(ambiguousEditRecoveryNudge({ steps }));
        if (shouldReplan) {
          try {
            planState = markProgress(planState, { steps });
            const checkpoint = formatCheckpoint(planState);
            const replanMessages = [...messages];
            if (checkpoint && !checkpointInjected) {
              replanMessages.push({ role: "user", content: checkpoint });
            }
            replanMessages.push({ role: "user", content: REPLAN_REMAINING_MESSAGE });
            const { message } = await chatWithRetry(this.client, {
              messages: replanMessages,
              signal,
            });
            const revised = textOf(message.content).trim();
            if (revised && isUsablePlanText(revised)) {
              if (checkpoint && !checkpointInjected) {
                messages.push({ role: "user", content: checkpoint });
                const checkpointStep = {
                  index,
                  kind: "checkpoint",
                  content: checkpoint,
                  toolCalls: [],
                };
                steps.push(checkpointStep);
                this.onStep?.(checkpointStep);
              }
              messages.push({ role: "user", content: REPLAN_REMAINING_MESSAGE });
              messages.push({ role: "assistant", content: revised });
              const replanStep = {
                index,
                kind: "plan",
                content: revised,
                toolCalls: [],
              };
              steps.push(replanStep);
              this.onStep?.(replanStep);
              applyPlanText(revised, { critique: true });
              replanCount += 1;
              checkpointInjected = false;
              stuckMissingCount = 0;
              lastMissingFingerprint = "";
              // Give the revised plan a clean runway; otherwise the same
              // repeat/edit-miss signals immediately consume the replan budget.
              repeatedCount = 0;
              repeatedKey = "";
            }
            // Cool down even when the model reply is not a usable plan, so a
            // stuck loop cannot burn the step budget on replan chat calls.
            lastReplanPaidSteps = paidSteps;
          } catch {
            // Remaining-step replan is best-effort.
          }
        }
      }

      if (this.escalation) {
        const escalated = await this.escalation.maybeEscalate(struggleState());
        if (escalated?.escalated) {
          const escStep = {
            index,
            kind: "escalation",
            content:
              escalated.kind === "intensify"
                ? `Escalated effort on ${escalated.to} (${escalated.reason})`
                : `Escalated model ${escalated.from} → ${escalated.to} (${escalated.reason})`,
            toolCalls: [],
          };
          steps.push(escStep);
          this.onStep?.(escStep);
        } else if (this.escalation.lastBlockedReason && !escalationBlockReported) {
          escalationBlockReported = true;
          const blockStep = {
            index,
            kind: "escalation",
            content: `Escalation held: ${this.escalation.lastBlockedReason}`,
            toolCalls: [],
          };
          steps.push(blockStep);
          this.onStep?.(blockStep);
        }
      }

      if (this.compaction) {
        const compacted = await compactMessages({
          client: this.client,
          messages,
          maxTokens: defaultTokenBudget(this.client),
          ...this.compaction,
          observedTokens,
        });
        if (compacted !== messages) observedTokens = 0;
        messages = compacted;
      }

      if (!nearLimitNudged && paidSteps + 1 >= this.maxSteps) {
        nearLimitNudged = true;
        messages.push({ role: "user", content: TOOL_NUDGE_NEAR_LIMIT });
      }

      const { message, raw } = await chatWithParseRecovery(
        this.client,
        {
          messages,
          tools,
          signal,
          onDelta: this.onDelta,
        },
        {
          onParseError: ({ recovery, error }) => {
            parseRecoveries += 1;
            const parseStep = {
              index,
              kind: "tool-parse-error",
              content: String(error?.message ?? "error parsing tool call"),
              toolCalls: [],
              recoveries: recovery,
            };
            steps.push(parseStep);
            this.onStep?.(parseStep);
          },
        },
      );
      totalEvalCount += raw?.eval_count ?? 0;
      const usedTokens = (raw?.prompt_eval_count ?? 0) + (raw?.eval_count ?? 0);
      if (usedTokens > 0) observedTokens = usedTokens;
      messages.push(normalizeAssistantMessage(message));

      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const thinkingOnly = toolCalls.length === 0 && isThinkingOnlyResponse(message);

      if (toolCalls.length === 0) {
        if (isEmptyAssistantResponse(message)) {
          consecutiveEmpty += 1;
          if (
            shouldFailOnEmptyResponses({
              goal,
              steps,
              consecutiveEmpty,
            })
          ) {
            const diagnostic = formatZeroTokenDiagnostic({
              totalEvalCount,
              elapsedMs: Date.now() - runStarted,
              model: this.client?.model,
              baseUrl: this.client?.baseUrl,
            });
            const text =
              synthesizeFinalAnswer({ goal, steps }) +
              (diagnostic ? `\n\n${diagnostic}` : "");
            const failStep = {
              index,
              kind: "failed",
              content: text,
              toolCalls: [],
              diagnostic,
            };
            steps.push(failStep);
            this.onStep?.(failStep);
            return finalizeRun({
              text,
              stopReason: "failed",
              steps,
              messages,
              diagnostic,
            });
          }
          const recovery = emptyResponseRecoveryNudge({ goal, steps, consecutiveEmpty });
          if (recovery) {
            messages.push({ role: "user", content: recovery });
            if (!thinkingOnly) paidSteps += 1;
            continue;
          }
        } else {
          consecutiveEmpty = 0;
        }

        const answerText = textOf(message.content);
        const nudge = finalAnswerNudge({
          goal,
          answerText,
          steps,
          nudgeCount: toolNudgeCount,
          consecutiveEmpty,
        });
        if (nudge) {
          toolNudgeCount += 1;
          messages.push({ role: "user", content: nudge });
          if (!thinkingOnly) paidSteps += 1;
          continue;
        }
        if (
          shouldFailOnEmptyResponses({
            goal,
            steps,
            consecutiveEmpty,
          }) ||
          (!String(answerText ?? "").trim() &&
            goalNeedsSubstantiveTools(goal) &&
            substantiveToolsUsed(steps).size === 0)
        ) {
          const diagnostic = formatZeroTokenDiagnostic({
            totalEvalCount,
            elapsedMs: Date.now() - runStarted,
            model: this.client?.model,
            baseUrl: this.client?.baseUrl,
          });
          const text =
            synthesizeFinalAnswer({ goal, steps }) +
            (diagnostic ? `\n\n${diagnostic}` : "");
          const failStep = {
            index,
            kind: "failed",
            content: text,
            toolCalls: [],
            diagnostic,
          };
          steps.push(failStep);
          this.onStep?.(failStep);
          return finalizeRun({
            text,
            stopReason: "failed",
            steps,
            messages,
            diagnostic,
          });
        }
        const text = String(answerText ?? "").trim() || synthesizeFinalAnswer({ goal, steps });
        // Verification gate. Bounded by its own budget so an unsatisfiable
        // contract degrades into a reported failure rather than burning every
        // remaining step.
        if (this.acceptance) {
          const verification = await verifyAcceptanceContract({
            contract: acceptanceContract,
            steps,
            goal,
            workspaceRoot,
          });
          const acceptNudge = acceptanceFailureNudge(verification);
          if (acceptNudge && acceptanceNudgeCount < maxAcceptanceNudges) {
            acceptanceNudgeCount += 1;
            messages.push({ role: "user", content: acceptNudge });
            if (!thinkingOnly) paidSteps += 1;
            continue;
          }
          if (!verification.passed && goalNeedsSubstantiveTools(goal)) {
            const failStep = {
              index,
              kind: "failed",
              content: text,
              toolCalls: [],
            };
            steps.push(failStep);
            this.onStep?.(failStep);
            return finalizeRun({
              text,
              stopReason: "failed",
              steps,
              messages,
              verification,
            });
          }
        }
        const finalStep = {
          index,
          kind: "final",
          content: text,
          toolCalls: [],
        };
        steps.push(finalStep);
        this.onStep?.(finalStep);
        return finalizeRun({
          text,
          stopReason: "completed",
          steps,
          messages,
        });
      }

      consecutiveEmpty = 0;

      const stepKey = JSON.stringify(
        toolCalls.map((c) => [c?.function?.name, c?.function?.arguments]),
      );
      repeatedCount = stepKey === repeatedKey ? repeatedCount + 1 : 0;
      repeatedKey = stepKey;
      const refuseRepeat = repeatedCount >= MAX_REPEATED_STEPS;

      const executed = [];
      for (const call of toolCalls) {
        const name = call?.function?.name ?? "";
        const args = call?.function?.arguments ?? {};
        const commandText = String(args?.command ?? args?.cmd ?? "");
        const pretestBlock = refuseRepeat
          ? null
          : mutationBlockedUntilPretest({ goal, toolName: name, steps });
        const heredocBlock =
          refuseRepeat || pretestBlock ? null : heredocRetryBlock({ toolName: name, args, steps });
        const verifyBlock =
          refuseRepeat || pretestBlock || heredocBlock
            ? null
            : redundantVerifyBlock({ goal, steps, toolName: name, args });
        let outcome;
        if (refuseRepeat) {
          outcome = refusedRepeatOutcome(
            name,
            commandText,
            repeatedToolCallMessage({ repeatedCount, goal, steps }),
          );
        } else if (pretestBlock) {
          outcome = { ok: false, error: pretestBlock };
        } else if (heredocBlock) {
          outcome = { ok: false, error: heredocBlock };
        } else if (verifyBlock) {
          outcome = isTerminalVerificationMessage(verifyBlock)
            ? verificationCompleteOutcome(verifyBlock)
            : blockedCommandOutcome(commandText, verifyBlock);
        } else {
          outcome = await this.registry.execute(name, args);
        }
        executed.push({ name, args, ...outcome });
        messages.push({
          role: "tool",
          tool_name: name,
          content: toolResultContent(outcome),
        });
      }

      const toolStep = {
        index,
        kind: "tool-calls",
        content: textOf(message.content),
        toolCalls: executed,
      };
      steps.push(toolStep);
      this.onStep?.(toolStep);

      const stopNudge = alreadyVerifiedFinishNudge({
        goal,
        steps,
        nudgeCount: toolNudgeCount,
      });
      if (stopNudge) {
        toolNudgeCount += 1;
        messages.push({ role: "user", content: stopNudge });
      } else {
        const editNudge =
          ambiguousEditRecoveryNudge({ steps }) ??
          repeatedEditMissNudge({ steps }) ??
          buildDepsInstallRerunNudge({ steps }) ??
          repeatedSearchLoopNudge({ steps }) ??
          secretHitWithoutEditNudge({ goal, steps }) ??
          deliverableDriftNudge({ goal, steps });
        if (editNudge) messages.push({ role: "user", content: editNudge });
      }
      paidSteps += 1;
    }

    // Out of steps: ask for a plain-text wrap-up (no tools offered) so the
    // caller gets a best-effort answer instead of empty text. Best-effort —
    // any failure here must not mask the max-steps outcome.
    let text = "";
    if (!signal?.aborted) {
      try {
        const wrapUp = [...messages, { role: "user", content: WRAP_UP_PROMPT }];
        const { message } = await chatWithRetry(this.client, { messages: wrapUp, signal });
        text = textOf(message.content).trim();
        if (text) {
          messages.push({ role: "user", content: WRAP_UP_PROMPT });
          messages.push({ role: "assistant", content: text });
          const step = { index: this.maxSteps + 1, kind: "final", content: text, toolCalls: [] };
          steps.push(step);
          this.onStep?.(step);
        }
      } catch {
        // keep text = ""
      }
    }
    if (!text) text = synthesizeFinalAnswer({ goal, steps });
    const diagnostic = formatZeroTokenDiagnostic({
      totalEvalCount,
      elapsedMs: Date.now() - runStarted,
      model: this.client?.model,
      baseUrl: this.client?.baseUrl,
    });
    if (diagnostic) text = `${text}\n\n${diagnostic}`;
    let verification;
    if (this.acceptance) {
      verification = await verifyAcceptanceContract({
        contract: acceptanceContract,
        steps,
        goal,
        workspaceRoot,
      });
    }
    // Unmet acceptance after the step budget is a failed run, not a completed one.
    const stopReason =
      this.acceptance &&
      verification &&
      !verification.passed &&
      goalNeedsSubstantiveTools(goal)
        ? "failed"
        : "max-steps";
    return finalizeRun({
      text: text ?? "",
      stopReason,
      steps,
      messages,
      diagnostic,
      verification,
    });
  }
}

/** Ollama 500 when the model contaminates the tool-call channel with prose. */
export function isToolCallParseError(err) {
  return (
    err?.name === "OllamaClientError" &&
    typeof err.status === "number" &&
    err.status >= 500 &&
    /error parsing tool call/i.test(String(err.message ?? ""))
  );
}

/**
 * Whether a model reply is a real plan update (numbered steps or Acceptance).
 * Plain final answers must not replace the live plan / acceptance contract.
 * @param {string} text
 * @returns {boolean}
 */
function isUsablePlanText(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return false;
  if (parsePlanSteps(trimmed).length > 0) return true;
  return /##\s*Acceptance\b/i.test(trimmed);
}

/**
 * Retry transient client failures (network unreachable, 5xx) with backoff.
 * A mid-task hiccup should not kill a run that already did real work.
 * Tool-call parse failures are not transient — {@link chatWithParseRecovery}
 * handles those with a model nudge. 4xx is not retried.
 */
const TRANSIENT_RETRY_DELAYS_MS = [500, 1500, 4000, 8000];

async function chatWithRetry(client, request) {
  // Prefer streaming when the client supports it so onDelta receives live
  // tokens; FakeClient-style stubs without chatStream keep using chat().
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
      if (err?.name !== "OllamaClientError") throw err;
      if (typeof err.status === "number" && err.status < 500) throw err;
      if (isToolCallParseError(err)) throw err;
      if (attempt >= TRANSIENT_RETRY_DELAYS_MS.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAYS_MS[attempt]));
      if (request.signal?.aborted) throw err;
    }
  }
  throw lastErr;
}

/**
 * When Ollama rejects a malformed tool call, nudge the model and retry
 * instead of aborting the whole agent run. Failed parse attempts are reported
 * via onParseError so session logs still show progress.
 *
 * @param {object} client
 * @param {object} request
 * @param {Array<object>} request.messages Mutated in place when recovering.
 * @param {Array<object>} [request.tools]
 * @param {AbortSignal} [request.signal]
 * @param {(delta: string) => void} [request.onDelta]
 * @param {{ onParseError?: (info: { recovery: number, error: Error }) => void }} [hooks]
 */
async function chatWithParseRecovery(client, request, hooks = {}) {
  const { messages, tools, signal, onDelta } = request;
  let recoveries = 0;
  while (true) {
    try {
      return await chatWithRetry(client, { messages, tools, signal, onDelta });
    } catch (err) {
      if (signal?.aborted || err?.name === "AbortError") throw err;
      if (!isToolCallParseError(err) || recoveries >= MAX_TOOL_CALL_PARSE_RECOVERIES) {
        throw err;
      }
      recoveries += 1;
      hooks.onParseError?.({ recovery: recoveries, error: err });
      messages.push({ role: "user", content: TOOL_CALL_PARSE_NUDGE });
    }
  }
}

/**
 * Keep only the fields Ollama understands when the assistant message is
 * echoed back on the next round-trip.
 */
function normalizeAssistantMessage(message) {
  const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  const normalized = {
    role: "assistant",
    content: hasTools ? "" : textOf(message.content),
  };
  if (hasTools) normalized.tool_calls = message.tool_calls;
  if (message.thinking) normalized.thinking = message.thinking;
  return normalized;
}

function textOf(content) {
  return typeof content === "string" ? content : "";
}

function refusedRepeatOutcome(name, commandText, message) {
  if (name === "run_command" && isTerminalVerificationMessage(message)) {
    return verificationCompleteOutcome(message);
  }
  if (name === "run_command") return blockedCommandOutcome(commandText, message);
  return { ok: false, error: message };
}

/** Tool results go back to the model as a string (JSON for structured data). */
function toolResultContent(outcome) {
  if (!outcome.ok) return `ERROR: ${outcome.error}`;
  const { result } = outcome;
  if (result === undefined || result === null) return "(no output)";
  if (typeof result === "object") {
    if (result.verificationComplete) {
      return [
        "status: verification already succeeded",
        "verificationComplete: true",
        "exitCode: 0",
        `note: ${result.note ?? ""}`.trim(),
      ].join("\n");
    }
    if (String(result.status ?? "") === "blocked") {
      return [
        "status: blocked",
        `command: ${result.command ?? ""}`,
        `note: ${result.note ?? ""}`.trim(),
      ].join("\n");
    }
    const code = result.exitCode ?? result.exitCode;
    const status = result.status;
    if (code != null || status != null) {
      const failed = Number(code) !== 0 || result.timedOut;
      const lines = [
        `status: ${status ?? (Number(code) === 0 ? "success" : `FAILED with exit code ${code}`)}`,
        `exitCode: ${code ?? ""}`,
      ];
      if (result.timedOut) lines.push("timedOut: true");
      if (failed) {
        lines.push("FAILED: treat this as a real command failure even though the tool call succeeded.");
      }
      const compilerErrors = extractCompilerDiagnostics(
        `${result.stderr ?? ""}\n${result.stdout ?? ""}`,
      );
      if (compilerErrors) lines.push(`compilerErrors:\n${compilerErrors}`);
      if (failed) {
        lines.push(`stderr:\n${String(result.stderr ?? "").length ? result.stderr : "(empty)"}`);
        lines.push(`stdout:\n${String(result.stdout ?? "").length ? result.stdout : "(empty)"}`);
      } else {
        if (result.stdout != null && String(result.stdout).length) {
          lines.push(`stdout:\n${result.stdout}`);
        } else {
          lines.push("stdout: (empty)");
        }
        if (result.stderr) lines.push(`stderr:\n${result.stderr}`);
      }
      if (result.note) lines.push(`note: ${result.note}`);
      return lines.join("\n");
    }
  }
  return typeof result === "string" ? result : JSON.stringify(result);
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

/** First turn of a conversation — no prior user/assistant/tool messages in history. */
function isFreshTurn(history) {
  if (!history?.length) return true;
  return !history.some((m) => m.role === "user" || m.role === "assistant" || m.role === "tool");
}
