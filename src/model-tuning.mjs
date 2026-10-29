/**
 * Per-model tuning. Cursor tunes instructions and request settings for each
 * model family instead of correcting the model mid-run; this module is the
 * only place model-specific knowledge lives.
 */

import { detectCapabilities, isCloudModel, parseParamsBillions } from "./model-routing.mjs";

/**
 * Context window floor. Ollama's server-side default is small (4096 tokens
 * unless configured) and overflow is silent: the front of the prompt — system
 * message and tool schemas — is dropped without an error. Always sending an
 * explicit num_ctx keeps the agent's instructions in context. With `auto`
 * this is where the window starts; configureClientModel raises it when the
 * model and the machine allow (see resolveAutoNumCtx).
 */
export const DEFAULT_NUM_CTX = 16_384;

/**
 * Ceiling for the auto-sized window. Past this, local models lose accuracy
 * on long contexts faster than the extra room helps, and each step's prompt
 * evaluation gets slower; compaction handles the rest.
 */
export const MAX_AUTO_NUM_CTX = 65_536;

/** num_ctx is rounded down to a multiple of this. */
export const NUM_CTX_STEP = 4_096;

/**
 * Share of the memory left after the model weights that the KV cache may
 * take. The remainder covers compute buffers, the embedding model for
 * project indexing, and Ollama's own overhead.
 */
export const KV_CACHE_SHARE = 0.6;

/** Bytes per KV element; Ollama's default cache type is f16. */
const KV_BYTES_PER_ELEMENT = 2;

/** @param {string} model */
export function isGptOssModel(model) {
  return /^gpt-oss/i.test(String(model ?? ""));
}

/**
 * Bytes of KV cache one token costs, from Ollama's `/api/show` model_info
 * (GGUF metadata). Conservative for models with sliding-window layers
 * (gpt-oss): those need less, never more.
 *
 * @param {Record<string, unknown>|undefined} modelInfo
 * @returns {number|null} Null when the metadata is missing.
 */
export function estimateKvBytesPerToken(modelInfo) {
  const arch = modelInfo?.["general.architecture"];
  if (typeof arch !== "string" || !arch) return null;
  const num = (key) => {
    const v = modelInfo[`${arch}.${key}`];
    return typeof v === "number" && v > 0 ? v : null;
  };
  const blocks = num("block_count");
  const heads = num("attention.head_count");
  const kvHeads = num("attention.head_count_kv") ?? heads;
  const embedding = num("embedding_length");
  const keyLength = num("attention.key_length") ?? (heads && embedding ? embedding / heads : null);
  const valueLength = num("attention.value_length") ?? keyLength;
  if (!blocks || !kvHeads || !keyLength || !valueLength) return null;
  return blocks * kvHeads * (keyLength + valueLength) * KV_BYTES_PER_ELEMENT;
}

/**
 * @param {Record<string, unknown>|undefined} modelInfo
 * @returns {number|null} The model's trained context length, when reported.
 */
export function modelContextLength(modelInfo) {
  const arch = modelInfo?.["general.architecture"];
  if (typeof arch !== "string" || !arch) return null;
  const v = modelInfo[`${arch}.context_length`];
  return typeof v === "number" && v > 0 ? v : null;
}

/**
 * Pick the context window for a model on this machine: the largest multiple
 * of NUM_CTX_STEP, between DEFAULT_NUM_CTX and MAX_AUTO_NUM_CTX (or the
 * model's own limit), whose KV cache fits in the memory left after the
 * weights. Cloud models keep no local KV cache, so they get the ceiling.
 *
 * @param {object} input
 * @param {number|null} [input.contextLength] Model's trained context length.
 * @param {number|null} [input.kvBytesPerToken] From estimateKvBytesPerToken.
 * @param {number} [input.modelBytes] Model file size.
 * @param {number} [input.budgetBytes] Memory available for the model
 *   (resolveModelFitBudget): VRAM-based when a usable GPU exists.
 * @param {boolean} [input.cloud]
 * @returns {{numCtx: number, reason: string}}
 */
export function resolveAutoNumCtx({ contextLength, kvBytesPerToken, modelBytes = 0, budgetBytes = 0, cloud = false }) {
  const ceiling = roundDown(Math.min(MAX_AUTO_NUM_CTX, contextLength ?? MAX_AUTO_NUM_CTX));
  const floor = Math.min(DEFAULT_NUM_CTX, ceiling);
  const limit = contextLength && contextLength < MAX_AUTO_NUM_CTX ? "model limit" : "auto ceiling";

  if (cloud) return { numCtx: ceiling, reason: `cloud model; ${limit}` };
  if (!kvBytesPerToken || !budgetBytes) {
    return { numCtx: floor, reason: "model metadata or memory budget unavailable; default" };
  }

  const spare = Math.max(0, budgetBytes - modelBytes) * KV_CACHE_SHARE;
  const fitTokens = roundDown(spare / kvBytesPerToken);
  if (fitTokens >= ceiling) return { numCtx: ceiling, reason: `${limit}; KV cache fits` };
  if (fitTokens <= floor) {
    return {
      numCtx: floor,
      reason: `memory after weights fits ~${Math.max(0, fitTokens)} tokens of KV cache; keeping the default (Ollama may offload)`,
    };
  }
  return { numCtx: fitTokens, reason: `KV cache fit in ${gb(spare)} left after ${gb(modelBytes)} of weights` };
}

function roundDown(tokens) {
  return Math.max(NUM_CTX_STEP, Math.floor(tokens / NUM_CTX_STEP) * NUM_CTX_STEP);
}

function gb(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Resolve the Ollama `think` request field.
 *
 * @param {object} options
 * @param {boolean|string} [options.think] `auto` (default), `true`/`false`,
 *   or a level (`low`, `medium`, `high`, `max`).
 * @param {boolean|null} [options.thinkingCapable] From model capabilities.
 * @param {string} [options.model]
 * @param {number} [options.paramsB] Model size in billions; smaller models get
 *   stronger thinking when `think` is `auto`.
 * @returns {boolean|string|undefined} Value for the API body, or undefined to omit.
 */
export function resolveThinkSetting({ think = "auto", thinkingCapable, model, paramsB = 0 } = {}) {
  if (think === false || think === "false" || think === "off") {
    // Thinking models reason by default when the field is omitted, so an
    // explicit off must be sent as `false`. Non-thinking models reject the
    // field either way, so omit it for them.
    return thinkingCapable === true ? false : undefined;
  }

  // A model known not to think rejects the field outright, so an explicit
  // level is dropped for it (a fixed-model bench config can carry
  // `think: max` for the cloud line while the local line is a non-thinker).
  if (thinkingCapable === false) return undefined;

  const explicitLevel =
    typeof think === "string" && ["low", "medium", "high", "max"].includes(think);
  if (explicitLevel) return think;

  if (thinkingCapable !== true) return undefined;

  const small = paramsB > 0 && paramsB < 14;
  if (isGptOssModel(model)) return small ? "high" : "medium";
  return true;
}

/**
 * The cheapest thinking setting a model family honors. For utility calls
 * (compaction summaries) and for re-asking after a turn was cut off by the
 * context window mid-reasoning — the model must spend its output budget on
 * the answer, not on more thinking.
 *
 * gpt-oss ignores `think: false` (it always reasons) but honors the `low`
 * level; other thinking families ignore the level strings and need `false`.
 *
 * @param {string} [model]
 * @returns {boolean|string}
 */
export function minimalThinkSetting(model) {
  return isGptOssModel(model) ? "low" : false;
}

/**
 * Set model metadata on an OllamaClient so think auto-resolution and the
 * prompt overlay know what they are talking to.
 *
 * When the client's context window is `auto`, this also sizes it for the
 * model and this machine (see resolveAutoNumCtx).
 *
 * @param {import("./ollama-client.mjs").OllamaClient} client
 * @param {string} model
 * @param {object} [options]
 * @param {{parameterSize?: string, sizeBytes?: number}} [options.listEntry]
 * @param {{totalMemBytes?: number, vramBytes?: number}} [options.hardware]
 *   Memory to size the window against; defaults to probing this machine.
 *   Pass the Ollama host's figures when the agent runs elsewhere (containers).
 */
export async function configureClientModel(client, model, { listEntry, hardware } = {}) {
  client.model = model;
  const { thinking } = await detectCapabilities(client, model);
  client.thinkingCapable = thinking === true;

  let entry = listEntry ?? null;
  if (!entry && typeof client.listModelsDetailed === "function") {
    try {
      const models = await client.listModelsDetailed();
      entry = models.find((m) => m.name === model) ?? null;
    } catch {
      entry = null;
    }
  }
  client.paramsB = entry ? parseParamsBillions(entry.parameterSize ?? "", entry.sizeBytes ?? 0) : 0;

  if (client.numCtxAuto) {
    const { numCtx, reason } = await sizeContextWindow(client, model, { sizeBytes: entry?.sizeBytes ?? 0, hardware });
    client.numCtx = numCtx;
    client.numCtxReason = reason;
  }
  // Spec check applies to explicit windows too: a user-set 8k is the most
  // common way to get silent prompt truncation.
  const { checkContextWindow } = await import("./context-spec.mjs");
  client.numCtxWarnings = checkContextWindow(client.numCtx, { thinking: client.thinkingCapable });
}

/**
 * Resolve the auto context window for `model` on this (or the given) hardware.
 * Best-effort: any probe failure lands on the default.
 *
 * @param {{show?: Function}} client
 * @param {string} model
 * @param {{sizeBytes?: number, hardware?: {totalMemBytes?: number, vramBytes?: number}}} [options]
 * @returns {Promise<{numCtx: number, reason: string}>}
 */
export async function sizeContextWindow(client, model, { sizeBytes = 0, hardware } = {}) {
  let modelInfo;
  if (typeof client?.show === "function") {
    try {
      const info = await client.show({ model });
      modelInfo = info?.model_info;
    } catch {
      modelInfo = undefined;
    }
  }
  const cloud = isCloudModel(model);
  let budgetBytes = 0;
  if (!cloud) {
    try {
      const { resolveModelFitBudget } = await import("./hardware.mjs");
      ({ budgetBytes } = await resolveModelFitBudget(hardware ?? {}));
    } catch {
      budgetBytes = 0;
    }
  }
  return resolveAutoNumCtx({
    contextLength: modelContextLength(modelInfo),
    kvBytesPerToken: estimateKvBytesPerToken(modelInfo),
    modelBytes: sizeBytes,
    budgetBytes,
    cloud,
  });
}

/**
 * Short, model-family-specific instruction overlay appended to the system
 * prompt. Each entry addresses a known quirk of how that family drives
 * tools; it is not task guidance.
 *
 * @param {string} [model]
 * @returns {string} Empty when the family needs nothing extra.
 */
export function modelPromptOverlay(model) {
  const name = String(model ?? "");
  if (isGptOssModel(name)) {
    return [
      "## Model notes",
      "- Put reasoning in your thinking channel, not in the tool-call channel.",
      "  When calling a tool, keep the assistant text empty; the call must be a",
      "  function name plus a JSON arguments object that matches the schema.",
      "- String arguments (file content, old_string, new_string) must be valid",
      "  JSON strings: escape quotes and newlines instead of pasting raw text.",
    ].join("\n");
  }
  if (/qwen3-coder/i.test(name)) {
    return [
      "## Model notes",
      "- A tool call is finished only when it includes </tool_call>. Do not stop",
      "  after the opening <tool_call> tag.",
      "- Do not write a status paragraph before a tool call. Emit the call",
      "  immediately, with short arguments.",
    ].join("\n");
  }
  if (/^(qwen|deepseek|llama|mistral|devstral|gemma|phi)/i.test(name)) {
    return [
      "## Model notes",
      "- Call tools through native tool calling only; never write a tool call",
      "  as JSON inside your message text.",
    ].join("\n");
  }
  return "";
}
