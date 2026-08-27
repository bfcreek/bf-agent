import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADJUST_PLAN_MESSAGE,
  createPlanState,
  findLastPlanText,
  formatCheckpoint,
  isPlanPrompt,
  markProgress,
  missingKey,
  parsePlanSteps,
  pathsInStepText,
  REPLAN_REMAINING_MESSAGE,
} from "../src/plan-state.mjs";
import { PLANNING_USER_MESSAGE } from "../src/prompt-enhancements.mjs";

test("parsePlanSteps extracts numbered lines and skips Goals/Acceptance", () => {
  const plan = [
    "## Goals",
    "- ship filter.py",
    "1. read_file README.md",
    "2. write_file filter.py",
    "3. run_command node test.mjs",
    "",
    "## Acceptance",
    "- deliverable: filter.py",
    "- command: node test.mjs",
  ].join("\n");

  const steps = parsePlanSteps(plan);
  assert.equal(steps.length, 3);
  assert.equal(steps[0].id, 1);
  assert.match(steps[0].text, /read_file/);
  assert.equal(steps[1].text, "write_file filter.py");
  assert.ok(!steps.some((s) => /deliverable|Acceptance/i.test(s.text)));
});

test("parsePlanSteps accepts ) numbering", () => {
  const steps = parsePlanSteps("1) grep_search\n2) edit_file src/a.mjs");
  assert.equal(steps.length, 2);
  assert.equal(steps[1].id, 2);
});

test("pathsInStepText finds deliverable paths", () => {
  assert.deepEqual(pathsInStepText("write_file filter.py then verify"), ["filter.py"]);
  assert.deepEqual(pathsInStepText("edit `src/app.mjs`"), ["src/app.mjs"]);
});

test("markProgress marks write_file and matching run_command steps done", () => {
  const state = createPlanState(
    "1. write_file filter.py\n2. run_command node test.mjs\n3. summarize findings",
  );
  const runSteps = [
    {
      toolCalls: [
        {
          name: "write_file",
          args: { path: "filter.py", content: "x" },
          ok: true,
          result: { status: "success" },
        },
        {
          name: "run_command",
          args: { command: "node test.mjs" },
          ok: true,
          result: { exitCode: 0 },
        },
      ],
    },
  ];

  const next = markProgress(state, { steps: runSteps });
  assert.equal(next.steps[0].status, "done");
  assert.equal(next.steps[1].status, "done");
  assert.equal(next.steps[2].status, "pending");
});

test("formatCheckpoint renders checked boxes", () => {
  const state = createPlanState("1. write_file a.py\n2. verify");
  state.steps[0].status = "done";
  const text = formatCheckpoint(state);
  assert.match(text, /## Plan progress/);
  assert.match(text, /\[x\] 1\. write_file a\.py/);
  assert.match(text, /\[ \] 2\. verify/);
});

test("findLastPlanText prefers assistant reply after a plan prompt", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "goal" },
    { role: "user", content: PLANNING_USER_MESSAGE },
    { role: "assistant", content: "1. read_file a\n2. edit" },
    { role: "user", content: "more chat" },
    { role: "assistant", content: "working on it" },
  ];
  assert.match(findLastPlanText(messages), /read_file a/);
});

test("isPlanPrompt recognizes adjust and replan prompts", () => {
  assert.equal(isPlanPrompt(PLANNING_USER_MESSAGE), true);
  assert.equal(isPlanPrompt(ADJUST_PLAN_MESSAGE), true);
  assert.equal(isPlanPrompt(REPLAN_REMAINING_MESSAGE), true);
  assert.equal(isPlanPrompt("please edit the file"), false);
});

test("missingKey is order-independent", () => {
  assert.equal(missingKey(["b", "a"]), missingKey(["a", "b"]));
  assert.notEqual(missingKey(["a"]), missingKey(["b"]));
});
