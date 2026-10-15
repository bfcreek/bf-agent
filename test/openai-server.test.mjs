import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { createOpenAIServer } from "../src/openai-server.mjs";
import { ToolRegistry } from "../src/tool-registry.mjs";

/** Client that replays scripted assistant messages and records requests. */
class FakeClient {
  constructor(script, { models, streamPieces, capabilitiesByModel, detailedModels } = {}) {
    this.script = [...script];
    this.calls = [];
    this.models = models;
    this.capabilitiesByModel = capabilitiesByModel;
    this.detailedModels = detailedModels;
    /** When true, chatStream splits content into small onDelta pieces. */
    this.streamPieces = streamPieces === true;
  }

  async chat(request) {
    const { onDelta: _onDelta, ...rest } = request;
    this.calls.push(structuredClone(rest));
    const message = this.script.shift();
    if (!message) throw new Error("FakeClient script exhausted.");
    return { message, raw: { message } };
  }

  async chatStream(request) {
    const result = await this.chat(request);
    const content = typeof result.message?.content === "string" ? result.message.content : "";
    if (content && request.onDelta) {
      if (this.streamPieces) {
        for (const piece of content.match(/.{1,5}/gs) ?? []) {
          request.onDelta(piece);
        }
      } else {
        request.onDelta(content);
      }
    }
    return result;
  }

  async listModels() {
    if (!this.models) throw new Error("no models endpoint");
    return this.models;
  }

  async listModelsDetailed() {
    if (this.detailedModels) return this.detailedModels;
    if (this.models) {
      return this.models.map((name) => ({ name, sizeBytes: 0, parameterSize: "14B" }));
    }
    throw new Error("no models endpoint");
  }

  async show({ model }) {
    const capabilities = this.capabilitiesByModel?.[model];
    if (!capabilities) throw new Error(`model '${model}' not found`);
    return { capabilities };
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
    model: "llama3.2:latest",
    messages: [{ role: "user", content: "hi" }],
  });
  const body = await response.json();
  assert.equal(body.model, "llama3.2:latest");
  assert.equal(client.calls[0].model, "llama3.2:latest");
});

test("a non-tool-capable request model is rejected with 400", async () => {
  const client = new FakeClient([{ role: "assistant", content: "ok" }]);
  await startServer(client);

  const response = await postChat({
    model: "gemma3:12b",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.type, "invalid_request_error");
  assert.match(body.error.message, /does not support tool calling/);
  assert.equal(client.calls.length, 0);
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
  const content = chunks
    .slice(1, -1)
    .map((c) => c.choices[0].delta.content ?? "")
    .join("");
  assert.equal(content, "streamed answer");
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
  assert.ok(text.trimEnd().endsWith("data: [DONE]"));
});

test("stream:true forwards live token pieces from chatStream", async () => {
  const client = new FakeClient([{ role: "assistant", content: "hello world" }], {
    streamPieces: true,
  });
  await startServer(client);

  const response = await postChat({ stream: true, messages: [{ role: "user", content: "hi" }] });
  const text = await response.text();
  const chunks = text
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice("data: ".length)));

  const contentChunks = chunks.filter((c) => c.choices[0].delta.content);
  assert.ok(contentChunks.length > 1, "expected multiple live content chunks");
  assert.equal(
    contentChunks.map((c) => c.choices[0].delta.content).join(""),
    "hello world",
  );
});

test("stream:true omits tool-step narration and a discarded tool_call from the answer", async () => {
  const client = new FakeClient(
    [
      {
        role: "assistant",
        content: "I'll create a complete playable 3D shoot-em-up game.",
        tool_calls: [{ function: { name: "add", arguments: { a: 2, b: 3 } } }],
      },
      { role: "assistant", content: "First, I'll create the controller:<tool_call>" },
      { role: "assistant", content: "The sum is 5." },
    ],
    { streamPieces: true },
  );
  await startServer(client);

  const response = await postChat({ stream: true, messages: [{ role: "user", content: "2+3?" }] });
  const text = await response.text();
  const content = text
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice("data: ".length)))
    .map((c) => c.choices[0].delta.content ?? "")
    .join("");
  assert.equal(content, "The sum is 5.");
  assert.doesNotMatch(content, /<tool_call>|shoot-em-up/);
});

test("stream:true still streams the final answer after tool calls", async () => {
  const client = new FakeClient(
    [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "add", arguments: { a: 2, b: 3 } } }],
      },
      { role: "assistant", content: "The sum is 5." },
    ],
    { streamPieces: true },
  );
  await startServer(client);

  const response = await postChat({ stream: true, messages: [{ role: "user", content: "2+3?" }] });
  const text = await response.text();
  const content = text
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice("data: ".length)))
    .map((c) => c.choices[0].delta.content ?? "")
    .join("");
  assert.equal(content, "The sum is 5.");
});

test("stream:true falls back to replaying when the client has no chatStream", async () => {
  const client = {
    calls: [],
    script: [{ role: "assistant", content: "replayed" }],
    async chat(request) {
      this.calls.push(request);
      const message = this.script.shift();
      return { message, raw: { message } };
    },
  };
  await startServer(client);

  const response = await postChat({ stream: true, messages: [{ role: "user", content: "hi" }] });
  const text = await response.text();
  const content = text
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice("data: ".length)))
    .map((c) => c.choices[0].delta.content ?? "")
    .join("");
  assert.equal(content, "replayed");
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

test("GET /v1/models lists only tool-capable Ollama models", async () => {
  const client = new FakeClient([], {
    models: ["llama3.2", "qwen3-coder:30b", "gemma3:12b", "nomic-embed-text:latest"],
  });
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

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("image attachments are forwarded as Ollama images and keep a vision model", async () => {
  const client = new FakeClient([{ role: "assistant", content: "a red pixel" }], {
    capabilitiesByModel: {
      "devstral-small-2:latest": ["completion", "tools", "vision"],
      "test-model": ["completion", "tools"],
    },
    detailedModels: [
      {
        name: "devstral-small-2:latest",
        sizeBytes: 15e9,
        parameterSize: "24B",
      },
      { name: "test-model", sizeBytes: 2e9, parameterSize: "3B" },
    ],
  });
  await startServer(client, { defaultModel: "test-model" });

  const response = await postChat({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what color?" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` },
          },
        ],
      },
    ],
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.model, "devstral-small-2:latest");
  assert.equal(body.choices[0].message.content, "a red pixel");

  const userMsg = client.calls[0].messages.find((m) => m.role === "user");
  assert.equal(userMsg.content.includes("what color?"), true);
  assert.deepEqual(userMsg.images, [TINY_PNG_B64]);
});

test("pinned model without vision is rejected when images are attached", async () => {
  const client = new FakeClient([], {
    capabilitiesByModel: {
      "llama3.2:latest": ["completion", "tools"],
    },
  });
  await startServer(client);

  const response = await postChat({
    model: "llama3.2:latest",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` },
          },
        ],
      },
    ],
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error.message, /does not support images/);
});

test("image turns prefer the tier band vision model when configured", async () => {
  const client = new FakeClient([{ role: "assistant", content: "seen" }], {
    capabilitiesByModel: {
      "qwen3-coder:14b": ["completion", "tools", "thinking"],
      "eyes:14b": ["completion", "tools", "vision"],
      "test-model": ["completion", "tools"],
    },
    detailedModels: [
      { name: "qwen3-coder:14b", sizeBytes: 9e9, parameterSize: "14B" },
      { name: "eyes:14b", sizeBytes: 9e9, parameterSize: "14B" },
      { name: "test-model", sizeBytes: 2e9, parameterSize: "3B" },
    ],
  });
  await startServer(client, {
    defaultModel: "test-model",
    defaultTier: 1,
    tierModels: [
      { throughTier: 1, model: "qwen3-coder:14b", vision: "eyes:14b" },
      { model: "qwen3-coder:14b", vision: "eyes:14b" },
    ],
  });

  const response = await postChat({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` },
          },
        ],
      },
    ],
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.model, "eyes:14b");
});
