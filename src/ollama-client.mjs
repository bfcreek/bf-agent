/**
 * Thin client for Ollama's native chat API (`/api/chat`).
 * Non-streaming for v1; the agent loop needs complete messages anyway
 * to detect tool calls before deciding the next step.
 */

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

export class OllamaClient {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl] Ollama server root, default local install.
   * @param {string} [options.model] Default model when a call omits one.
   * @param {number|null} [options.numCtx] Context window (tokens) sent as
   *   `options.num_ctx` on every chat call. Pass null to use Ollama's default.
   * @param {object} [options.modelOptions] Extra Ollama options (temperature,
   *   top_p, ...) merged into every chat call; per-call options win.
   * @param {typeof fetch} [options.fetchImpl] Injectable for tests.
   */
  constructor({
    baseUrl = "http://127.0.0.1:11434",
    model = "llama3.2",
    numCtx = DEFAULT_NUM_CTX,
    modelOptions,
    fetchImpl,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.numCtx = numCtx;
    this.modelOptions = { temperature: DEFAULT_TEMPERATURE, ...modelOptions };
    this.fetchImpl = fetchImpl ?? fetch;
  }

  /**
   * One chat completion round-trip.
   *
   * @param {object} request
   * @param {Array<object>} request.messages Full conversation so far.
   * @param {Array<object>} [request.tools] Tool schemas (OpenAI function shape).
   * @param {string} [request.model] Override the client default model.
   * @param {object} [request.options] Ollama options for this call, merged
   *   over the client defaults (num_ctx, modelOptions).
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<{message: object, raw: object}>} Assistant message
   *   (`{role, content, tool_calls?}`) plus the raw Ollama response — `raw`
   *   carries `prompt_eval_count`/`eval_count` for token accounting.
   */
  async chat({ messages, tools, model, options, signal }) {
    const body = {
      model: model || this.model,
      messages,
      stream: false,
    };
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

  /** @returns {Promise<string[]>} Installed model names. */
  async listModels({ signal } = {}) {
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
    return (raw?.models ?? []).map((m) => m?.name).filter(Boolean);
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
