import assert from "node:assert/strict";
import { test } from "node:test";

import { EMPTY_RETRY_PROMPT, TRUNCATED_RETRY_PROMPT } from "../src/agent-loop.mjs";
import {
  classifyTool,
  computeEfficiency,
  formatEfficiencyForPrompt,
  heuristicScore,
  summarizeEfficiency,
} from "../evals/efficiency.mjs";

function call(name, args, extra = {}) {
  return { name, args, ok: true, ...extra };
}

function step(index, toolCalls, extra = {}) {
  return { index, kind: toolCalls.length ? "tool-calls" : "final", content: "", toolCalls, ...extra };
}

test("classifyTool buckets the builtin tool set", () => {
  assert.equal(classifyTool("read_file"), "read");
  assert.equal(classifyTool("grep_search"), "search");
  assert.equal(classifyTool("edit_file"), "mutate");
  assert.equal(classifyTool("run_command"), "exec");
  assert.equal(classifyTool("call_mcp_tool"), "other");
});

test("a clean read → edit → verify run has no flags", () => {
  const m = computeEfficiency(
    {
      stopReason: "completed",
      elapsedMs: 4000,
      compactions: 0,
      steps: [
        step(1, [call("read_file", { path: "src/a.mjs" })], { durationMs: 900, promptTokens: 1200, completionTokens: 40 }),
        step(2, [call("edit_file", { path: "src/a.mjs" })], { durationMs: 800, promptTokens: 1500, completionTokens: 60 }),
        step(3, [call("run_command", { command: "npm test" }, { result: { exitCode: 0 } })], { durationMs: 700, promptTokens: 1700, completionTokens: 30 }),
        step(4, [], { durationMs: 500, promptTokens: 1800, completionTokens: 20 }),
      ],
      messages: [],
    },
    { maxSteps: 20 },
  );
  assert.equal(m.steps, 4);
  assert.equal(m.modelCalls, 4);
  assert.equal(m.toolCalls, 3);
  assert.deepEqual(m.byCategory, { read: 1, search: 0, mutate: 1, exec: 1, other: 0 });
  assert.equal(m.mutations, 1);
  assert.deepEqual(m.filesTouched, ["src/a.mjs"]);
  assert.equal(m.firstMutationStep, 2);
  assert.equal(m.verifiedAfterLastMutation, true);
  assert.equal(m.budgetUsed, 0.2);
  assert.equal(m.modelMs, 2900);
  assert.deepEqual(m.tokens, { prompt: 6200, completion: 150, peakPrompt: 1800, perStep: 1550, window: null });
  assert.deepEqual(m.flags, []);
  assert.equal(m.heuristicScore, 100);
});

test("blind edit, no verification, and edit misses are flagged", () => {
  const m = computeEfficiency({
    stopReason: "completed",
    steps: [
      step(1, [call("edit_file", { path: "lib/x.mjs" }, { ok: false, error: "snippet not found" })]),
      step(2, [call("edit_file", { path: "lib/x.mjs" }, { ok: false, error: "snippet not found" })]),
      step(3, [call("edit_file", { path: "lib/x.mjs" })]),
      step(4, []),
    ],
  });
  assert.equal(m.blindEdits, 1, "only the first touch of an unseen path is blind");
  assert.equal(m.editMisses, 2);
  assert.equal(m.mutations, 1);
  assert.equal(m.verifiedAfterLastMutation, false);
  assert.ok(m.flags.includes("blind-edit"));
  assert.ok(m.flags.includes("edit-misses"));
  assert.ok(m.flags.includes("no-verification"));
  assert.ok(m.flags.includes("no-exploration"));
  assert.ok(m.heuristicScore < 100);
});

test("redundant reads reset once the file changes", () => {
  const m = computeEfficiency({
    stopReason: "completed",
    steps: [
      step(1, [call("read_file", { path: "a.txt" })]),
      step(2, [call("read_file", { path: "a.txt" })]), // redundant
      step(3, [call("read_file", { path: "a.txt", offset: 100, limit: 50 })]), // pagination, fine
      step(4, [call("write_file", { path: "a.txt", content: "x" })]),
      step(5, [call("read_file", { path: "a.txt" })]), // legitimate: file changed
      step(6, [call("read_file", { path: "a.txt" })]), // redundant
      step(7, [call("run_command", { command: "cat a.txt" }, { result: { exitCode: 0 } })]),
      step(8, []),
    ],
  });
  assert.equal(m.redundantReads, 2);
  assert.ok(m.flags.includes("redundant-reads"));
  assert.ok(!m.flags.includes("no-verification"));
});

test("repeated failing commands count as spinning", () => {
  const failing = () => call("run_command", { command: "make" }, { result: { exitCode: 2, stderr: "boom" } });
  const m = computeEfficiency({
    stopReason: "max-steps",
    steps: [step(1, [failing()]), step(2, [failing()]), step(3, [failing()])],
  });
  assert.equal(m.repeatedFailingCommands, 2);
  assert.equal(m.maxIdenticalRepeats, 3);
  assert.ok(m.flags.includes("spinning"));
  assert.ok(m.flags.includes("budget-exhausted"));
});

test("wall-clock exhaustion, parse recoveries, empty retries, and compaction are surfaced", () => {
  const m = computeEfficiency({
    stopReason: "max-steps",
    wallClockExhausted: true,
    compactions: 2,
    steps: [
      { index: 1, kind: "tool-parse-error", content: "bad json", toolCalls: [] },
      { index: 1, kind: "tool-parse-error", content: "bad json", toolCalls: [] },
      // Repaired locally: no correction round-trip, so not a recovery.
      { index: 2, kind: "tool-parse-error", content: "stray ]", toolCalls: [], repaired: "run_command" },
      step(1, [call("list_dir", { path: "." })]),
      step(2, [call("grep_search", { pattern: "foo" })]),
      step(3, [call("read_file", { path: "b" })]),
      step(4, [call("read_file", { path: "c" })]),
      step(5, [], { wrapUp: true }),
    ],
    messages: [
      { role: "user", content: "do it" },
      { role: "user", content: EMPTY_RETRY_PROMPT },
    ],
  });
  assert.equal(m.parseRecoveries, 2);
  assert.equal(m.parseRepairs, 1);
  assert.equal(m.emptyRetries, 1);
  assert.equal(m.wrapUp, true);
  assert.equal(m.compactions, 2);
  assert.ok(m.flags.includes("wall-clock-exhausted"));
  assert.ok(!m.flags.includes("budget-exhausted"), "wall clock takes precedence over the step cap");
  assert.ok(m.flags.includes("parse-recoveries"));
  assert.ok(m.flags.includes("heavy-compaction"));
  assert.equal(m.mutations, 0);
  assert.equal(m.verifiedAfterLastMutation, null);
});

test("high failure rate needs enough calls to be meaningful", () => {
  const bad = call("read_file", { path: "nope" }, { ok: false, error: "ENOENT" });
  const few = computeEfficiency({ stopReason: "completed", steps: [step(1, [bad, bad]), step(2, [])] });
  assert.ok(!few.flags.includes("high-failure-rate"));
  const many = computeEfficiency({
    stopReason: "completed",
    steps: [step(1, [bad, bad]), step(2, [call("read_file", { path: "ok" }), call("list_dir", { path: "." })]), step(3, [])],
  });
  assert.ok(many.flags.includes("high-failure-rate"));
});

test("commands that exit non-zero count as failed tool calls", () => {
  const missing = call("run_command", { command: "python x.py" }, { result: { exitCode: 127, stdout: "", stderr: "python: command not found" } });
  const fine = call("run_command", { command: "ls" }, { result: { exitCode: 0, stdout: "a", stderr: "" } });
  const m = computeEfficiency({
    stopReason: "completed",
    steps: [step(1, [missing]), step(2, [call("read_file", { path: "a" })]), step(3, [fine]), step(4, [])],
  });
  assert.equal(m.toolCalls, 3);
  assert.equal(m.failedToolCalls, 1, "exit 127 is a failure even though the tool itself returned ok");
  assert.match(formatEfficiencyForPrompt(m), /failed 1/);
});

test("a plain answer with no tools is marked, not penalized", () => {
  const m = computeEfficiency({ stopReason: "completed", steps: [step(1, [])] });
  assert.deepEqual(m.flags, ["no-tool-use"]);
  assert.equal(m.heuristicScore, 100);
  assert.equal(heuristicScore(["spinning", "no-verification"]), 70);
});

test("empty stop reason and repeated empty retries are flagged", () => {
  const m = computeEfficiency({
    stopReason: "empty",
    steps: [step(1, []), step(2, []), step(3, [])],
    messages: [
      { role: "user", content: EMPTY_RETRY_PROMPT },
      { role: "user", content: EMPTY_RETRY_PROMPT },
    ],
  });
  assert.ok(m.flags.includes("empty-retries"));
  assert.ok(m.flags.includes("no-tool-use"));
  assert.equal(m.emptyRetries, 2);
});

test("truncated turns and failed compactions are counted from the trace and flagged", () => {
  const m = computeEfficiency({
    stopReason: "empty",
    compactions: 0,
    compactionFailures: 3,
    steps: [
      step(1, [call("read_file", { path: "feal.py" })]),
      { index: 2, kind: "empty", content: "", toolCalls: [], truncated: true, completionTokens: 13000 },
      { index: 3, kind: "empty", content: "", toolCalls: [], truncated: true, completionTokens: 12000 },
      { index: 4, kind: "empty", content: "", toolCalls: [], truncated: true },
    ],
    messages: [
      { role: "user", content: TRUNCATED_RETRY_PROMPT },
      { role: "user", content: TRUNCATED_RETRY_PROMPT },
    ],
  });
  assert.equal(m.modelCalls, 4, "empty round-trips are model calls");
  assert.equal(m.emptyRetries, 3, "empty steps beat the prompt count when richer");
  assert.equal(m.truncatedTurns, 3);
  assert.equal(m.compactionFailures, 3);
  assert.ok(m.flags.includes("truncated-turns"));
  assert.ok(m.flags.includes("compaction-failed"));
  assert.ok(m.flags.includes("empty-retries"));
  assert.match(formatEfficiencyForPrompt(m), /truncated turns 3/);
  assert.match(formatEfficiencyForPrompt(m), /compactions 0 \(3 failed\)/);
});

test("formatEfficiencyForPrompt is a compact, flag-annotated block", () => {
  const m = computeEfficiency({
    stopReason: "completed",
    elapsedMs: 65_000,
    steps: [step(1, [call("write_file", { path: "out.txt", content: "hi" })]), step(2, [])],
  });
  const text = formatEfficiencyForPrompt(m);
  assert.match(text, /tool calls: 1/);
  assert.match(text, /command run after last change: NO/);
  assert.match(text, /no-verification \(changed files but never ran a command afterwards\)/);
  assert.match(text, /time: 1m 5s total/);
  assert.match(text, /heuristic efficiency: \d+\/100/);
});

test("summarizeEfficiency aggregates across runs", () => {
  const a = computeEfficiency({
    stopReason: "completed",
    steps: [step(1, [call("write_file", { path: "a" })], { promptTokens: 1000 }), step(2, [], { promptTokens: 1200 })],
  });
  const b = computeEfficiency({
    stopReason: "completed",
    steps: [
      step(1, [call("read_file", { path: "b" })], { promptTokens: 500 }),
      step(2, [call("edit_file", { path: "b" })], { promptTokens: 600 }),
      step(3, [call("run_command", { command: "test" }, { result: { exitCode: 0 } })], { promptTokens: 700 }),
      step(4, [], { promptTokens: 800 }),
    ],
  });
  const summary = summarizeEfficiency([a, b, null]);
  assert.equal(summary.runs, 2);
  assert.equal(summary.avgToolCalls, 2);
  assert.equal(summary.avgSteps, 3);
  assert.equal(summary.verifiedRate, 0.5);
  assert.equal(summary.avgPromptTokens, (2200 + 2600) / 2);
  assert.deepEqual(summary.flagCounts, { "no-verification": 1, "no-exploration": 1 });
  assert.equal(summarizeEfficiency([]).runs, 0);
});
