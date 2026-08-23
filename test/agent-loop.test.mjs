import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentLoop } from "../src/agent-loop.mjs";
import { ToolRegistry } from "../src/tool-registry.mjs";

/** Client that replays a scripted sequence of assistant messages. */
class FakeClient {
  constructor(script) {
    this.script = [...script];
    this.calls = [];
  }

  async chat({ messages, tools }) {
    this.calls.push({ messages: structuredClone(messages), tools });
    const message = this.script.shift();
    if (!message) throw new Error("FakeClient script exhausted.");
    return { message, raw: { message } };
  }
}

function makeRegistry() {
  const registry = new ToolRegistry();
  registry.register({
    name: "add",
    description: "Add two numbers.",
    parameters: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
    execute: ({ a, b }) => a + b,
  });
  registry.register({
    name: "explode",
    description: "Always fails.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      throw new Error("boom");
    },
  });
  return registry;
}

const toolCall = (name, args) => ({ function: { name, arguments: args } });

test("plain answer with no tool calls completes in one step", async () => {
  const client = new FakeClient([{ role: "assistant", content: "hi there" }]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("say hi");

  assert.equal(result.stopReason, "completed");
  assert.equal(result.text, "hi there");
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].kind, "final");
  // system + user + assistant
  assert.deepEqual(
    result.messages.map((m) => m.role),
    ["system", "user", "assistant"],
  );
});

test("tool call round-trip: executes tool, feeds result back, returns final", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 2, b: 3 })] },
    { role: "assistant", content: "The sum is 5." },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("what is 2+3?");

  assert.equal(result.stopReason, "completed");
  assert.equal(result.text, "The sum is 5.");
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].kind, "tool-calls");
  assert.deepEqual(result.steps[0].toolCalls[0], {
    name: "add",
    args: { a: 2, b: 3 },
    ok: true,
    result: 5,
  });

  // Second model call must include the tool result message.
  const secondCallMessages = client.calls[1].messages;
  const toolMsg = secondCallMessages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "tool result message was sent back to the model");
  assert.equal(toolMsg.tool_name, "add");
  assert.equal(toolMsg.content, "5");

  // Tool schemas are passed on every round-trip.
  assert.equal(client.calls[0].tools.length, 2);
  assert.equal(client.calls[0].tools[0].type, "function");
});

test("multiple tool calls in one assistant turn all execute in order", async () => {
  const client = new FakeClient([
    {
      role: "assistant",
      content: "",
      tool_calls: [toolCall("add", { a: 1, b: 1 }), toolCall("add", { a: 2, b: 2 })],
    },
    { role: "assistant", content: "2 and 4." },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("do both");

  assert.equal(result.steps[0].toolCalls.length, 2);
  assert.equal(result.steps[0].toolCalls[0].result, 2);
  assert.equal(result.steps[0].toolCalls[1].result, 4);
  const toolMessages = client.calls[1].messages.filter((m) => m.role === "tool");
  assert.equal(toolMessages.length, 2);
});

test("tool failure is surfaced to the model, loop continues", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("explode", {})] },
    { role: "assistant", content: "That tool failed." },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("try it");

  assert.equal(result.stopReason, "completed");
  assert.equal(result.steps[0].toolCalls[0].ok, false);
  assert.match(result.steps[0].toolCalls[0].error, /boom/);
  const toolMsg = client.calls[1].messages.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /^ERROR: /);
});

test("unknown tool name is reported back to the model, loop continues", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("no_such_tool", {})] },
    { role: "assistant", content: "Sorry, wrong tool." },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("go");

  assert.equal(result.stopReason, "completed");
  assert.equal(result.steps[0].toolCalls[0].ok, false);
  assert.match(result.steps[0].toolCalls[0].error, /Unknown tool 'no_such_tool'/);
});

test("stops at maxSteps when the model keeps calling tools", async () => {
  const endless = { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] };
  const client = new FakeClient([endless, endless, endless, endless]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), maxSteps: 3 });

  const result = await loop.run("loop forever");

  assert.equal(result.stopReason, "max-steps");
  assert.equal(result.text, "");
  assert.equal(result.steps.length, 3);
  assert.equal(client.calls.length, 3);
});

test("string tool arguments (JSON) are parsed before execution", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("add", '{"a":4,"b":6}')] },
    { role: "assistant", content: "10." },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("add them");

  assert.equal(result.steps[0].toolCalls[0].ok, true);
  assert.equal(result.steps[0].toolCalls[0].result, 10);
});

test("history continues a prior transcript without a new system message", async () => {
  const client = new FakeClient([{ role: "assistant", content: "again: hi" }]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const history = [
    { role: "system", content: "custom system" },
    { role: "user", content: "say hi" },
    { role: "assistant", content: "hi" },
  ];
  const result = await loop.run("say it again", { history });

  assert.equal(result.text, "again: hi");
  const sent = client.calls[0].messages;
  assert.equal(sent[0].content, "custom system");
  assert.equal(sent.filter((m) => m.role === "system").length, 1);
  // Caller's history array is not mutated.
  assert.equal(history.length, 3);
});

test("onStep observer fires for every step", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 2 })] },
    { role: "assistant", content: "3." },
  ]);
  const seen = [];
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    onStep: (step) => seen.push(step.kind),
  });

  await loop.run("add");

  assert.deepEqual(seen, ["tool-calls", "final"]);
});

test("aborted signal stops before calling the model", async () => {
  const client = new FakeClient([{ role: "assistant", content: "never" }]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });
  const controller = new AbortController();
  controller.abort();

  const result = await loop.run("go", { signal: controller.signal });

  assert.equal(result.stopReason, "aborted");
  assert.equal(client.calls.length, 0);
});
