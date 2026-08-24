import assert from "node:assert/strict";
import { test } from "node:test";

import {
  completionVerifyNudge,
  detectTaskHints,
  extractNamedNodeCommands,
  finalAnswerNudge,
  formatTaskConstraints,
  isComplexGoal,
  isGptOssModel,
  mutationBlockedUntilPretest,
  mutatedBeforeTestRun,
  prematureFinalNudge,
  resolveThinkSetting,
} from "../src/prompt-enhancements.mjs";

test("detectTaskHints matches test-fix and debug goals", () => {
  const hints = detectTaskHints("fix the failing test in auth.spec.mjs");
  assert.ok(hints.some((h) => h.id === "test-fix"));
  assert.match(hints.find((h) => h.id === "test-fix").constraint, /Mandatory first step/);

  const debug = detectTaskHints("debug why the login endpoint is not working");
  assert.ok(debug.some((h) => h.id === "debug"));
});

test("formatTaskConstraints renders a focus block", () => {
  const text = formatTaskConstraints([{ id: "debug", constraint: "Reproduce first." }]);
  assert.match(text, /## Task focus/);
  assert.match(text, /Reproduce first/);
});

test("isComplexGoal detects long and multi-step goals", () => {
  assert.equal(isComplexGoal("hi"), false);
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
  assert.equal(isComplexGoal(goal), false);
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

test("detectTaskHints matches config-edit goals", () => {
  const hints = detectTaskHints('In config.json change "debug" to true.');
  assert.ok(hints.some((h) => h.id === "config-edit"));
});

test("detectTaskHints matches path-answer and test-verify goals", () => {
  const pathGoal =
    "Which file exports computeTax? Reply with the path relative to the workspace root only.";
  assert.ok(detectTaskHints(pathGoal).some((h) => h.id === "path-answer"));

  const testGoal =
    "Create test.mjs and run test.mjs with node and confirm it passes.";
  assert.ok(detectTaskHints(testGoal).some((h) => h.id === "test-verify"));

  const pyGoal = "Create test.py and run test.py with python and confirm it passes.";
  assert.ok(detectTaskHints(pyGoal).some((h) => h.id === "test-verify"));

  const csGoal = "Fix the bugs, then run `dotnet run` and confirm it passes.";
  assert.ok(detectTaskHints(csGoal).some((h) => h.id === "test-verify"));
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

  const extract = detectTaskHints(
    "Extract shared slugify into src/slugify.mjs and update imports.",
  );
  assert.ok(extract.some((h) => h.id === "extract-shared"));
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
