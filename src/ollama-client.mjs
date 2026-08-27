/**
 * Thin client for Ollama's native chat API (`/api/chat`).
 * `chat()` is a single JSON round-trip; `chatStream()` reads NDJSON token
 * deltas (and still returns a complete message for the agent loop).
 */

import { resolveThinkSetting } from "./prompt-enhancements.mjs";

export class OllamaClientError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "OllamaClientError";
    this.status = status ?? null;
  }
}

/**
 * Ollama's server-side default context window is small (4096 tokens unless
 * configured), and overflow is silent: the front of the prompt — system
 * message and tool schemas — is dropped without an error. Always sending an
 * explicit num_ctx keeps the agent's instructions in context.
 */
export const DEFAULT_NUM_CTX = 16_384;

/**
 * Low sampling temperature by default: agentic tool calling needs faithful
 * argument reproduction, not creativity. Override via modelOptions.
 */
export const DEFAULT_TEMPERATURE = 0.2;

/** Default think mode: enable native reasoning on capable models. */
export const DEFAULT_THINK = "auto";

export class OllamaClient {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl] Ollama server root, default local install.
   * @param {string} [options.model] Default model when a call omits one.
   * @param {number|null} [options.numCtx] Context window (tokens) sent as
   *   `options.num_ctx` on every chat call. Pass null to use Ollama's default.
   * @param {boolean|string} [options.think] Ollama native thinking: `auto`
   *   (default), `true`/`false`, or a level (`low`, `medium`, `high`, `max`).
   * @param {object} [options.modelOptions] Extra Ollama options (temperature,
   *   top_p, ...) merged into every chat call; per-call options win.
   * @param {typeof fetch} [options.fetchImpl] Injectable for tests.
   */
  constructor({
    baseUrl = "http://127.0.0.1:11434",
    model = "llama3.2",
    numCtx = DEFAULT_NUM_CTX,
    think = DEFAULT_THINK,
    modelOptions,
    fetchImpl,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.numCtx = numCtx;
    this.think = think;
    /** @type {boolean|null} Set via configureClientModel after model resolution. */
    this.thinkingCapable = null;
    /** @type {number} Parameters in billions; used for think auto-levels. */
    this.paramsB = 0;
    this.modelOptions = { temperature: DEFAULT_TEMPERATURE, ...modelOptions };
    this.fetchImpl = fetchImpl ?? fetch;
  }

  /**
   * Build the `/api/chat` JSON body (shared by chat and chatStream).
   * @param {object} request
   * @param {boolean} stream
   */
  buildChatBody({ messages, tools, model, options, think }, stream) {
    const resolvedModel = model || this.model;
    const body = {
      model: resolvedModel,
      messages,
      stream,
    };
    const resolvedThink = resolveThinkSetting({
      think: think ?? this.think,
      thinkingCapable: this.thinkingCapable,
      model: resolvedModel,
      paramsB: this.paramsB,
    });
    if (resolvedThink !== undefined) {
      body.think = resolvedThink;
    }
    if (tools && tools.length > 0) {
      body.tools = tools;
    }
    const modelOptions = {
      ...(this.numCtx ? { num_ctx: this.numCtx } : {}),
      ...this.modelOptions,
      ...options,
    };
    if (Object.keys(modelOptions).length > 0) {
      body.options = modelOptions;
    }
    return body;
  }

  /**
   * One chat completion round-trip (non-streaming).
   *
   * @param {object} request
   * @param {Array<object>} request.messages Full conversation so far.
   * @param {Array<object>} [request.tools] Tool schemas (OpenAI function shape).
   * @param {string} [request.model] Override the client default model.
   * @param {object} [request.options] Ollama options for this call, merged
   *   over the client defaults (num_ctx, modelOptions).
   * @param {boolean|string} [request.think] Per-call think override.
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<{message: object, raw: object}>} Assistant message
   *   (`{role, content, tool_calls?}`) plus the raw Ollama response — `raw`
   *   carries `prompt_eval_count`/`eval_count` for token accounting.
   */
  async chat(request) {
    const { signal } = request;
    const body = this.buildChatBody(request, false);

    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      throw new OllamaClientError(
        `Cannot reach Ollama at ${this.baseUrl}. Is 'ollama serve' running?`,
        { cause: err },
      );
    }

    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new OllamaClientError(
        `Ollama /api/chat returned ${response.status}${detail ? `: ${detail}` : ""}`,
        { status: response.status },
      );
    }

    const raw = await response.json();
    const message = raw?.message;
    if (!message || typeof message !== "object") {
      throw new OllamaClientError("Ollama response had no message object.");
    }
    return { message, raw };
  }

  /**
   * Streaming chat: Ollama NDJSON deltas in, complete assistant message out.
   * Content token pieces are forwarded via `onDelta` as they arrive. The
   * returned `message` is the full accumulated assistant turn (including
   * `tool_calls` when present) so the agent loop can branch as usual.
   *
   * @param {object} request
   * @param {Array<object>} request.messages
   * @param {Array<object>} [request.tools]
   * @param {string} [request.model]
   * @param {object} [request.options]
   * @param {boolean|string} [request.think]
   * @param {AbortSignal} [request.signal]
   * @param {(delta: string) => void} [request.onDelta] Content token callback.
   * @returns {Promise<{message: object, raw: object}>}
   */
  async chatStream(request) {
    const { signal, onDelta } = request;
    const body = this.buildChatBody(request, true);

    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      throw new OllamaClientError(
        `Cannot reach Ollama at ${this.baseUrl}. Is 'ollama serve' running?`,
        { cause: err },
      );
    }

    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new OllamaClientError(
        `Ollama /api/chat returned ${response.status}${detail ? `: ${detail}` : ""}`,
        { status: response.status },
      );
    }

    if (!response.body || typeof response.body.getReader !== "function") {
      // Some test stubs only implement json(); fall back to a one-shot read.
      const raw = await response.json();
      const message = raw?.message;
      if (!message || typeof message !== "object") {
        throw new OllamaClientError("Ollama response had no message object.");
      }
      const content = typeof message.content === "string" ? message.content : "";
      if (content && onDelta) onDelta(content);
      return { message, raw };
    }

    const accumulated = { role: "assistant", content: "" };
    /** @type {object} */
    let raw = {};
    let sawMessage = false;

    for await (const chunk of readNdjson(response.body, signal)) {
      if (chunk?.message && typeof chunk.message === "object") {
        sawMessage = true;
        mergeStreamMessage(accumulated, chunk.message, onDelta);
      }
      if (chunk?.done) {
        raw = chunk;
      } else if (chunk && typeof chunk === "object") {
        // Keep latest non-done meta (model, created_at) until done arrives.
        raw = { ...raw, ...chunk };
      }
    }

    if (!sawMessage) {
      throw new OllamaClientError("Ollama stream had no message object.");
    }

    // Prefer the done frame as raw (token counts live there); keep message.
    const finalRaw = { ...raw, message: accumulated };
    return { message: accumulated, raw: finalRaw };
  }

  /** @returns {Promise<string[]>} Installed model names. */
  async listModels({ signal } = {}) {
    const models = await this.listModelsDetailed({ signal });
    return models.map((m) => m.name);
  }

  /**
   * Installed models with the size metadata `/api/tags` provides, for
   * hardware-aware model selection.
   *
   * @returns {Promise<Array<{name: string, sizeBytes: number, parameterSize: string}>>}
   *   `parameterSize` is Ollama's human string (e.g. "20.9B"), "" when unknown.
   */
  async listModelsDetailed({ signal } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/tags`, { signal });
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      throw new OllamaClientError(
        `Cannot reach Ollama at ${this.baseUrl}. Is 'ollama serve' running?`,
        { cause: err },
      );
    }
    if (!response.ok) {
      throw new OllamaClientError(`Ollama /api/tags returned ${response.status}`, {
        status: response.status,
      });
    }
    const raw = await response.json();
    return (raw?.models ?? [])
      .filter((m) => m?.name)
      .map((m) => ({
        name: m.name,
        sizeBytes: typeof m.size === "number" ? m.size : 0,
        parameterSize: m.details?.parameter_size ?? "",
      }));
  }

  /**
   * Model details via Ollama `/api/show` — notably `capabilities`, which
   * lists "tools" for models whose template supports native tool calling.
   *
   * @param {object} request
   * @param {string} request.model
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<object>} Raw show response.
   */
  async show({ model, signal }) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
        signal,
      });
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      throw new OllamaClientError(
        `Cannot reach Ollama at ${this.baseUrl}. Is 'ollama serve' running?`,
        { cause: err },
      );
    }
    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new OllamaClientError(
        `Ollama /api/show returned ${response.status}${detail ? `: ${detail}` : ""}`,
        { status: response.status },
      );
    }
    return response.json();
  }

  /**
   * Embedding vector for one text input via Ollama `/api/embeddings`.
   *
   * @param {object} request
   * @param {string} request.prompt Text to embed.
   * @param {string} [request.model] Embedding model (e.g. nomic-embed-text).
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<number[]>}
   */
  async embed({ prompt, model, signal }) {
    const body = {
      model: model || "nomic-embed-text",
      prompt: String(prompt ?? ""),
    };

    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      throw new OllamaClientError(
        `Cannot reach Ollama at ${this.baseUrl}. Is 'ollama serve' running?`,
        { cause: err },
      );
    }

    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new OllamaClientError(
        `Ollama /api/embeddings returned ${response.status}${detail ? `: ${detail}` : ""}`,
        { status: response.status },
      );
    }

    const raw = await response.json();
    const embedding = raw?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new OllamaClientError("Ollama embeddings response had no embedding vector.");
    }
    return embedding;
  }
}

async function safeReadText(response) {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "";
  }
}

/**
 * Merge one Ollama stream message fragment into the accumulated assistant
 * message. Content pieces are appended; tool_calls are merged by index.
 *
 * @param {object} accumulated
 * @param {object} fragment
 * @param {(delta: string) => void} [onDelta]
 */
function mergeStreamMessage(accumulated, fragment, onDelta) {
  if (typeof fragment.role === "string") {
    accumulated.role = fragment.role;
  }
  if (typeof fragment.content === "string" && fragment.content) {
    accumulated.content = (accumulated.content ?? "") + fragment.content;
    onDelta?.(fragment.content);
  }
  if (fragment.thinking != null) {
    accumulated.thinking = (accumulated.thinking ?? "") + String(fragment.thinking);
  }
  if (Array.isArray(fragment.tool_calls) && fragment.tool_calls.length > 0) {
    if (!Array.isArray(accumulated.tool_calls)) accumulated.tool_calls = [];
    for (const call of fragment.tool_calls) {
      const index = typeof call?.index === "number" ? call.index : accumulated.tool_calls.length;
      const existing = accumulated.tool_calls[index];
      if (!existing) {
        accumulated.tool_calls[index] = structuredClone(call);
        continue;
      }
      // Merge partial tool-call fragments (name / argument pieces).
      if (call?.function) {
        existing.function = existing.function ?? {};
        if (call.function.name) existing.function.name = call.function.name;
        if (call.function.arguments != null) {
          const prev = existing.function.arguments;
          const next = call.function.arguments;
          if (typeof prev === "string" && typeof next === "string") {
            existing.function.arguments = prev + next;
          } else {
            existing.function.arguments = next;
          }
        }
      }
      if (call?.id) existing.id = call.id;
      if (call?.type) existing.type = call.type;
    }
  }
}

/**
 * Yield parsed JSON objects from an Ollama NDJSON response body.
 * @param {ReadableStream} body
 * @param {AbortSignal} [signal]
 */
async function* readNdjson(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch {
          throw new OllamaClientError(`Ollama stream returned invalid JSON: ${line.slice(0, 120)}`);
        }
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail);
      } catch {
        throw new OllamaClientError(`Ollama stream returned invalid JSON: ${tail.slice(0, 120)}`);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
