/**
 * Thin OpenAI Chat Completions adapter. Loads the optional `openai` peer SDK
 * at runtime so bf-agent stays dependency-free by default.
 */

import { importPeerSdk, ProviderClientError } from "../provider-client.mjs";
import { fromOpenAIMessage, toOpenAIMessages } from "./message-bridge.mjs";

/**
 * @param {object} [options]
 * @param {string} [options.model]
 * @param {string} [options.apiKey]
 * @param {string} [options.baseUrl]
 * @param {number} [options.temperature]
 * @returns {Promise<OpenAIClient>}
 */
export async function createOpenAIClient(options = {}) {
  const mod = await importPeerSdk("openai", "npm install openai");
  const OpenAI = mod.default ?? mod.OpenAI;
  if (typeof OpenAI !== "function") {
    throw new ProviderClientError("openai package did not export an OpenAI constructor.", {
      transient: false,
    });
  }
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.OPENAI_KEY;
  if (!apiKey) {
    throw new ProviderClientError(
      "OpenAI provider requires an API key (set OPENAI_API_KEY or pass --api-key).",
      { transient: false },
    );
  }
  const sdk = new OpenAI({
    apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
  });
  return new OpenAIClient({ sdk, model: options.model, temperature: options.temperature });
}

export class OpenAIClient {
  /**
   * @param {object} options
   * @param {any} options.sdk
   * @param {string} [options.model]
   * @param {number} [options.temperature]
   */
  constructor({ sdk, model = "gpt-4.1", temperature = 0.2 }) {
    this.sdk = sdk;
    this.model = model;
    this.temperature = temperature;
    /** @type {import("../provider-client.mjs").ProviderCapabilities} */
    this.capabilities = {
      supportsTools: true,
      supportsThinking: false,
      supportsEmbed: false,
      supportsListModels: true,
      messageDialect: "openai",
    };
  }

  /**
   * @param {object} request
   * @returns {Promise<{message: object, raw: object}>}
   */
  async chat(request) {
    const { messages: wireMessages } = toOpenAIMessages(request.messages ?? []);
    const model = request.model || this.model;
    if (!model || model === "auto") {
      throw new ProviderClientError(
        "OpenAI provider requires an explicit --model (auto-routing is Ollama-only).",
        { transient: false },
      );
    }
    const body = {
      model,
      messages: wireMessages,
      temperature: this.temperature,
      ...(request.tools?.length ? { tools: request.tools } : {}),
    };

    let completion;
    try {
      completion = await this.sdk.chat.completions.create(body, {
        signal: request.signal,
      });
    } catch (err) {
      throw mapOpenAIError(err);
    }

    const choice = completion?.choices?.[0];
    if (!choice?.message) {
      throw new ProviderClientError("OpenAI response had no choices.", { transient: false });
    }
    const message = fromOpenAIMessage(choice.message);
    const doneReason = doneReasonFromFinish(choice.finish_reason);
    const raw = {
      ...completion,
      prompt_eval_count: completion?.usage?.prompt_tokens,
      prompt_eval_cached_count: completion?.usage?.prompt_tokens_details?.cached_tokens,
      eval_count: completion?.usage?.completion_tokens,
      ...(doneReason ? { done_reason: doneReason } : {}),
    };
    return { message, raw };
  }

  /**
   * @param {object} request
   * @returns {Promise<{message: object, raw: object}>}
   */
  async chatStream(request) {
    const { messages: wireMessages } = toOpenAIMessages(request.messages ?? []);
    const model = request.model || this.model;
    if (!model || model === "auto") {
      throw new ProviderClientError(
        "OpenAI provider requires an explicit --model (auto-routing is Ollama-only).",
        { transient: false },
      );
    }
    const body = {
      model,
      messages: wireMessages,
      temperature: this.temperature,
      stream: true,
      stream_options: { include_usage: true },
      ...(request.tools?.length ? { tools: request.tools } : {}),
    };

    let stream;
    try {
      stream = await this.sdk.chat.completions.create(body, {
        signal: request.signal,
      });
    } catch (err) {
      throw mapOpenAIError(err);
    }

    const accumulated = {
      role: "assistant",
      content: "",
      tool_calls: /** @type {Array<object>} */ ([]),
    };
    let usage = null;
    let finishReason = null;

    try {
      for await (const chunk of stream) {
        if (chunk?.usage) usage = chunk.usage;
        const reason = chunk?.choices?.[0]?.finish_reason;
        if (reason) finishReason = reason;
        const delta = chunk?.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === "string" && delta.content) {
          accumulated.content += delta.content;
          request.onDelta?.(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const part of delta.tool_calls) {
            const idx = part.index ?? 0;
            if (!accumulated.tool_calls[idx]) {
              accumulated.tool_calls[idx] = {
                id: part.id ?? `call_${idx}`,
                type: "function",
                function: { name: "", arguments: "" },
              };
            }
            const target = accumulated.tool_calls[idx];
            if (part.id) target.id = part.id;
            if (part.function?.name) target.function.name += part.function.name;
            if (part.function?.arguments) target.function.arguments += part.function.arguments;
          }
        }
      }
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      throw mapOpenAIError(err);
    }

    const openaiMessage = {
      role: "assistant",
      content: accumulated.content,
      ...(accumulated.tool_calls.length
        ? { tool_calls: accumulated.tool_calls.filter(Boolean) }
        : {}),
    };
    const message = fromOpenAIMessage(openaiMessage);
    const doneReason = doneReasonFromFinish(finishReason);
    const raw = {
      usage,
      prompt_eval_count: usage?.prompt_tokens,
      prompt_eval_cached_count: usage?.prompt_tokens_details?.cached_tokens,
      eval_count: usage?.completion_tokens,
      message: openaiMessage,
      ...(doneReason ? { done_reason: doneReason } : {}),
    };
    return { message, raw };
  }

  async listModels({ signal } = {}) {
    try {
      const page = await this.sdk.models.list({ signal });
      const data = page?.data ?? page?.body?.data ?? [];
      return data.map((m) => m.id).filter(Boolean);
    } catch (err) {
      throw mapOpenAIError(err);
    }
  }
}

/**
 * The agent loop retries a turn only when `raw.done_reason` is `"length"`
 * (Ollama's name). OpenAI reports the same cutoff as `finish_reason`.
 * @param {unknown} reason
 * @returns {string|undefined}
 */
function doneReasonFromFinish(reason) {
  const value = String(reason ?? "").trim().toLowerCase();
  if (!value) return undefined;
  if (value === "length" || value === "max_tokens") return "length";
  return value;
}

/** @param {any} err */
function mapOpenAIError(err) {
  if (err instanceof ProviderClientError) return err;
  if (err?.name === "AbortError") return err;
  const status = err?.status ?? err?.statusCode ?? err?.response?.status ?? null;
  const message = err?.message ?? String(err);
  return new ProviderClientError(`OpenAI API error: ${message}`, {
    status: typeof status === "number" ? status : null,
    cause: err,
    body: typeof err?.error === "object" ? JSON.stringify(err.error) : null,
  });
}
