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

test("chat returns the raw response with token counts for context accounting", async () => {
  const { fetchImpl } = makeFetch([CHAT_REPLY]);
  const client = new OllamaClient({ fetchImpl });

  const { message, raw } = await client.chat({ messages: [{ role: "user", content: "hi" }] });

  assert.equal(message.content, "hi");
  assert.equal(raw.prompt_eval_count, 120);
  assert.equal(raw.eval_count, 30);
});
