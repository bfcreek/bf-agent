import assert from "node:assert/strict";
import { test } from "node:test";

import {
  alreadyVerifiedFinishNudge,
  ambiguousEditRecoveryNudge,
  commandExitCode,
  completionVerifyNudge,
  detectTaskHints,
  emptyFinalAnswerNudge,
  extractCompilerDiagnostics,
  extractNamedDeliverables,
  extractNamedNodeCommands,
  extractSmokeSubcommands,
  finalAnswerNudge,
  formatExplicitGoals,
  formatTaskConstraints,
  hasSuccessfulTestRun,
  isDiagnosticCommand,
  isFollowUpGoal,
  isHarborStyleGoal,
  isSuccessfulTestCall,
  looksVacuousCliStdout,
  missingRequiredVerification,
  PLANNING_USER_MESSAGE,
  redundantVerifyBlock,
  isComplexGoal,
  shouldPlanGoal,
  isGptOssModel,
  mutationBlockedUntilPretest,
  mutatedBeforeTestRun,
  prematureFinalNudge,
  resolveThinkSetting,
  repeatedEditMissNudge,
  synthesizeFinalAnswer,
  TOOL_NUDGE_ALREADY_VERIFIED,
  TOOL_NUDGE_AMBIGUOUS_EDIT,
  TOOL_NUDGE_EDIT_MISS_REWRITE,
  TOOL_NUDGE_DELIVERABLE,
  TOOL_NUDGE_DELIVERABLE_VERIFY,
  TOOL_NUDGE_EMPTY_AFTER_TOOLS,
  TOOL_NUDGE_EMPTY_ANSWER,
  TOOL_NUDGE_EMPTY_VALUE,
  TOOL_NUDGE_FIX_IMPL,
  TOOL_NUDGE_FOLLOW_UP,
  TOOL_NUDGE_MERGE_CONFLICT,
  TOOL_NUDGE_READ_IMPL,
  TOOL_NUDGE_SECRET_HIT,
  secretHitWithoutEditNudge,
} from "../src/prompt-enhancements.mjs";

test("detectTaskHints matches test-fix and debug goals", () => {
  const hints = detectTaskHints("fix the failing test in auth.spec.mjs");
  assert.ok(hints.some((h) => h.id === "test-fix"));
  assert.match(hints.find((h) => h.id === "test-fix").constraint, /Mandatory first step/);
  assert.match(hints.find((h) => h.id === "test-fix").constraint, /enclosing def\/class|replace_all/);

  const debug = detectTaskHints("debug why the login endpoint is not working");
  assert.ok(debug.some((h) => h.id === "debug"));
});

test("formatTaskConstraints renders a focus block", () => {
  const text = formatTaskConstraints([{ id: "debug", constraint: "Reproduce first." }]);
  assert.match(text, /## Task focus/);
  assert.match(text, /Reproduce first/);
});

test("formatExplicitGoals surfaces deliverables, verification, and fallbacks", () => {
  const artifact = formatExplicitGoals(
    "Write the output fasta file titled primers.fasta from sequences.fasta.",
  );
  assert.match(artifact, /## Goals \(explicit outcomes\)/);
  assert.match(artifact, /primers\.fasta/);

  const verify = formatExplicitGoals("Create greet.mjs and run node test.mjs until it passes.");
  assert.match(verify, /node test\.mjs/);

  const fallback = formatExplicitGoals("create the shell for an electron app");
  assert.match(fallback, /^## Goals\n- Before acting, state 2–5 explicit outcomes/);

  assert.equal(formatExplicitGoals(""), "");
});

test("shouldPlanGoal runs for short create goals, not only long ones", () => {
  assert.equal(shouldPlanGoal(""), false);
  assert.equal(shouldPlanGoal("hi"), true);
  assert.equal(shouldPlanGoal("create the shell for an electron app"), true);
  assert.equal(
    isComplexGoal("implement a new feature and then run the tests to verify"),
    true,
  );
  assert.equal(
    isComplexGoal(
      "please read the readme and summarize the architecture for this project in detail",
    ),
    true,
  );
});

test("isSimpleReadAnswerGoal skips planning for read-and-answer tasks", () => {
  const goal =
    "Read README.md and answer: what port does the service listen on? Reply with just the number.";
  assert.equal(shouldPlanGoal(goal), false);
  assert.equal(isComplexGoal(goal), false);
  assert.equal(shouldPlanGoal("Reply with just ok."), false);
});

test("prematureFinalNudge fires when action goals finish without tools", () => {
  assert.ok(
    prematureFinalNudge({
      goal: "Create greet.mjs and run test.mjs",
      answerText: "done",
      steps: [],
      nudgeCount: 0,
    }),
  );
});

test("prematureFinalNudge allows completion after substantive tools were used", () => {
  assert.equal(
    prematureFinalNudge({
      goal: "Create greet.mjs",
      answerText: "done",
      steps: [{ toolCalls: [{ name: "write_file", ok: true }] }],
      nudgeCount: 0,
    }),
    null,
  );
});

test("emptyFinalAnswerNudge blocks empty replies after search on path questions", () => {
  const goal =
    "Which file defines the function compute_tax? Reply with the path relative to the workspace root only.";
  assert.equal(
    emptyFinalAnswerNudge({
      goal,
      answerText: "",
      steps: [{ toolCalls: [{ name: "grep_search", ok: true }] }],
      nudgeCount: 0,
    }),
    TOOL_NUDGE_EMPTY_VALUE,
  );
  assert.equal(
    emptyFinalAnswerNudge({
      goal: "Read config.json and answer: what port does the app use? Reply with just the number.",
      answerText: "",
      steps: [{ toolCalls: [{ name: "read_file", ok: true }] }],
      nudgeCount: 0,
    }),
    TOOL_NUDGE_EMPTY_VALUE,
  );
  assert.equal(
    emptyFinalAnswerNudge({
      goal: "Create greet.mjs",
      answerText: "",
      steps: [{ toolCalls: [{ name: "write_file", ok: true }] }],
      nudgeCount: 0,
    }),
    TOOL_NUDGE_EMPTY_AFTER_TOOLS,
  );
  assert.equal(
    emptyFinalAnswerNudge({
      goal: "Which file defines compute_tax? Reply with the path relative to the workspace root only.",
      answerText: "",
      steps: [],
      nudgeCount: 0,
    }),
    TOOL_NUDGE_EMPTY_ANSWER,
  );
  assert.equal(
    emptyFinalAnswerNudge({
      goal,
      answerText: "lib/tax.py",
      steps: [{ toolCalls: [{ name: "grep_search", ok: true }] }],
      nudgeCount: 0,
    }),
    null,
  );
});

test("extractCompilerDiagnostics lists CS error lines", () => {
  const text = [
    "Build succeeded.",
    "Program.cs(12,17): error CS0136: A local or parameter named 'args' cannot be declared",
    "Program.cs(40,13): error CS0165: Use of unassigned local variable 'threshold'",
    "    0 Warning(s)",
  ].join("\n");
  const out = extractCompilerDiagnostics(text);
  assert.match(out, /CS0136/);
  assert.match(out, /CS0165/);
  assert.equal(extractCompilerDiagnostics("ok"), "");
});

test("detectTaskHints matches config-edit goals", () => {
  const hints = detectTaskHints('In config.json change "debug" to true.');
  assert.ok(hints.some((h) => h.id === "config-edit"));
});

test("detectTaskHints matches path-answer and test-verify goals", () => {
  const pathGoal =
    "Which file exports computeTax? Reply with the path relative to the workspace root only.";
  assert.ok(detectTaskHints(pathGoal).some((h) => h.id === "path-answer"));
  assert.ok(detectTaskHints(pathGoal).some((h) => h.id === "search"));
  assert.match(detectTaskHints(pathGoal).find((h) => h.id === "path-answer").constraint, /non-empty|DEFINES/i);

  const testGoal =
    "Create test.mjs and run test.mjs with node and confirm it passes.";
  assert.ok(detectTaskHints(testGoal).some((h) => h.id === "test-verify"));

  const pyGoal = "Create test.py and run test.py with python and confirm it passes.";
  assert.ok(detectTaskHints(pyGoal).some((h) => h.id === "test-verify"));

  const csGoal = "Fix the bugs, then run `dotnet run` and confirm it passes.";
  assert.ok(detectTaskHints(csGoal).some((h) => h.id === "test-verify"));
});

test("detectTaskHints matches csharp JSON CLI goals", () => {
  const goal =
    "data/users.json contains users. This workspace has App.csproj. Make `dotnet run -- data/users.json --active` print only active users as a JSON array to stdout.";
  const hints = detectTaskHints(goal);
  assert.ok(hints.some((h) => h.id === "csharp-json"));
  assert.match(hints.find((h) => h.id === "csharp-json").constraint, /PropertyNameCaseInsensitive/);
  assert.match(hints.find((h) => h.id === "csharp-json").constraint, /CS0136|cliArgs/);
});

test("detectTaskHints matches python JSON CLI goals and not csharp-json", () => {
  const goal =
    "data/users.json contains users. Create filter.py: `python filter.py data/users.json --active` prints only active users as a JSON array to stdout.";
  const hints = detectTaskHints(goal);
  assert.ok(hints.some((h) => h.id === "python-json"));
  assert.ok(!hints.some((h) => h.id === "csharp-json"));
  assert.match(hints.find((h) => h.id === "python-json").constraint, /named flags|only flags/i);
});

test("detectTaskHints matches python same-name import goals", () => {
  const goal =
    "Create greet.py that defines greet(name). Create test.py and run python test.py.";
  const hints = detectTaskHints(goal);
  assert.ok(hints.some((h) => h.id === "python-import"));
  assert.match(hints.find((h) => h.id === "python-import").constraint, /from foo import foo/i);
});

test("detectTaskHints matches csharp CLI catalog goals", () => {
  const goal =
    "Build a C# catalog CLI. Commands: `dotnet run -- list`, find, total, low, category.";
  const hints = detectTaskHints(goal);
  assert.ok(hints.some((h) => h.id === "csharp-cli"));
  assert.match(hints.find((h) => h.id === "csharp-cli").constraint, /smoke-test/i);
  assert.match(hints.find((h) => h.id === "csharp-cli").constraint, /PropertyNameCaseInsensitive/);
  assert.match(hints.find((h) => h.id === "csharp-cli").constraint, /inclusive|qty\s*<=/i);
  assert.match(hints.find((h) => h.id === "csharp-cli").constraint, /CS0136|cliArgs/);
  assert.match(hints.find((h) => h.id === "csharp-cli").constraint, /CS0165|TryParse/);
});

test("detectTaskHints matches csharp test-project goals and not catalog CLI", () => {
  const invoice = detectTaskHints(
    "Create a C# invoice calculator from scratch with a separate test project. Run dotnet test, then dotnet run --project Invoice/Invoice.csproj -- add Widget 2 5.",
  );
  assert.ok(invoice.some((h) => h.id === "csharp-tests"));
  assert.match(invoice.find((h) => h.id === "csharp-tests").constraint, /shared app validation|spawn the CLI/);
  assert.match(invoice.find((h) => h.id === "csharp-tests").constraint, /\.sln|\.slnx/);
  assert.equal(invoice.some((h) => h.id === "csharp-cli"), false);
});

test("detectTaskHints matches rename, CLI, server, and extract-shared goals", () => {
  const rename = detectTaskHints(
    "handler is misspelled handeler in server.mjs. Fix the typo.",
  );
  assert.ok(rename.some((h) => h.id === "rename-typo"));

  const cli = detectTaskHints(
    "Create filter.mjs: node filter.mjs data/users.json --active prints active users.",
  );
  assert.ok(cli.some((h) => h.id === "cli-module"));

  const server = detectTaskHints(
    "Create server.mjs that listens on port 0 with GET /health.",
  );
  assert.ok(server.some((h) => h.id === "http-server"));
  assert.match(server.find((h) => h.id === "http-server").constraint, /node:http|request factory/i);
  assert.match(server.find((h) => h.id === "http-server").constraint, /only the requested route|import\.meta/i);

  const extract = detectTaskHints(
    "Extract shared slugify into src/slugify.mjs and update imports.",
  );
  assert.ok(extract.some((h) => h.id === "extract-shared"));
});

test("detectTaskHints matches shell-script goals and not JS modules", () => {
  const script = detectTaskHints("Create a script that prints hello");
  assert.ok(script.some((h) => h.id === "shell-script"));
  assert.match(script.find((h) => h.id === "shell-script").constraint, /\.ps1|PowerShell/);

  const bash = detectTaskHints("Write a bash script named hello.sh");
  assert.ok(bash.some((h) => h.id === "shell-script"));

  const js = detectTaskHints(
    "Create greet.mjs that exports function greet(name) returning Hello.",
  );
  assert.equal(js.some((h) => h.id === "shell-script"), false);
});

test("mutationBlockedUntilPretest blocks edits before a test run", () => {
  const goal = "Run node test.mjs — it fails. Fix the bugs so all tests pass.";
  assert.match(
    mutationBlockedUntilPretest({
      goal,
      toolName: "edit_file",
      steps: [],
    }) ?? "",
    /Blocked/,
  );
  assert.equal(
    mutationBlockedUntilPretest({
      goal,
      toolName: "edit_file",
      steps: [
        {
          toolCalls: [
            { name: "run_command", args: { command: "node test.mjs" }, ok: true, result: { exitCode: 1 } },
          ],
        },
      ],
    }),
    null,
  );
  assert.equal(
    mutationBlockedUntilPretest({ goal, toolName: "read_file", steps: [] }),
    null,
  );
});

test("completionVerifyNudge requires post-fix verify for test-fix goals", () => {
  const goal =
    "Run node test.mjs — it fails because of bugs. Fix the bugs so all tests pass, then run test.mjs again.";
  const nudge = completionVerifyNudge({
    goal,
    answerText: "Fixed and all tests passed.",
    steps: [
      {
        toolCalls: [
          { name: "run_command", args: { command: "node test.mjs" }, ok: true, result: { exitCode: 1 } },
          {
            name: "edit_file",
            args: { path: "lib/math.mjs", old_string: "a", new_string: "b" },
            ok: true,
          },
        ],
      },
    ],
    nudgeCount: 0,
  });
  assert.ok(nudge);
  assert.match(nudge, /verification|run_command/i);
});

test("completionVerifyNudge allows finish after successful post-fix test run", () => {
  const goal =
    "Run node test.mjs — it fails. Fix bugs, then run test.mjs again to confirm.";
  assert.equal(
    completionVerifyNudge({
      goal,
      answerText: "All tests passed.",
      steps: [
        {
          toolCalls: [
            { name: "run_command", args: { command: "node test.mjs" }, ok: true, result: { exitCode: 1 } },
            { name: "edit_file", args: { path: "x.mjs", old_string: "a", new_string: "b" }, ok: true },
            { name: "run_command", args: { command: "node test.mjs" }, ok: true, result: { exitCode: 0 } },
          ],
        },
      ],
      nudgeCount: 0,
    }),
    null,
  );
});

test("finalAnswerNudge prefers premature tool nudge over verify", () => {
  const msg = finalAnswerNudge({
    goal: "Create greet.mjs and run node test.mjs",
    answerText: "done",
    steps: [],
    nudgeCount: 0,
  });
  assert.match(msg, /without calling any tools/);
});

test("mutatedBeforeTestRun detects edit-before-reproduce", () => {
  assert.equal(
    mutatedBeforeTestRun([
      { name: "edit_file", ok: true },
      { name: "run_command", ok: true },
    ]),
    true,
  );
  assert.equal(
    mutatedBeforeTestRun([
      { name: "run_command", ok: true },
      { name: "edit_file", ok: true },
    ]),
    false,
  );
});

test("extractNamedNodeCommands finds CLI invocations in the goal", () => {
  const cmds = extractNamedNodeCommands(
    "Create filter.mjs: node filter.mjs data/users.json --active prints JSON.",
  );
  assert.ok(cmds.some((c) => /filter\.mjs/.test(c)));

  const py = extractNamedNodeCommands(
    "Create filter.py: python filter.py data/users.json --active prints JSON.",
  );
  assert.ok(py.some((c) => /filter\.py/.test(c)));

  const cs = extractNamedNodeCommands("Make `dotnet run -- data/users.json --active` print JSON.");
  assert.ok(cs.some((c) => /dotnet\s+run/.test(c)));
});

test("isGptOssModel recognizes gpt-oss variants", () => {
  assert.equal(isGptOssModel("gpt-oss:20b"), true);
  assert.equal(isGptOssModel("qwen3:14b"), false);
});

test("resolveThinkSetting omits think when disabled or unsupported", () => {
  assert.equal(resolveThinkSetting({ think: false, thinkingCapable: true }), undefined);
  assert.equal(resolveThinkSetting({ think: "auto", thinkingCapable: false }), undefined);
});

test("resolveThinkSetting enables boolean think for standard thinking models", () => {
  assert.equal(
    resolveThinkSetting({ think: "auto", thinkingCapable: true, model: "qwen3:14b", paramsB: 14 }),
    true,
  );
});

test("resolveThinkSetting uses high for small gpt-oss models in auto mode", () => {
  assert.equal(
    resolveThinkSetting({ think: "auto", thinkingCapable: true, model: "gpt-oss:20b", paramsB: 8 }),
    "high",
  );
  assert.equal(
    resolveThinkSetting({ think: "auto", thinkingCapable: true, model: "gpt-oss:120b", paramsB: 120 }),
    "medium",
  );
});

test("resolveThinkSetting passes explicit levels through", () => {
  assert.equal(resolveThinkSetting({ think: "max", thinkingCapable: true }), "max");
});

test("commandExitCode reads exitCode, status, and formatted tool text", () => {
  assert.equal(commandExitCode({ exitCode: 0, status: "success" }), 0);
  assert.equal(commandExitCode({ exitCode: 1, status: "FAILED with exit code 1" }), 1);
  assert.equal(commandExitCode({ status: "success" }), 0);
  assert.equal(commandExitCode("status: success\nexitCode: 0"), 0);
  assert.equal(commandExitCode("status: FAILED with exit code 2\nexitCode: 2"), 2);
  assert.equal(commandExitCode(null), null);
});

test("hasSuccessfulTestRun requires exit 0, not merely ok:true", () => {
  const pass = [
    {
      name: "run_command",
      ok: true,
      args: { command: "node test.mjs" },
      result: { status: "success", exitCode: 0 },
    },
  ];
  const fail = [
    {
      name: "run_command",
      ok: true,
      args: { command: "node test.mjs" },
      result: { status: "FAILED with exit code 1", exitCode: 1 },
    },
  ];
  assert.equal(hasSuccessfulTestRun(pass), true);
  assert.equal(hasSuccessfulTestRun(fail), false);
});

test("alreadyVerifiedFinishNudge fires after a passing test run", () => {
  const goal =
    "Create greet.mjs and a test.mjs. Run node test.mjs until it passes.";
  const steps = [
    {
      kind: "tool-calls",
      toolCalls: [
        {
          name: "run_command",
          ok: true,
          args: { command: "node test.mjs" },
          result: { status: "success", exitCode: 0 },
        },
      ],
    },
  ];
  assert.equal(
    alreadyVerifiedFinishNudge({ goal, steps, nudgeCount: 0 }),
    TOOL_NUDGE_ALREADY_VERIFIED,
  );
  assert.equal(
    alreadyVerifiedFinishNudge({
      goal,
      steps: [
        {
          kind: "tool-calls",
          toolCalls: [
            {
              name: "run_command",
              ok: true,
              args: { command: "node test.mjs" },
              result: { status: "FAILED with exit code 1", exitCode: 1 },
            },
          ],
        },
      ],
      nudgeCount: 0,
    }),
    null,
  );
});

test("alreadyVerifiedFinishNudge stays off when the last run_command failed", () => {
  const goal =
    "Create greet.mjs and a test.mjs. Run node test.mjs until it passes.";
  const steps = [
    {
      kind: "tool-calls",
      toolCalls: [
        {
          name: "run_command",
          ok: true,
          args: { command: "node test.mjs" },
          result: { status: "success", exitCode: 0 },
        },
      ],
    },
    {
      kind: "tool-calls",
      toolCalls: [
        {
          name: "run_command",
          ok: true,
          args: { command: "node test.mjs" },
          result: { status: "FAILED with exit code 1", exitCode: 1, stdout: "boom" },
        },
      ],
    },
  ];
  assert.equal(alreadyVerifiedFinishNudge({ goal, steps, nudgeCount: 0 }), null);
});

test("redundantVerifyBlock refuses extra tests and diagnostics after a pass", () => {
  const steps = [
    {
      kind: "tool-calls",
      toolCalls: [
        {
          name: "run_command",
          ok: true,
          args: { command: "node test.mjs" },
          result: { status: "success", exitCode: 0 },
        },
      ],
    },
  ];
  assert.equal(
    redundantVerifyBlock({
      steps,
      toolName: "run_command",
      args: { command: "node test.mjs" },
    }),
    TOOL_NUDGE_ALREADY_VERIFIED,
  );
  const diagnosticBlock = redundantVerifyBlock({
    steps,
    toolName: "run_command",
    args: { command: "node -v" },
  });
  assert.match(diagnosticBlock ?? "", /status: blocked|diagnostic/i);
  assert.doesNotMatch(diagnosticBlock ?? "", /verificationComplete:\s*true/);
  assert.match(diagnosticBlock ?? "", /node -v/);
  assert.equal(
    redundantVerifyBlock({
      steps: [
        ...steps,
        {
          kind: "tool-calls",
          toolCalls: [{ name: "write_file", ok: true, args: { path: "x.mjs" } }],
        },
      ],
      toolName: "run_command",
      args: { command: "node test.mjs" },
    }),
    null,
  );
});

test("completionVerifyNudge requires reading the impl when tests already pass", () => {
  const goal =
    "Run python test.py — it fails because of bugs in mathops.py. Fix the bugs so all tests pass.";
  const steps = [
    {
      kind: "tool-calls",
      toolCalls: [
        {
          name: "run_command",
          ok: true,
          args: { command: "python test.py" },
          result: { status: "success", exitCode: 0 },
        },
      ],
    },
  ];
  assert.equal(
    completionVerifyNudge({
      goal,
      answerText: "All tests passed.",
      steps,
      nudgeCount: 0,
    }),
    TOOL_NUDGE_READ_IMPL,
  );
  assert.equal(alreadyVerifiedFinishNudge({ goal, steps, nudgeCount: 0 }), null);
});

test("completionVerifyNudge requires an implementation edit after a failed pretest", () => {
  const goal =
    "Run python test.py — it fails because of bugs in mathops.py. Fix the bugs so all tests pass.";
  const steps = [
    {
      kind: "tool-calls",
      toolCalls: [
        {
          name: "run_command",
          ok: true,
          args: { command: "python test.py" },
          result: { status: "FAILED", exitCode: 1 },
        },
      ],
    },
  ];
  assert.equal(
    completionVerifyNudge({
      goal,
      answerText: "Looks fine.",
      steps,
      nudgeCount: 0,
    }),
    TOOL_NUDGE_FIX_IMPL,
  );
});

test("completionVerifyNudge allows finish when tests already pass and the impl was read", () => {
  const goal =
    "Run python test.py — it fails because of bugs in mathops.py. Fix the bugs so all tests pass.";
  const steps = [
    {
      kind: "tool-calls",
      toolCalls: [
        {
          name: "run_command",
          ok: true,
          args: { command: "python test.py" },
          result: { status: "success", exitCode: 0 },
        },
        {
          name: "read_file",
          ok: true,
          args: { path: "mathops.py" },
          result: "def add(a, b): return a + b\n",
        },
      ],
    },
  ];
  assert.equal(
    completionVerifyNudge({
      goal,
      answerText: "Tests already passed; mathops.py matches the assertions.",
      steps,
      nudgeCount: 0,
    }),
    null,
  );
});

test("redundantVerifyBlock still allows a named non-test CLI after tests pass", () => {
  const goal = "Create summarize.mjs. Run node test.mjs, then node summarize.mjs data.csv.";
  const steps = [
    {
      kind: "tool-calls",
      toolCalls: [
        {
          name: "run_command",
          ok: true,
          args: { command: "node test.mjs" },
          result: { status: "success", exitCode: 0 },
        },
      ],
    },
  ];
  assert.equal(
    redundantVerifyBlock({
      goal,
      steps,
      toolName: "run_command",
      args: { command: "node summarize.mjs data.csv" },
    }),
    null,
  );
  assert.match(
    redundantVerifyBlock({
      goal,
      steps,
      toolName: "run_command",
      args: { command: "node test.mjs" },
    }) ?? "",
    /already exited 0|still required|summarize/i,
  );
});

test("looksVacuousCliStdout flags empty JSON and qty=0 catalog rows", () => {
  assert.equal(looksVacuousCliStdout("[]"), true);
  assert.equal(looksVacuousCliStdout("", "node test.mjs"), false);
  assert.equal(looksVacuousCliStdout("", "dotnet run -- list"), true);
  assert.equal(looksVacuousCliStdout("qty=0", "dotnet run -- list"), true);
  assert.equal(
    looksVacuousCliStdout("WID-1  Widget  qty=10  $2.50", "dotnet run -- list"),
    false,
  );
});

test("isSuccessfulTestCall rejects vacuous catalog list stdout", () => {
  const vacuous = {
    name: "run_command",
    ok: true,
    args: { command: "dotnet run -- list" },
    result: { status: "success", exitCode: 0, stdout: "qty=0\n" },
  };
  const real = {
    name: "run_command",
    ok: true,
    args: { command: "dotnet run -- list" },
    result: { status: "success", exitCode: 0, stdout: "WID-1  Widget  qty=10  $2.50\n" },
  };
  assert.equal(isSuccessfulTestCall(vacuous), false);
  assert.equal(hasSuccessfulTestRun([vacuous]), false);
  assert.equal(isSuccessfulTestCall(real), true);
});

test("alreadyVerifiedFinishNudge stays off after vacuous catalog list", () => {
  const goal =
    "Build a C# catalog CLI. Commands: `dotnet run -- list`, find, total, low, category.";
  const vacuousSteps = [
    {
      kind: "tool-calls",
      toolCalls: [
        {
          name: "run_command",
          ok: true,
          args: { command: "dotnet run -- list" },
          result: { status: "success", exitCode: 0, stdout: "qty=0\n" },
        },
      ],
    },
  ];
  assert.equal(alreadyVerifiedFinishNudge({ goal, steps: vacuousSteps, nudgeCount: 0 }), null);

  const listOnly = [
    {
      kind: "tool-calls",
      toolCalls: [
        {
          name: "run_command",
          ok: true,
          args: { command: "dotnet run -- list" },
          result: { status: "success", exitCode: 0, stdout: "WID-1  Widget  qty=10  $2.50\n" },
        },
      ],
    },
  ];
  assert.equal(
    alreadyVerifiedFinishNudge({ goal, steps: listOnly, nudgeCount: 0 }),
    null,
    "must not finish after only list when other catalog commands remain",
  );

  const allSmoke = [
    {
      kind: "tool-calls",
      toolCalls: ["list", "find", "total", "low", "category"].map((sub) => ({
        name: "run_command",
        ok: true,
        args: { command: `dotnet run -- ${sub}` },
        result: { status: "success", exitCode: 0, stdout: "WID-1  Widget  qty=10  $2.50\n" },
      })),
    },
  ];
  assert.equal(
    alreadyVerifiedFinishNudge({ goal, steps: allSmoke, nudgeCount: 0 }),
    TOOL_NUDGE_ALREADY_VERIFIED,
  );
});

test("ambiguousEditRecoveryNudge fires after an ambiguous edit_file error", () => {
  assert.equal(
    ambiguousEditRecoveryNudge({
      steps: [
        {
          toolCalls: [
            {
              name: "edit_file",
              ok: false,
              error: "old_string appears 2 times; include the enclosing function",
            },
          ],
        },
      ],
    }),
    TOOL_NUDGE_AMBIGUOUS_EDIT,
  );
  assert.equal(
    ambiguousEditRecoveryNudge({
      steps: [{ toolCalls: [{ name: "edit_file", ok: true, result: { replacements: 1 } }] }],
    }),
    null,
  );
  assert.match(PLANNING_USER_MESSAGE, /Goals section first|explicit outcomes/i);
  assert.match(PLANNING_USER_MESSAGE, /unique per-function edit|ping-pong/i);
  assert.match(PLANNING_USER_MESSAGE, /non-empty final answer/);
  assert.match(PLANNING_USER_MESSAGE, /CS0136|canonical fix/);
  assert.match(PLANNING_USER_MESSAGE, /build-from-source|apt-get --version/);
  assert.match(PLANNING_USER_MESSAGE, /Harbor \/ Terminal-Bench|named binaries/);
  assert.match(PLANNING_USER_MESSAGE, /filter\.py not app\/filter\.py|workspace-relative/i);
  assert.match(PLANNING_USER_MESSAGE, /git merge\/conflict|do not stop after only inspecting/i);
});

test("detectTaskHints matches sanitization, proto, and numeric-artifact goals", () => {
  const xss = detectTaskHints("Write /app/filter.py to strip javascript and XSS from HTML");
  assert.ok(xss.some((h) => h.id === "html-sanitize"));
  const proto = detectTaskHints("Implement a gRPC service with a Set(key, a value (int)) RPC");
  assert.ok(proto.some((h) => h.id === "rpc-proto"));
  const fit = detectTaskHints("Fit Raman peaks and write results.json with G and 2D gamma");
  assert.ok(fit.some((h) => h.id === "numeric-artifact"));
  const pkg = detectTaskHints("Must use the MTEB package revision named in the README");
  assert.ok(pkg.some((h) => h.id === "pinned-package"));
  const re = detectTaskHints("Reverse engineer the mystery ELF with objdump and recreate path tracing");
  assert.ok(re.some((h) => h.id === "reverse-engineer"));
  const sql = detectTaskHints("Recover rows from a truncated sqlite database into recover.json");
  assert.ok(sql.some((h) => h.id === "sqlite-carve"));
});

test("repeatedEditMissNudge fires after two old_string misses on the same file", () => {
  const miss = {
    name: "edit_file",
    ok: false,
    args: { path: "gc.c" },
    error: "old_string was not found in the file",
  };
  assert.equal(
    repeatedEditMissNudge({
      steps: [{ toolCalls: [miss] }, { toolCalls: [miss] }],
    }),
    TOOL_NUDGE_EDIT_MISS_REWRITE,
  );
  assert.equal(
    repeatedEditMissNudge({
      steps: [{ toolCalls: [{ ...miss, ok: true }] }],
    }),
    null,
  );
});

test("extractSmokeSubcommands reads slash lists and catalog command lists", () => {
  const kanban =
    "Build a C# kanban CLI. Commands, invoked as `dotnet run -- <args>`: `add <col> <title>`. Run `dotnet build` and smoke-test add / list / move / find / done plus one invalid move.";
  const smoke = extractSmokeSubcommands(kanban);
  for (const sub of ["add", "list", "move", "find", "done"]) {
    assert.ok(smoke.includes(sub), `expected ${sub} in ${smoke.join(",")}`);
  }

  const catalog =
    "Build a C# catalog CLI. Commands: `dotnet run -- list`, find, total, low, category.";
  const cats = extractSmokeSubcommands(catalog);
  for (const sub of ["list", "find", "total", "low", "category"]) {
    assert.ok(cats.includes(sub), `expected ${sub} in ${cats.join(",")}`);
  }
});

test("follow-up goals require edits before completion", () => {
  const goal = [
    "The workspace already contains a working ticket CLI (`dotnet run -- ...`).",
    "This is a new request: do not rewrite from scratch.",
    "Add `assign <id> <who>` and `board`. Smoke-test original commands plus board / assign.",
  ].join(" ");
  assert.equal(isFollowUpGoal(goal), true);
  assert.ok(detectTaskHints(goal).some((h) => h.id === "follow-up"));
  assert.ok(detectTaskHints(goal).some((h) => h.id === "smoke-cli"));

  const readOnly = [
    {
      kind: "tool-calls",
      toolCalls: [
        { name: "read_file", ok: true, args: { path: "Program.cs" } },
        {
          name: "run_command",
          ok: true,
          args: { command: "dotnet build" },
          result: { status: "success", exitCode: 0, stdout: "Build succeeded." },
        },
        {
          name: "run_command",
          ok: true,
          args: { command: "dotnet run -- list" },
          result: { status: "success", exitCode: 0, stdout: "1  open  Login\n" },
        },
      ],
    },
  ];
  assert.ok(
    missingRequiredVerification(goal, readOnly.flatMap((s) => s.toolCalls)).some((item) =>
      /implement/i.test(item),
    ),
  );
  assert.equal(alreadyVerifiedFinishNudge({ goal, steps: readOnly, nudgeCount: 0 }), null);
  assert.equal(
    completionVerifyNudge({
      goal,
      answerText: "I stopped as requested. No files were edited.",
      steps: readOnly,
      nudgeCount: 0,
    }),
    TOOL_NUDGE_FOLLOW_UP,
  );
});

test("redundantVerifyBlock allows a different smoke command after the first succeeds", () => {
  const goal =
    "Build a C# kanban CLI. Run `dotnet build` and smoke-test add / list / move / find / done plus one invalid move.";
  const steps = [
    {
      kind: "tool-calls",
      toolCalls: [
        {
          name: "run_command",
          ok: true,
          args: { command: "dotnet build" },
          result: { status: "success", exitCode: 0, stdout: "Build succeeded." },
        },
        {
          name: "run_command",
          ok: true,
          args: { command: "dotnet run -- add todo Task" },
          result: { status: "success", exitCode: 0, stdout: "added: 1\n" },
        },
      ],
    },
  ];
  assert.equal(
    redundantVerifyBlock({
      goal,
      steps,
      toolName: "run_command",
      args: { command: "dotnet run -- list" },
    }),
    null,
  );
  assert.equal(
    redundantVerifyBlock({
      goal,
      steps,
      toolName: "run_command",
      args: { command: "dotnet run -- add todo Task" },
    })?.includes("already exited 0"),
    true,
  );
  assert.equal(
    redundantVerifyBlock({
      goal,
      steps,
      toolName: "run_command",
      args: { command: "dotnet build" },
    })?.includes("already exited 0"),
    true,
  );
});

test("environment probes do not latch verification or block later build steps", () => {
  const goal =
    "Under /tmp/CompCert/, build the CompCert C verified compiler from source. Ensure that CompCert can be invoked through /tmp/CompCert/ccomp.";
  assert.equal(isHarborStyleGoal(goal), true);
  assert.ok(extractNamedNodeCommands(goal).some((c) => /\/tmp\/CompCert\/ccomp/.test(c)));
  assert.equal(isDiagnosticCommand("apt-get --version", goal), true);
  assert.equal(isDiagnosticCommand("apt-cache policy", goal), true);
  assert.equal(isDiagnosticCommand("apt-get install -y ocaml", goal), false);

  const afterProbe = [
    {
      kind: "tool-calls",
      toolCalls: [
        {
          name: "run_command",
          ok: true,
          args: { command: "apt-get --version" },
          result: { status: "success", exitCode: 0, stdout: "apt 2.4\n" },
        },
      ],
    },
  ];
  assert.equal(
    redundantVerifyBlock({
      goal,
      steps: afterProbe,
      toolName: "run_command",
      args: { command: "apt-get install -y ocaml coq" },
    }),
    null,
  );
  assert.equal(
    alreadyVerifiedFinishNudge({ goal, steps: afterProbe, nudgeCount: 0 }),
    null,
  );
  assert.ok(
    missingRequiredVerification(goal, afterProbe.flatMap((s) => s.toolCalls)).some((item) =>
      /ccomp/.test(item),
    ),
  );
});

test("generic diff/awk/head exit 0 is not task verification", () => {
  const goal =
    "The output fasta file should be titled primers.fasta. Design primers from sequences.fasta.";
  assert.ok(extractNamedDeliverables(goal).includes("primers.fasta"));
  assert.ok(detectTaskHints(goal).some((h) => h.id === "artifact-create"));

  const afterDiff = [
    {
      kind: "tool-calls",
      toolCalls: [
        {
          name: "run_command",
          ok: true,
          args: { command: "diff -u sequences.fasta sequences.fasta" },
          result: { status: "success", exitCode: 0, stdout: "" },
        },
      ],
    },
  ];
  assert.equal(isDiagnosticCommand("diff -u sequences.fasta sequences.fasta", goal), true);
  assert.equal(
    redundantVerifyBlock({
      goal,
      steps: afterDiff,
      toolName: "run_command",
      args: { command: "head -n 20 sequences.fasta" },
    }),
    null,
  );
  assert.equal(
    alreadyVerifiedFinishNudge({ goal, steps: afterDiff, nudgeCount: 0 }),
    null,
  );
  assert.equal(
    completionVerifyNudge({
      goal,
      answerText: "Done.",
      steps: afterDiff,
      nudgeCount: 0,
    }),
    TOOL_NUDGE_DELIVERABLE,
  );
});

test("completionVerifyNudge requires behavioral verification after stub deliverable exists", () => {
  const goal =
    "Write sim.out and run the simulator — it must print fib(10)=55 and fib(20)=6765.";
  const steps = [
    {
      kind: "tool-calls",
      toolCalls: [
        {
          name: "write_file",
          ok: true,
          args: { path: "sim.out", content: "" },
          result: { path: "sim.out" },
        },
        {
          name: "run_command",
          ok: true,
          args: { command: "test -f sim.out" },
          result: { status: "success", exitCode: 0, stdout: "" },
        },
      ],
    },
  ];
  assert.equal(
    completionVerifyNudge({
      goal,
      answerText: "Done.",
      steps,
      nudgeCount: 0,
    }),
    TOOL_NUDGE_DELIVERABLE_VERIFY,
  );
});

test("alreadyVerifiedFinishNudge is a single notice and yields to missing deliverables", () => {
  const goal = "Create greet.mjs and a test.mjs. Run node test.mjs until it passes.";
  const steps = [
    {
      kind: "tool-calls",
      toolCalls: [
        {
          name: "run_command",
          ok: true,
          args: { command: "node test.mjs" },
          result: { status: "success", exitCode: 0, stdout: "ok\n" },
        },
      ],
    },
  ];
  assert.equal(alreadyVerifiedFinishNudge({ goal, steps, nudgeCount: 0 }), TOOL_NUDGE_ALREADY_VERIFIED);
  assert.equal(alreadyVerifiedFinishNudge({ goal, steps, nudgeCount: 1 }), null);
});

test("synthesizeFinalAnswer never returns empty text", () => {
  const text = synthesizeFinalAnswer({
    goal: "The output fasta file should be titled primers.fasta.",
    steps: [
      {
        toolCalls: [
          {
            name: "run_command",
            ok: true,
            args: { command: "diff -u sequences.fasta sequences.fasta" },
            result: { status: "success", exitCode: 0, stdout: "" },
          },
        ],
      },
    ],
  });
  assert.match(text, /empty final answer/i);
  assert.match(text, /primers\.fasta/);
  assert.match(text, /No files were created/i);
});

test("detectTaskHints matches git merge conflict goals", () => {
  const hints = detectTaskHints(
    "Merge the two branches. After the merge conflict in algo.py, implement map() and verify with examples.json.",
  );
  assert.ok(hints.some((h) => h.id === "merge-conflict"));
  assert.match(hints.find((h) => h.id === "merge-conflict").constraint, /git show/);
});

test("unresolved merge conflict blocks a final answer even when it is empty", () => {
  const goal =
    "Merge the two branches. After the merge conflict, implement map() and verify with examples.json.";
  const inspectOnly = [
    {
      kind: "tool-calls",
      toolCalls: [
        {
          name: "run_command",
          ok: true,
          args: { command: "git merge feature" },
          result: {
            status: "FAILED with exit code 1",
            exitCode: 1,
            stdout: "CONFLICT (content): Merge conflict in algo.py\n",
          },
        },
        {
          name: "run_command",
          ok: true,
          args: { command: "git show :2:algo.py" },
          result: { status: "success", exitCode: 0, stdout: "def map():\n    return 1\n" },
        },
        {
          name: "read_file",
          ok: true,
          args: { path: "algo.py" },
          result: "<<<<<<< HEAD\ndef map():\n=======\ndef map():\n>>>>>>> feature\n",
        },
      ],
    },
  ];
  assert.ok(
    missingRequiredVerification(goal, inspectOnly.flatMap((s) => s.toolCalls)).some((item) =>
      /merge conflict/i.test(item),
    ),
  );
  assert.equal(
    finalAnswerNudge({
      goal,
      answerText: "",
      steps: inspectOnly,
      nudgeCount: 0,
    }),
    TOOL_NUDGE_MERGE_CONFLICT,
  );
  assert.match(
    finalAnswerNudge({
      goal,
      answerText: "Inspected both sides.",
      steps: inspectOnly,
      nudgeCount: 0,
    }) ?? "",
    /merge CONFLICT|edit_file/i,
  );
});

test("merge conflict loop requires commit and examples.json after the edit", () => {
  const goal =
    "Merge the two branches. After the merge conflict, implement map() and verify with examples.json.";
  const resolved = [
    {
      kind: "tool-calls",
      toolCalls: [
        {
          name: "run_command",
          ok: true,
          args: { command: "git merge feature" },
          result: {
            status: "FAILED",
            exitCode: 1,
            stdout: "CONFLICT (content): Merge conflict in algo.py\n",
          },
        },
        {
          name: "write_file",
          ok: true,
          args: { path: "algo.py", content: "def map(grid):\n    return grid\n" },
          result: { path: "algo.py", bytesWritten: 30 },
        },
      ],
    },
  ];
  const missing = missingRequiredVerification(goal, resolved.flatMap((s) => s.toolCalls));
  assert.ok(missing.some((item) => /git add and git commit/i.test(item)));
  assert.ok(missing.some((item) => /examples\.json/i.test(item)));
  assert.match(
    completionVerifyNudge({
      goal,
      answerText: "Done.",
      steps: resolved,
      nudgeCount: 0,
    }) ?? "",
    /git add and git commit|examples\.json/,
  );
});

test("detectTaskHints covers secret-sanitize, crypto, and optimize goals", () => {
  const secret = detectTaskHints("Sanitize the repo: remove leaked AKIA and ghp_ secrets");
  assert.ok(secret.some((h) => h.id === "secret-sanitize"));
  const crypto = detectTaskHints("FEAL linear cryptanalysis of feal.c using pairs.txt");
  assert.ok(crypto.some((h) => h.id === "reverse-engineer"));
  assert.match(crypto.find((h) => h.id === "reverse-engineer").constraint, /feal\.c|pairs\.txt/i);
  const opt = detectTaskHints("Optimize the inference batching scheduler to meet the cost threshold");
  assert.ok(opt.some((h) => h.id === "optimize-threshold"));
});

test("redundantVerifyBlock allows re-run after a later shell command clobbers outputs", () => {
  const steps = [
    {
      toolCalls: [
        {
          name: "run_command",
          ok: true,
          args: { command: "python shape_packer.py" },
          result: { status: "success", exitCode: 0, stdout: "ok" },
        },
      ],
    },
    {
      toolCalls: [
        {
          name: "run_command",
          ok: true,
          args: { command: "python baseline_packer.py" },
          result: { status: "success", exitCode: 0, stdout: "baseline" },
        },
      ],
    },
  ];
  assert.equal(
    redundantVerifyBlock({
      goal: "beat the baseline packer threshold",
      steps,
      toolName: "run_command",
      args: { command: "python shape_packer.py" },
    }),
    null,
  );
});

test("secretHitWithoutEditNudge fires when grep finds secrets and no edit ran", () => {
  const nudge = secretHitWithoutEditNudge({
    goal: "Sanitize leaked secrets from the git repo",
    steps: [
      {
        toolCalls: [
          {
            name: "grep_search",
            ok: true,
            args: { pattern: "AKIA" },
            result: "1 match(es) in 1 file(s):\n.env:1: AWS_KEY=AKIAIOSFODNN7EXAMPLE",
          },
        ],
      },
    ],
  });
  assert.equal(nudge, TOOL_NUDGE_SECRET_HIT);
});

test("completionVerifyNudge blocks sanitize success claims without mutations", () => {
  assert.match(
    completionVerifyNudge({
      goal: "Sanitize the repo and remove secrets",
      answerText: "Done — all secrets removed successfully.",
      steps: [
        {
          toolCalls: [
            {
              name: "grep_search",
              ok: true,
              args: { pattern: "AKIA" },
              result: "1 match(es):\n.env:1: KEY=AKIAIOSFODNN7EXAMPLE",
            },
          ],
        },
      ],
      nudgeCount: 0,
    }) ?? "",
    /no successful write_file|Do not claim file changes/i,
  );
});

