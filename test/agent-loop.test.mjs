import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

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

test("stops at maxSteps and asks for a plain-text wrap-up answer", async () => {
  const endless = { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] };
  const client = new FakeClient([
    endless,
    endless,
    endless,
    { role: "assistant", content: "Partial answer: I added things." }, // wrap-up
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), maxSteps: 3 });

  const result = await loop.run("loop forever");

  assert.equal(result.stopReason, "max-steps");
  assert.equal(result.text, "Partial answer: I added things.");
  // 3 tool steps + 1 final wrap-up step.
  assert.equal(result.steps.length, 4);
  assert.equal(result.steps[3].kind, "final");
  // The wrap-up call offers no tools and carries the wrap-up instruction.
  const wrapUpCall = client.calls[3];
  assert.equal(wrapUpCall.tools, undefined);
  assert.match(wrapUpCall.messages[wrapUpCall.messages.length - 1].content, /all available tool steps/);
});

test("wrap-up failure still returns the max-steps result with empty text", async () => {
  const endless = { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] };
  // Script exhausts after the loop steps, so the wrap-up call throws.
  const client = new FakeClient([endless, endless]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), maxSteps: 2 });

  const result = await loop.run("loop forever");

  assert.equal(result.stopReason, "max-steps");
  assert.equal(result.text, "");
  assert.equal(result.steps.length, 2);
});

test("the third consecutive identical tool call is refused with a nudge", async () => {
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: "probe",
    execute: () => {
      executions++;
      return "same result";
    },
  });
  const same = { role: "assistant", content: "", tool_calls: [toolCall("probe", { q: 1 })] };
  const client = new FakeClient([
    same,
    same,
    same, // refused — nudge goes back instead of a third execution
    { role: "assistant", content: "fine, moving on" },
  ]);
  const loop = new AgentLoop({ client, registry });

  const result = await loop.run("go");

  assert.equal(result.text, "fine, moving on");
  assert.equal(executions, 2, "third identical call must not execute");
  const refused = result.steps[2].toolCalls[0];
  assert.equal(refused.ok, false);
  assert.match(refused.error, /times in a row/);
  // A different call resets the streak — nudge text reaches the model.
  const nudgeMsg = client.calls[3].messages.filter((m) => m.role === "tool").pop();
  assert.match(nudgeMsg.content, /^ERROR: /);
});

test("transient client errors are retried once", async () => {
  const flaky = {
    attempts: 0,
    async chat() {
      this.attempts++;
      if (this.attempts === 1) {
        const err = new Error("Cannot reach Ollama");
        err.name = "OllamaClientError";
        err.status = null;
        throw err;
      }
      return { message: { role: "assistant", content: "recovered" }, raw: {} };
    },
  };
  const loop = new AgentLoop({ client: flaky, registry: makeRegistry() });

  const result = await loop.run("go");

  assert.equal(result.text, "recovered");
  assert.equal(flaky.attempts, 2);
});

test("client errors with a 4xx status are not retried", async () => {
  const failing = {
    attempts: 0,
    async chat() {
      this.attempts++;
      const err = new Error("model not found");
      err.name = "OllamaClientError";
      err.status = 404;
      throw err;
    },
  };
  const loop = new AgentLoop({ client: failing, registry: makeRegistry() });

  await assert.rejects(() => loop.run("go"), /model not found/);
  assert.equal(failing.attempts, 1);
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

let bootstrapRoot;

before(async () => {
  bootstrapRoot = await mkdtemp(path.join(os.tmpdir(), "halo-agent-loop-boot-"));
  await writeFile(path.join(bootstrapRoot, "README.md"), "# Boot Project\n\nUnique boot marker.\n", "utf8");
});

after(async () => {
  await rm(bootstrapRoot, { recursive: true, force: true });
});

test("projectBootstrap injects README on the first turn only", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "boot answer" },
    { role: "assistant", content: "follow-up answer" },
  ]);
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    projectBootstrap: { workspaceRoot: bootstrapRoot },
  });

  const first = await loop.run("what is this project?");
  assert.match(first.messages.find((m) => m.role === "user").content, /Unique boot marker/);
  assert.match(client.calls[0].messages.find((m) => m.role === "user").content, /Auto-retrieved project context/);

  const history = first.messages;
  await loop.run("follow up", { history });
  const followUpUsers = client.calls[1].messages.filter((m) => m.role === "user");
  assert.equal(followUpUsers[followUpUsers.length - 1].content, "follow up");
});

test("simple goals skip the planning pre-pass", async () => {
  const client = new FakeClient([{ role: "assistant", content: "hi there" }]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("say hi");

  assert.equal(result.steps.length, 1);
  assert.equal(client.calls.length, 1);
});

test("complex goals get a planning pre-pass before tools", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "1. grep_search for foo\n2. read_file src/foo.mjs\n3. edit" },
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 2 })] },
    { role: "assistant", content: "done" },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("implement a new feature and then run the tests to verify");

  assert.equal(result.steps[0].kind, "plan");
  assert.match(result.steps[0].content, /grep_search/);
  assert.equal(client.calls[0].tools, undefined);
  assert.equal(client.calls[1].tools.length, 2);
});

test("task hints are injected into the user message", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "ok" },
    { role: "assistant", content: "ok" },
    { role: "assistant", content: "ok" },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false });

  await loop.run("fix the failing test in auth.spec.mjs");

  const user = client.calls[0].messages.find((m) => m.role === "user");
  assert.match(user.content, /## Task focus/);
  assert.match(user.content, /Run the relevant tests first/);
});

test("planning and hints can be disabled", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "ok" },
    { role: "assistant", content: "ok" },
    { role: "assistant", content: "ok" },
  ]);
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    planning: false,
    taskHints: false,
  });

  const result = await loop.run("implement a new feature and then run the tests to verify");

  assert.equal(result.steps.length, 1);
  const user = client.calls[0].messages.find((m) => m.role === "user");
  assert.doesNotMatch(user.content, /## Task focus/);
});

test("premature final without tools is nudged to use tools", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "I created greet.mjs for you." },
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 2 })] },
    { role: "assistant", content: "Done — files created and test passed." },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false });

  const result = await loop.run("Create greet.mjs and test.mjs, then run node test.mjs.");

  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].kind, "tool-calls");
  assert.equal(result.steps[1].kind, "final");
  assert.match(client.calls[1].messages.at(-1).content, /without calling any tools/);
});

test("empty answer on a read question is nudged", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "" },
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] },
    { role: "assistant", content: "8080" },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false });

  const result = await loop.run(
    "Read README.md and answer: what port does the service use? Reply with just the number.",
  );

  assert.equal(result.text, "8080");
  assert.match(client.calls[1].messages.at(-1).content, /empty/i);
});

test("terranRag injects corpus context into the user message", async () => {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "aura-context-hub-rest" }));
      return;
    }
    if (req.url?.startsWith("/admin/corpus-search")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          results: [{ content: "Terran hit text.", score: 0.5, metadata: { fileName: "doc.md" } }],
          warnings: [],
          scope: { mode: "single", namespace: "general" },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const client = new FakeClient([{ role: "assistant", content: "answer" }]);
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    terranRag: { restUrl: `http://127.0.0.1:${port}` },
  });

  try {
    const result = await loop.run("what is the policy?");
    assert.equal(result.text, "answer");
    const user = client.calls[0].messages.find((m) => m.role === "user");
    assert.match(user.content, /what is the policy\?/);
    assert.match(user.content, /Terran corpus context/);
    assert.match(user.content, /Terran hit text/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
