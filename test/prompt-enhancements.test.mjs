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
  extractNamedNodeCommands,
  extractSmokeSubcommands,
  finalAnswerNudge,
  formatTaskConstraints,
  hasSuccessfulTestRun,
  isFollowUpGoal,
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
  TOOL_NUDGE_ALREADY_VERIFIED,
  TOOL_NUDGE_AMBIGUOUS_EDIT,
  TOOL_NUDGE_EMPTY_AFTER_TOOLS,
  TOOL_NUDGE_EMPTY_ANSWER,
  TOOL_NUDGE_EMPTY_VALUE,
  TOOL_NUDGE_FIX_IMPL,
  TOOL_NUDGE_FOLLOW_UP,
  TOOL_NUDGE_READ_IMPL,
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
  assert.equal(
    redundantVerifyBlock({
      steps,
      toolName: "run_command",
      args: { command: "node -v" },
    }),
    TOOL_NUDGE_ALREADY_VERIFIED,
  );
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
  assert.match(PLANNING_USER_MESSAGE, /unique per-function edit|ping-pong/i);
  assert.match(PLANNING_USER_MESSAGE, /non-empty final answer/);
  assert.match(PLANNING_USER_MESSAGE, /CS0136|canonical fix/);
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

