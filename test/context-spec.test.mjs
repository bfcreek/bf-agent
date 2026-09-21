import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CONTEXT_FRACTION, estimateTokens } from "../src/compaction.mjs";
import {
  checkContextWindow,
  deriveMinimumContext,
  EXCHANGE_COST,
  MIN_NUM_CTX,
  OUTPUT_RESERVE,
  RECOMMENDED_NUM_CTX,
  RECOMMENDED_NUM_CTX_THINKING,
} from "../src/context-spec.mjs";
import {
  configureClientModel,
  DEFAULT_NUM_CTX,
  estimateKvBytesPerToken,
  MAX_AUTO_NUM_CTX,
  modelContextLength,
  resolveAutoNumCtx,
} from "../src/model-tuning.mjs";
import { OllamaClient } from "../src/ollama-client.mjs";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../src/agent-loop.mjs";

test("the loop's per-call output cap is the spec's thinking reserve", () => {
  assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, OUTPUT_RESERVE.thinking);
});

test("the floor is the default window, and the recommendations sit above the derived minimums", () => {
  assert.equal(MIN_NUM_CTX, DEFAULT_NUM_CTX);
  const plain = deriveMinimumContext();
  const thinking = deriveMinimumContext({ thinking: true });
  assert.ok(plain.minNumCtx > MIN_NUM_CTX, "a typical non-thinking run already needs more than the floor");
  assert.ok(RECOMMENDED_NUM_CTX >= plain.minNumCtx, `${RECOMMENDED_NUM_CTX} >= ${plain.minNumCtx}`);
  assert.ok(RECOMMENDED_NUM_CTX_THINKING >= thinking.minNumCtx, `${RECOMMENDED_NUM_CTX_THINKING} >= ${thinking.minNumCtx}`);
  assert.equal(thinking.minNumCtx - plain.minNumCtx >= OUTPUT_RESERVE.thinking - OUTPUT_RESERVE.toolCall - 2048, true);
});

test("the derivation respects both constraints: reserve fits, and the steady prompt sits under the trigger", () => {
  for (const cfg of [{}, { thinking: true }, { thinking: true, toolResults: "max" }, { mcpTools: 20, ruleChars: 12_000 }]) {
    const d = deriveMinimumContext(cfg);
    assert.ok(d.breakdown.prompt + d.reserve <= d.minNumCtx, `reserve fits for ${JSON.stringify(cfg)}`);
    assert.ok(d.breakdown.prompt <= DEFAULT_CONTEXT_FRACTION * d.minNumCtx, `under trigger for ${JSON.stringify(cfg)}`);
    assert.equal(d.minNumCtx % 1024, 0);
  }
  assert.ok(deriveMinimumContext({ toolResults: "max" }).minNumCtx > deriveMinimumContext().minNumCtx);
  assert.ok(deriveMinimumContext({ mcpTools: 10 }).fixed > deriveMinimumContext().fixed);
  // Rules are capped at MAX_INSTRUCTION_CHARS no matter what is on disk.
  assert.equal(deriveMinimumContext({ ruleChars: 1e9 }).breakdown.rules, deriveMinimumContext({ ruleChars: 12_000 }).breakdown.rules);
});

test("one spilled tool result at code density is the largest single message", () => {
  // 12k head + 8k tail at ~3 chars/token, plus framing.
  assert.ok(EXCHANGE_COST.toolResultMax > 6500 && EXCHANGE_COST.toolResultMax < 7000);
});

test("checkContextWindow: server default, below floor, under recommended, and fine", () => {
  assert.match(checkContextWindow(null)[0], /server default/);
  assert.match(checkContextWindow(8192)[0], /below the 16384-token floor/);
  const thinking16k = checkContextWindow(16_384, { thinking: true });
  assert.equal(thinking16k.length, 1);
  assert.match(thinking16k[0], /thinking model needs ~12000 tokens/);
  assert.deepEqual(checkContextWindow(RECOMMENDED_NUM_CTX_THINKING, { thinking: true }), []);
  assert.deepEqual(checkContextWindow(RECOMMENDED_NUM_CTX, { thinking: false }), []);
});

test("estimateTokens counts tool results at code density and text at the blend", () => {
  const text = [{ role: "user", content: "x".repeat(1200) }];
  const tool = [{ role: "tool", content: "x".repeat(1200) }];
  assert.equal(estimateTokens(text), 300);
  assert.equal(estimateTokens(tool), 400);
});

// --- auto sizing ----------------------------------------------------------

const GPT_OSS_INFO = {
  "general.architecture": "gptoss",
  "gptoss.block_count": 24,
  "gptoss.attention.head_count": 64,
  "gptoss.attention.head_count_kv": 8,
  "gptoss.attention.key_length": 64,
  "gptoss.attention.value_length": 64,
  "gptoss.context_length": 131072,
};
const QWEN3_INFO = {
  "general.architecture": "qwen3",
  "qwen3.block_count": 40,
  "qwen3.attention.head_count": 40,
  "qwen3.attention.head_count_kv": 8,
  "qwen3.attention.key_length": 128,
  "qwen3.attention.value_length": 128,
  "qwen3.context_length": 40960,
};
const GB = 1024 ** 3;

test("KV cache cost per token comes from GGUF metadata; falls back to embedding/heads", () => {
  assert.equal(estimateKvBytesPerToken(GPT_OSS_INFO), 24 * 8 * 128 * 2);
  assert.equal(estimateKvBytesPerToken(QWEN3_INFO), 40 * 8 * 256 * 2);
  const noKeyLen = {
    "general.architecture": "llama",
    "llama.block_count": 32,
    "llama.attention.head_count": 32,
    "llama.attention.head_count_kv": 8,
    "llama.embedding_length": 4096,
  };
  assert.equal(estimateKvBytesPerToken(noKeyLen), 32 * 8 * (128 + 128) * 2);
  assert.equal(estimateKvBytesPerToken(undefined), null);
  assert.equal(estimateKvBytesPerToken({ "general.architecture": "x" }), null);
  assert.equal(modelContextLength(QWEN3_INFO), 40960);
  assert.equal(modelContextLength({}), null);
});

test("resolveAutoNumCtx: ceiling when the cache fits, model limit when smaller, floor when memory is tight", () => {
  const kv = estimateKvBytesPerToken(GPT_OSS_INFO);
  // 24 GB card: budget 19.2 GB, 13 GB of weights -> plenty of room -> ceiling.
  const roomy = resolveAutoNumCtx({ contextLength: 131072, kvBytesPerToken: kv, modelBytes: 13 * GB, budgetBytes: 19.2 * GB });
  assert.equal(roomy.numCtx, MAX_AUTO_NUM_CTX);
  assert.match(roomy.reason, /auto ceiling/);

  // qwen3's trained context is below the ceiling.
  const limited = resolveAutoNumCtx({ contextLength: 40960, kvBytesPerToken: estimateKvBytesPerToken(QWEN3_INFO), modelBytes: 9 * GB, budgetBytes: 38 * GB });
  assert.equal(limited.numCtx, 40960);
  assert.match(limited.reason, /model limit/);

  // 70B on the same card: no room after the weights -> default, and say so.
  const tight = resolveAutoNumCtx({ contextLength: 131072, kvBytesPerToken: kv, modelBytes: 40 * GB, budgetBytes: 19.2 * GB });
  assert.equal(tight.numCtx, DEFAULT_NUM_CTX);
  assert.match(tight.reason, /keeping the default/);

  // Partial fit lands on a 4096 multiple between floor and ceiling.
  const partial = resolveAutoNumCtx({ contextLength: 131072, kvBytesPerToken: kv, modelBytes: 17 * GB, budgetBytes: 19.2 * GB });
  assert.ok(partial.numCtx > DEFAULT_NUM_CTX && partial.numCtx < MAX_AUTO_NUM_CTX, String(partial.numCtx));
  assert.equal(partial.numCtx % 4096, 0);

  // Cloud models keep no local cache.
  assert.equal(resolveAutoNumCtx({ contextLength: 131072, cloud: true }).numCtx, MAX_AUTO_NUM_CTX);
  // Unknown metadata: default.
  assert.equal(resolveAutoNumCtx({}).numCtx, DEFAULT_NUM_CTX);
  // A model whose own limit is under the default gets its limit, not more.
  assert.equal(resolveAutoNumCtx({ contextLength: 8192, cloud: true }).numCtx, 8192);
});

function fakeClient({ modelInfo, sizeBytes, numCtx }) {
  const client = new OllamaClient({ model: "m", ...(numCtx !== undefined ? { numCtx } : {}) });
  client.show = async () => ({ capabilities: ["tools", "thinking"], model_info: modelInfo });
  client.listModelsDetailed = async () => [{ name: "gpt-oss:20b", sizeBytes, parameterSize: "20.9B" }];
  return client;
}

test("configureClientModel sizes an auto window from model metadata and the given hardware", async () => {
  const client = fakeClient({ modelInfo: GPT_OSS_INFO, sizeBytes: 13 * GB });
  assert.equal(client.numCtxAuto, true);
  assert.equal(client.numCtx, DEFAULT_NUM_CTX, "auto starts at the floor until configured");

  await configureClientModel(client, "gpt-oss:20b", { hardware: { totalMemBytes: 64 * GB, vramBytes: 24 * GB } });

  assert.equal(client.numCtx, MAX_AUTO_NUM_CTX);
  assert.match(client.numCtxReason, /KV cache fits/);
  assert.deepEqual(client.numCtxWarnings, []);
});

test("configureClientModel keeps an explicit window and reports when it is under the spec", async () => {
  const client = fakeClient({ modelInfo: GPT_OSS_INFO, sizeBytes: 13 * GB, numCtx: 16_384 });
  assert.equal(client.numCtxAuto, false);

  await configureClientModel(client, "gpt-oss:20b", { hardware: { totalMemBytes: 64 * GB, vramBytes: 24 * GB } });

  assert.equal(client.numCtx, 16_384);
  assert.equal(client.numCtxReason, null);
  assert.equal(client.numCtxWarnings.length, 1);
  assert.match(client.numCtxWarnings[0], /thinking model/);
});

test("configureClientModel on a CPU-only box with little RAM keeps the floor and warns", async () => {
  const client = fakeClient({ modelInfo: GPT_OSS_INFO, sizeBytes: 13 * GB });
  await configureClientModel(client, "gpt-oss:20b", { hardware: { totalMemBytes: 32 * GB, vramBytes: 0 } });
  // RAM budget 16 GB - 13 GB weights = 3 GB * 0.6 / 48 KB ≈ 39k tokens -> partial fit.
  assert.ok(client.numCtx >= DEFAULT_NUM_CTX && client.numCtx < MAX_AUTO_NUM_CTX, String(client.numCtx));
});
