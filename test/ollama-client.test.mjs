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
