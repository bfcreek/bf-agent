import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { createOpenAIServer } from "../src/openai-server.mjs";
import { ToolRegistry } from "../src/tool-registry.mjs";

/** Client that replays scripted assistant messages and records requests. */
class FakeClient {
  constructor(script, { models } = {}) {
    this.script = [...script];
    this.calls = [];
    this.models = models;
  }

  async chat(request) {
    this.calls.push(structuredClone(request));
    const message = this.script.shift();
    if (!message) throw new Error("FakeClient script exhausted.");
    return { message, raw: { message } };
  }

  async listModels() {
    if (!this.models) throw new Error("no models endpoint");
    return this.models;
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
  return registry;
}

let server;
let baseUrl;

async function startServer(client, options = {}) {
  server = createOpenAIServer({
    client,
    registry: makeRegistry(),
    systemPrompt: "TEST SYSTEM PROMPT",
    defaultModel: "test-model",
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

beforeEach(() => {
  server?.close();
  server = undefined;
});

after(() => {
  server?.close();
});

async function postChat(body) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response;
}

test("plain completion returns an OpenAI-shaped response", async () => {
  const client = new FakeClient([{ role: "assistant", content: "hello from the loop" }]);
  await startServer(client);

  const response = await postChat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.match(body.id, /^chatcmpl-/);
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "test-model");
  assert.equal(body.choices[0].message.role, "assistant");
  assert.equal(body.choices[0].message.content, "hello from the loop");
  assert.equal(body.choices[0].finish_reason, "stop");
});

test("the fallback system prompt is injected when the client sends none", async () => {
  const client = new FakeClient([{ role: "assistant", content: "ok" }]);
  await startServer(client);

  await postChat({ messages: [{ role: "user", content: "hi" }] });
  const sent = client.calls[0].messages;
  assert.equal(sent[0].role, "system");
  assert.equal(sent[0].content, "TEST SYSTEM PROMPT");
});

test("a client-provided system message is preserved, not replaced", async () => {
  const client = new FakeClient([{ role: "assistant", content: "ok" }]);
  await startServer(client);

  await postChat({
    messages: [
      { role: "system", content: "CLIENT SYSTEM" },
      { role: "user", content: "hi" },
    ],
  });
  const sent = client.calls[0].messages;
  assert.equal(sent[0].content, "CLIENT SYSTEM");
  assert.equal(sent.filter((m) => m.role === "system").length, 1);
});

test("tool calls run through the loop before the response is returned", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [{ function: { name: "add", arguments: { a: 2, b: 3 } } }] },
    { role: "assistant", content: "The sum is 5." },
  ]);
  await startServer(client);

  const response = await postChat({ messages: [{ role: "user", content: "2+3?" }] });
  const body = await response.json();
  assert.equal(body.choices[0].message.content, "The sum is 5.");
  // Second round-trip must carry the tool result back to the model.
  const toolMsg = client.calls[1].messages.find((m) => m.role === "tool");
  assert.equal(toolMsg.content, "5");
});

test("a request model overrides the default and is echoed back", async () => {
  const client = new FakeClient([{ role: "assistant", content: "ok" }]);
  await startServer(client);

  const response = await postChat({
    model: "custom-model",
    messages: [{ role: "user", content: "hi" }],
  });
  const body = await response.json();
  assert.equal(body.model, "custom-model");
  assert.equal(client.calls[0].model, "custom-model");
});

test("stream:true replays the answer as SSE chunks ending with [DONE]", async () => {
  const client = new FakeClient([{ role: "assistant", content: "streamed answer" }]);
  await startServer(client);

  const response = await postChat({ stream: true, messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);

  const text = await response.text();
  const chunks = text
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice("data: ".length)));

  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.equal(chunks[1].choices[0].delta.content, "streamed answer");
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
  assert.ok(text.trimEnd().endsWith("data: [DONE]"));
});

test("array-of-parts content is flattened to text", async () => {
  const client = new FakeClient([{ role: "assistant", content: "ok" }]);
  await startServer(client);

  await postChat({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "part one" },
          { type: "text", text: "part two" },
        ],
      },
    ],
  });
  const goal = client.calls[0].messages.at(-1);
  assert.equal(goal.content, "part one\npart two");
});

test("GET /v1/models lists Ollama models", async () => {
  const client = new FakeClient([], { models: ["llama3.2", "qwen3-coder:30b"] });
  await startServer(client);

  const response = await fetch(`${baseUrl}/v1/models`);
  const body = await response.json();
  assert.equal(body.object, "list");
  assert.deepEqual(
    body.data.map((m) => m.id),
    ["llama3.2", "qwen3-coder:30b"],
  );
});

test("GET /v1/models falls back to the default model when Ollama is unreachable", async () => {
  const client = new FakeClient([]);
  await startServer(client);

  const response = await fetch(`${baseUrl}/v1/models`);
  const body = await response.json();
  assert.deepEqual(
    body.data.map((m) => m.id),
    ["test-model"],
  );
});

test("requests without a user message get a 400 in OpenAI error shape", async () => {
  const client = new FakeClient([]);
  await startServer(client);

  const response = await postChat({ messages: [{ role: "system", content: "only system" }] });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.type, "invalid_request_error");
  assert.match(body.error.message, /user message/);
});

test("unknown routes get a 404", async () => {
  const client = new FakeClient([]);
  await startServer(client);

  const response = await fetch(`${baseUrl}/v1/nope`);
  assert.equal(response.status, 404);
});
