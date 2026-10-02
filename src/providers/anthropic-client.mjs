/**
 * Thin Anthropic Messages API adapter. Loads the optional `@anthropic-ai/sdk`
 * peer at runtime so bf-agent stays dependency-free by default.
 */

import { importPeerSdk, ProviderClientError } from "../provider-client.mjs";
import {
  fromAnthropicResponse,
  toAnthropicMessages,
  toAnthropicTools,
} from "./message-bridge.mjs";

/**
 * @param {object} [options]
 * @param {string} [options.model]
 * @param {string} [options.apiKey]
 * @param {string} [options.baseUrl]
 * @param {number} [options.maxTokens]
 * @returns {Promise<AnthropicClient>}
 */
export async function createAnthropicClient(options = {}) {
  const mod = await importPeerSdk("@anthropic-ai/sdk", "npm install @anthropic-ai/sdk");
  const Anthropic = mod.default ?? mod.Anthropic;
  if (typeof Anthropic !== "function") {
    throw new ProviderClientError("@anthropic-ai/sdk did not export an Anthropic constructor.", {
      transient: false,
    });
  }
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ProviderClientError(
      "Anthropic provider requires an API key (set ANTHROPIC_API_KEY or pass --api-key).",
      { transient: false },
    );
  }
  const sdk = new Anthropic({
    apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
  });
  return new AnthropicClient({
    sdk,
    model: options.model,
    maxTokens: options.maxTokens,
  });
}

export class AnthropicClient {
  /**
   * @param {object} options
   * @param {any} options.sdk
   * @param {string} [options.model]
   * @param {number} [options.maxTokens]
   */
  constructor({ sdk, model = "claude-sonnet-4-5", maxTokens = 8192 }) {
    this.sdk = sdk;
    this.model = model;
    this.maxTokens = maxTokens;
    /** @type {import("../provider-client.mjs").ProviderCapabilities} */
    this.capabilities = {
      supportsTools: true,
      supportsThinking: false,
      supportsEmbed: false,
      supportsListModels: false,
      messageDialect: "anthropic",
    };
  }

  /**
   * @param {object} request
   * @returns {Promise<{message: object, raw: object}>}
   */
  async chat(request) {
    const model = request.model || this.model;
    if (!model || model === "auto") {
      throw new ProviderClientError(
        "Anthropic provider requires an explicit --model (auto-routing is Ollama-only).",
        { transient: false },
      );
    }
    const { system, messages } = toAnthropicMessages(request.messages ?? []);
    const body = {
      model,
      max_tokens: request.options?.num_predict ?? this.maxTokens,
      messages,
      ...(system ? { system } : {}),
      ...(request.tools?.length ? { tools: toAnthropicTools(request.tools) } : {}),
    };

    let response;
    try {
      response = await this.sdk.messages.create(body, { signal: request.signal });
    } catch (err) {
      throw mapAnthropicError(err);
    }

    const message = fromAnthropicResponse(response);
    const raw = {
      ...response,
      prompt_eval_count: response?.usage?.input_tokens,
      eval_count: response?.usage?.output_tokens,
    };
    return { message, raw };
  }

  /**
   * @param {object} request
   * @returns {Promise<{message: object, raw: object}>}
   */
  async chatStream(request) {
    const model = request.model || this.model;
    if (!model || model === "auto") {
      throw new ProviderClientError(
        "Anthropic provider requires an explicit --model (auto-routing is Ollama-only).",
        { transient: false },
      );
    }
    const { system, messages } = toAnthropicMessages(request.messages ?? []);
    const body = {
      model,
      max_tokens: request.options?.num_predict ?? this.maxTokens,
      messages,
      stream: true,
      ...(system ? { system } : {}),
      ...(request.tools?.length ? { tools: toAnthropicTools(request.tools) } : {}),
    };

    let stream;
    try {
      stream = await this.sdk.messages.stream(body, { signal: request.signal });
    } catch (err) {
      // Older SDKs may only expose create with stream:true
      try {
        stream = await this.sdk.messages.create(body, { signal: request.signal });
      } catch (err2) {
        throw mapAnthropicError(err2 ?? err);
      }
    }

    const textParts = [];
    const toolCalls = [];
    let usage = null;
    let stopReason = null;

    try {
      for await (const event of stream) {
        const type = event?.type;
        if (type === "content_block_delta") {
          if (event.delta?.type === "text_delta" && event.delta.text) {
            textParts.push(event.delta.text);
            request.onDelta?.(event.delta.text);
          } else if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
            const last = toolCalls[toolCalls.length - 1];
            if (last) last._json = (last._json ?? "") + event.delta.partial_json;
          }
        } else if (type === "content_block_start" && event.content_block?.type === "tool_use") {
          toolCalls.push({
            id: event.content_block.id,
            function: {
              name: event.content_block.name ?? "",
              arguments: event.content_block.input ?? {},
            },
            _json: "",
          });
        } else if (type === "message_delta") {
          if (event.usage) usage = { ...(usage ?? {}), ...event.usage };
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
        } else if (type === "message_start" && event.message?.usage) {
          usage = event.message.usage;
        }
      }
      // Prefer finalMessage when the SDK helper provides it.
      if (typeof stream?.finalMessage === "function") {
        const final = await stream.finalMessage();
        const message = fromAnthropicResponse(final);
        const raw = {
          ...final,
          prompt_eval_count: final?.usage?.input_tokens,
          eval_count: final?.usage?.output_tokens,
        };
        return { message, raw };
      }
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      throw mapAnthropicError(err);
    }

    for (const tc of toolCalls) {
      if (tc._json) {
        try {
          tc.function.arguments = JSON.parse(tc._json);
        } catch {
          tc.function.arguments = {};
        }
      }
      delete tc._json;
    }

    const content = textParts.join("");
    const message =
      toolCalls.length > 0
        ? { role: "assistant", content, tool_calls: toolCalls }
        : { role: "assistant", content };
    const raw = {
      usage,
      stop_reason: stopReason,
      prompt_eval_count: usage?.input_tokens,
      eval_count: usage?.output_tokens,
    };
    return { message, raw };
  }
}

/** @param {any} err */
function mapAnthropicError(err) {
  if (err instanceof ProviderClientError) return err;
  if (err?.name === "AbortError") return err;
  const status = err?.status ?? err?.statusCode ?? err?.error?.status ?? null;
  return new ProviderClientError(`Anthropic API error: ${err?.message ?? err}`, {
    status: typeof status === "number" ? status : null,
    cause: err,
  });
}
