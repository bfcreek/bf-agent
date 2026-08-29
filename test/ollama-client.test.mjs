import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_NUM_CTX, DEFAULT_TEMPERATURE, OllamaClient } from "../src/ollama-client.mjs";

/** fetch stub that records requests and replays scripted JSON responses. */
function makeFetch(responses) {
  const script = [...responses];
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    const payload = script.shift();
    if (!payload) throw new Error("fetch script exhausted");
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
  return { fetchImpl, requests };
}

const CHAT_REPLY = {
  message: { role: "assistant", content: "hi" },
  prompt_eval_count: 120,
  eval_count: 30,
};

test("chat sends num_ctx and a low temperature by default", async () => {
  const { fetchImpl, requests } = makeFetch([CHAT_REPLY]);
  const client = new OllamaClient({ fetchImpl });

  await client.chat({ messages: [{ role: "user", content: "hi" }] });

  assert.equal(requests[0].body.options.num_ctx, DEFAULT_NUM_CTX);
  assert.equal(requests[0].body.options.temperature, DEFAULT_TEMPERATURE);
});

test("constructor numCtx and modelOptions flow into the request; per-call options win", async () => {
  const { fetchImpl, requests } = makeFetch([CHAT_REPLY]);
  const client = new OllamaClient({
    fetchImpl,
    numCtx: 8192,
    modelOptions: { temperature: 0.1, top_p: 0.9 },
  });

  await client.chat({
    messages: [{ role: "user", content: "hi" }],
    options: { temperature: 0.5 },
  });

  assert.deepEqual(requests[0].body.options, {
    num_ctx: 8192,
    temperature: 0.5,
    top_p: 0.9,
  });
});

test("numCtx null omits num_ctx (Ollama server default)", async () => {
  const { fetchImpl, requests } = makeFetch([CHAT_REPLY]);
  const client = new OllamaClient({ fetchImpl, numCtx: null });

  await client.chat({ messages: [{ role: "user", content: "hi" }] });

  assert.equal(requests[0].body.options.num_ctx, undefined);
});

test("listModelsDetailed returns size metadata and tolerates missing fields", async () => {
  const { fetchImpl } = makeFetch([
    {
      models: [
        { name: "gpt-oss:20b", size: 13_000_000_000, details: { parameter_size: "20.9B" } },
        { name: "bare-model" },
      ],
    },
  ]);
  const client = new OllamaClient({ fetchImpl });

  const models = await client.listModelsDetailed();

  assert.deepEqual(models, [
    { name: "gpt-oss:20b", sizeBytes: 13_000_000_000, parameterSize: "20.9B" },
    { name: "bare-model", sizeBytes: 0, parameterSize: "" },
  ]);
});

test("chat returns the raw response with token counts for context accounting", async () => {
  const { fetchImpl } = makeFetch([CHAT_REPLY]);
  const client = new OllamaClient({ fetchImpl });

  const { message, raw } = await client.chat({ messages: [{ role: "user", content: "hi" }] });

  assert.equal(message.content, "hi");
  assert.equal(raw.prompt_eval_count, 120);
  assert.equal(raw.eval_count, 30);
});

test("chat sends think when the model is thinking-capable", async () => {
  const { fetchImpl, requests } = makeFetch([CHAT_REPLY]);
  const client = new OllamaClient({ fetchImpl, think: "auto" });
  client.thinkingCapable = true;
  client.paramsB = 8;

  await client.chat({ messages: [{ role: "user", content: "hi" }], model: "qwen3:8b" });

  assert.equal(requests[0].body.think, true);
});

test("chat omits think when disabled or model lacks thinking", async () => {
  const { fetchImpl, requests } = makeFetch([CHAT_REPLY, CHAT_REPLY]);
  const client = new OllamaClient({ fetchImpl, think: false });
  client.thinkingCapable = true;

  await client.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(requests[0].body.think, undefined);

  const client2 = new OllamaClient({ fetchImpl, think: "auto" });
  client2.thinkingCapable = false;
  await client2.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(requests[1].body.think, undefined);
});

test("chat uses gpt-oss think levels in auto mode for small models", async () => {
  const { fetchImpl, requests } = makeFetch([CHAT_REPLY]);
  const client = new OllamaClient({ fetchImpl, think: "auto" });
  client.thinkingCapable = true;
  client.paramsB = 8;

  await client.chat({ messages: [{ role: "user", content: "hi" }], model: "gpt-oss:20b" });

  assert.equal(requests[0].body.think, "high");
});

/** NDJSON body stream for chatStream tests. */
function ndjsonBody(chunks) {
  const text = chunks.map((c) => JSON.stringify(c)).join("\n") + "\n";
  return {
    getReader() {
      let sent = false;
      return {
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: new TextEncoder().encode(text) };
        },
        releaseLock() {},
      };
    },
  };
}

function makeStreamFetch(chunkSets) {
  const script = [...chunkSets];
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    const chunks = script.shift();
    if (!chunks) throw new Error("fetch script exhausted");
    return {
      ok: true,
      status: 200,
      body: ndjsonBody(chunks),
      json: async () => {
        throw new Error("json() should not be used for streams");
      },
      text: async () => chunks.map((c) => JSON.stringify(c)).join("\n"),
    };
  };
  return { fetchImpl, requests };
}

test("chatStream sends stream:true and accumulates content deltas", async () => {
  const { fetchImpl, requests } = makeStreamFetch([
    [
      { message: { role: "assistant", content: "Hel" }, done: false },
      { message: { role: "assistant", content: "lo!" }, done: false },
      {
        message: { role: "assistant", content: "" },
        done: true,
        prompt_eval_count: 10,
        eval_count: 2,
      },
    ],
  ]);
  const client = new OllamaClient({ fetchImpl });
  const deltas = [];

  const { message, raw } = await client.chatStream({
    messages: [{ role: "user", content: "hi" }],
    onDelta: (d) => deltas.push(d),
  });

  assert.equal(requests[0].body.stream, true);
  assert.deepEqual(deltas, ["Hel", "lo!"]);
  assert.equal(message.content, "Hello!");
  assert.equal(raw.prompt_eval_count, 10);
  assert.equal(raw.eval_count, 2);
});

test("chatStream wraps mid-stream transport failures as OllamaClientError", async () => {
  const bodyTimeout = new Error("Body Timeout Error");
  bodyTimeout.name = "BodyTimeoutError";
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        let sent = false;
        return {
          read: async () => {
            if (sent) throw bodyTimeout;
            sent = true;
            return {
              done: false,
              value: new TextEncoder().encode(
                `${JSON.stringify({ message: { role: "assistant", content: "par" }, done: false })}\n`,
              ),
            };
          },
          releaseLock() {},
        };
      },
    },
  });
  const client = new OllamaClient({ fetchImpl });

  await assert.rejects(
    client.chatStream({ messages: [{ role: "user", content: "hi" }] }),
    (err) => {
      assert.equal(err.name, "OllamaClientError", "must be retryable by chatWithRetry");
      assert.match(err.message, /stream failed mid-response/i);
      assert.equal(err.cause, bodyTimeout);
      return true;
    },
  );
});

test("chatStream merges streamed tool_calls", async () => {
  const { fetchImpl } = makeStreamFetch([
    [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ index: 0, function: { name: "add", arguments: '{"a":' } }],
        },
        done: false,
      },
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ index: 0, function: { arguments: "1}" } }],
        },
        done: false,
      },
      { message: { role: "assistant", content: "" }, done: true, eval_count: 1 },
    ],
  ]);
  const client = new OllamaClient({ fetchImpl });

  const { message } = await client.chatStream({
    messages: [{ role: "user", content: "1+1" }],
  });

  assert.equal(message.tool_calls[0].function.name, "add");
  assert.equal(message.tool_calls[0].function.arguments, '{"a":1}');
});
