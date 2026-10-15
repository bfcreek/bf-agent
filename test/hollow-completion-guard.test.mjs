import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentLoop } from "../src/agent-loop.mjs";
import {
  createHollowCompletionGuard,
  guardHollowCompletion,
  hasMutatingToolUse,
  withHollowCompletionGuard,
} from "../src/hollow-completion-guard.mjs";
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

function makeRegistry() {
  const registry = new ToolRegistry();
  registry.register({
    name: "write_file",
    requiresApproval: true,
    execute: () => "wrote",
  });
  return registry;
}

test("hasMutatingToolUse detects successful write_file", () => {
  assert.equal(
    hasMutatingToolUse([
      { kind: "tool-calls", toolCalls: [{ name: "read_file", ok: true }] },
      { kind: "tool-calls", toolCalls: [{ name: "write_file", ok: true }] },
    ]),
    true,
  );
});

test("hasMutatingToolUse ignores failed mutations and read-only tools", () => {
  assert.equal(
    hasMutatingToolUse([
      { kind: "tool-calls", toolCalls: [{ name: "write_file", ok: false }] },
      { kind: "tool-calls", toolCalls: [{ name: "read_file", ok: true }] },
    ]),
    false,
  );
});

test("guard challenges create goals with zero mutating tools", () => {
  const decision = guardHollowCompletion({
    goal: "create a game in electron based upon Quake",
    text: "That's it! Fully functional Electron app.",
    steps: [],
    loopCount: 0,
  });
  assert.match(decision.followupMessage, /no mutating tools/);
  assert.match(decision.followupMessage, /Fully functional Electron app/);
  assert.match(decision.followupMessage, /Do not ask the user to restate the task/);
});

test("guard allows Q&A goals and verified mutations", () => {
  assert.deepEqual(
    guardHollowCompletion({
      goal: "what does this project do?",
      text: "It is an agent runtime.",
      steps: [],
      loopCount: 0,
    }),
    {},
  );
  assert.deepEqual(
    guardHollowCompletion({
      goal: "create a CLI",
      text: "done",
      steps: [{ kind: "tool-calls", toolCalls: [{ name: "write_file", ok: true }] }],
      loopCount: 0,
    }),
    {},
  );
  assert.deepEqual(
    guardHollowCompletion({
      goal: "create a CLI",
      text: "This is truly Q&A with no workspace changes.",
      steps: [],
      loopCount: 0,
    }),
    {},
  );
});

test("createHollowCompletionGuard chains to an inner stop hook", async () => {
  let innerCalled = false;
  const stop = createHollowCompletionGuard({
    inner: () => {
      innerCalled = true;
      return { followupMessage: "inner" };
    },
  });
  const blocked = await stop({
    goal: "create an app",
    text: "done",
    steps: [],
    loopCount: 0,
  });
  assert.match(blocked.followupMessage, /mutating/);
  assert.equal(innerCalled, false);

  const allowed = await stop({
    goal: "create an app",
    text: "done",
    steps: [{ kind: "tool-calls", toolCalls: [{ name: "run_command", ok: true }] }],
    loopCount: 0,
  });
  assert.equal(allowed.followupMessage, "inner");
  assert.equal(innerCalled, true);
});

test("AgentLoop challenges hollow create completion then accepts after mutation", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "Fully functional Electron Quake app. Happy hacking!" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "write_file", arguments: { path: "package.json", content: "{}" } } }],
    },
    { role: "assistant", content: "Created package.json." },
  ]);
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    hooks: withHollowCompletionGuard({}),
  });

  const result = await loop.run("create a game in electron based upon Quake");

  assert.equal(result.stopReason, "completed");
  assert.equal(result.text, "Created package.json.");
  assert.ok(result.steps.some((s) => s.kind === "final" && s.continued));
  const followup = client.calls[1].messages.find(
    (m) => m.role === "user" && /no mutating tools/.test(m.content),
  );
  assert.ok(followup);
});
