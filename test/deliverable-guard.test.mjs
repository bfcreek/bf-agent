import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentLoop } from "../src/agent-loop.mjs";
import {
  deliverableCheckpointMessage,
  extractDeliverablePaths,
  guardMissingDeliverable,
  pathsMatch,
  shellRedirectTargets,
  wasReadBack,
  wasWritten,
  withDeliverableGuard,
} from "../src/deliverable-guard.mjs";
import { ToolRegistry } from "../src/tool-registry.mjs";

class FakeClient {
  constructor(script) {
    this.script = [...script];
    this.calls = [];
  }

  async chat(request) {
    this.calls.push(structuredClone(request));
    const message = this.script.shift();
    if (!message) throw new Error("FakeClient script exhausted.");
    return { message, raw: { message } };
  }
}

function toolCall(name, args, extra = {}) {
  return { name, args, ok: true, ...extra };
}

test("extractDeliverablePaths finds absolute and verb-linked relative paths", () => {
  const paths = extractDeliverablePaths(
    "Recover the password and write it to /app/recovered_passwords.txt. Also save solution.txt.",
  );
  assert.ok(paths.includes("/app/recovered_passwords.txt"));
  assert.ok(paths.includes("solution.txt"));
});

test("extractDeliverablePaths ignores package manifests", () => {
  assert.deepEqual(extractDeliverablePaths("Update package.json and requirements.txt"), []);
});

test("pathsMatch aliases /app and basename forms", () => {
  assert.equal(pathsMatch("/app/results.txt", "results.txt"), true);
  assert.equal(pathsMatch("app/results.txt", "/app/results.txt"), true);
  assert.equal(pathsMatch("/app/other.txt", "/app/results.txt"), false);
});

test("shellRedirectTargets parses redirects and tee", () => {
  assert.deepEqual(shellRedirectTargets("echo FLAG > /app/results.txt"), ["/app/results.txt"]);
  assert.deepEqual(shellRedirectTargets("cmd 2>/dev/null | tee -a out.log"), ["out.log"]);
});

test("wasWritten detects write_file and shell redirects", () => {
  const steps = [
    {
      kind: "tool-calls",
      toolCalls: [toolCall("run_command", { command: "echo x > /app/solution.txt" })],
    },
  ];
  assert.equal(wasWritten(steps, "/app/solution.txt"), true);
  assert.equal(wasWritten(steps, "/app/other.txt"), false);
});

test("wasReadBack detects cat of the deliverable", () => {
  const steps = [
    {
      kind: "tool-calls",
      toolCalls: [
        toolCall("write_file", { path: "/app/results.txt" }, { result: { path: "/app/results.txt" } }),
      ],
    },
    {
      kind: "tool-calls",
      toolCalls: [toolCall("run_command", { command: "cat /app/results.txt" })],
    },
  ];
  assert.equal(wasReadBack(steps, "/app/results.txt"), true);
});

test("guardMissingDeliverable blocks stop when the named path was never written", () => {
  const decision = guardMissingDeliverable({
    goal: "Write the flag to /app/results.txt",
    text: "Done, the flag is FLAG{x}",
    steps: [],
    loopCount: 0,
  });
  assert.match(decision.followupMessage ?? "", /results\.txt/);
  assert.match(decision.followupMessage ?? "", /never written/i);
});

test("guardMissingDeliverable requires a read-back after write", () => {
  const steps = [
    {
      kind: "tool-calls",
      toolCalls: [
        toolCall("write_file", { path: "results.txt" }, { result: { path: "results.txt" } }),
      ],
    },
  ];
  const decision = guardMissingDeliverable({
    goal: "save the answer to /app/results.txt",
    text: "Wrote results.txt",
    steps,
    loopCount: 0,
  });
  assert.match(decision.followupMessage ?? "", /not read back/i);
});

test("guardMissingDeliverable allows stop after write + read-back", () => {
  const steps = [
    {
      kind: "tool-calls",
      toolCalls: [
        toolCall("write_file", { path: "/app/results.txt" }, { result: { path: "/app/results.txt" } }),
      ],
    },
    {
      kind: "tool-calls",
      toolCalls: [toolCall("read_file", { path: "/app/results.txt" })],
    },
  ];
  assert.deepEqual(
    guardMissingDeliverable({
      goal: "write FLAG to /app/results.txt",
      text: "Done",
      steps,
      loopCount: 0,
    }),
    {},
  );
});

test("deliverableCheckpointMessage fires only when paths are missing", () => {
  assert.equal(
    deliverableCheckpointMessage({ goal: "say hello", steps: [], remainingSteps: 2 }),
    null,
  );
  const msg = deliverableCheckpointMessage({
    goal: "Write the password to /app/recovered_passwords.txt",
    steps: [],
    remainingSteps: 3,
  });
  assert.match(msg ?? "", /recovered_passwords\.txt/);
  assert.match(msg ?? "", /3 step/);
});

test("withDeliverableGuard re-enters the loop until the file is written", async () => {
  const registry = new ToolRegistry();
  let wrote = false;
  registry.register({
    name: "write_file",
    requiresApproval: true,
    execute: ({ path }) => {
      wrote = true;
      return { path };
    },
  });
  registry.register({
    name: "read_file",
    execute: ({ path }) => ({ path, content: "ok" }),
  });

  const client = new FakeClient([
    { role: "assistant", content: "I recovered the password: hunter2" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "write_file", arguments: { path: "/app/results.txt", content: "hunter2" } } }],
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "read_file", arguments: { path: "/app/results.txt" } } }],
    },
    { role: "assistant", content: "Saved the password to /app/results.txt" },
  ]);

  const loop = new AgentLoop({
    client,
    registry,
    hooks: withDeliverableGuard({}),
  });
  const result = await loop.run("Recover the password and write it to /app/results.txt");

  assert.equal(result.stopReason, "completed");
  assert.equal(wrote, true);
  assert.ok(result.steps.some((s) => s.kind === "final" && s.continued));
});
