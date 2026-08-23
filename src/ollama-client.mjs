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

export class OllamaClient {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl] Ollama server root, default local install.
   * @param {string} [options.model] Default model when a call omits one.
   * @param {typeof fetch} [options.fetchImpl] Injectable for tests.
   */
  constructor({ baseUrl = "http://127.0.0.1:11434", model = "llama3.2", fetchImpl } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.fetchImpl = fetchImpl ?? fetch;
  }

  /**
   * One chat completion round-trip.
   *
   * @param {object} request
   * @param {Array<object>} request.messages Full conversation so far.
   * @param {Array<object>} [request.tools] Tool schemas (OpenAI function shape).
   * @param {string} [request.model] Override the client default model.
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<{message: object, raw: object}>} Assistant message
   *   (`{role, content, tool_calls?}`) plus the raw Ollama response.
   */
  async chat({ messages, tools, model, signal }) {
    const body = {
      model: model || this.model,
      messages,
      stream: false,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
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
    const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, { signal });
    if (!response.ok) {
      throw new OllamaClientError(`Ollama /api/tags returned ${response.status}`, {
        status: response.status,
      });
    }
    const raw = await response.json();
    return (raw?.models ?? []).map((m) => m?.name).filter(Boolean);
  }
}

async function safeReadText(response) {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "";
  }
}
