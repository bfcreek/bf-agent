import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectTaskHints,
  formatTaskConstraints,
  isComplexGoal,
  isGptOssModel,
  prematureFinalNudge,
  resolveThinkSetting,
} from "../src/prompt-enhancements.mjs";

test("detectTaskHints matches test-fix and debug goals", () => {
  const hints = detectTaskHints("fix the failing test in auth.spec.mjs");
  assert.ok(hints.some((h) => h.id === "test-fix"));

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
