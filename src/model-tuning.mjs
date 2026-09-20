/**
 * Per-model tuning. Cursor tunes instructions and request settings for each
 * model family instead of correcting the model mid-run; this module is the
 * only place model-specific knowledge lives.
 */

import { detectCapabilities, parseParamsBillions } from "./model-routing.mjs";

/** @param {string} model */
export function isGptOssModel(model) {
  return /^gpt-oss/i.test(String(model ?? ""));
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
  if (think === false || think === "false" || think === "off") return undefined;

  const explicitLevel =
    typeof think === "string" && ["low", "medium", "high", "max"].includes(think);
  if (explicitLevel) return think;

  if (thinkingCapable !== true) return undefined;

  const small = paramsB > 0 && paramsB < 14;
  if (isGptOssModel(model)) return small ? "high" : "medium";
  return true;
}

/**
 * Set model metadata on an OllamaClient so think auto-resolution and the
 * prompt overlay know what they are talking to.
 *
 * @param {import("./ollama-client.mjs").OllamaClient} client
 * @param {string} model
 * @param {object} [options]
 * @param {{parameterSize?: string, sizeBytes?: number}} [options.listEntry]
 */
export async function configureClientModel(client, model, { listEntry } = {}) {
  client.model = model;
  const { thinking } = await detectCapabilities(client, model);
  client.thinkingCapable = thinking === true;

  if (listEntry) {
    client.paramsB = parseParamsBillions(listEntry.parameterSize ?? "", listEntry.sizeBytes ?? 0);
    return;
  }
  if (typeof client.listModelsDetailed === "function") {
    try {
      const models = await client.listModelsDetailed();
      const entry = models.find((m) => m.name === model);
      if (entry) {
        client.paramsB = parseParamsBillions(entry.parameterSize ?? "", entry.sizeBytes ?? 0);
      }
    } catch {
      client.paramsB = 0;
    }
  }
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
  if (/^(qwen|deepseek|llama|mistral|devstral|gemma|phi)/i.test(name)) {
    return [
      "## Model notes",
      "- Call tools through native tool calling only; never write a tool call",
      "  as JSON inside your message text.",
    ].join("\n");
  }
  return "";
}
