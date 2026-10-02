/**
 * Shared LLM / nested-worker client contract.
 *
 * AgentLoop duck-types anything with `chat()` (and optional `chatStream()`).
 * Provider adapters throw {@link ProviderClientError} so retries and mid-run
 * failure handling stay provider-agnostic. Ollama remains the bundled default;
 * other providers load optional peer SDKs at runtime.
 */

/**
 * @typedef {object} ProviderCapabilities
 * @property {boolean} [supportsTools]
 * @property {boolean} [supportsThinking]
 * @property {boolean} [supportsEmbed]
 * @property {boolean} [supportsListModels]
 * @property {"ollama"|"openai"|"anthropic"|"nested"} [messageDialect]
 */

/**
 * @typedef {object} LlmClient
 * @property {(request: object) => Promise<{message: object, raw: object}>} chat
 * @property {(request: object) => Promise<{message: object, raw: object}>} [chatStream]
 * @property {(opts?: object) => Promise<string[]>} [listModels]
 * @property {(opts?: object) => Promise<number[]>} [embed]
 * @property {string} [model]
 * @property {ProviderCapabilities} [capabilities]
 */

/**
 * Provider-agnostic client failure. Transient errors (network, 5xx, 429) are
 * retried by the agent loop; 4xx and explicit `transient: false` are not.
 */
export class ProviderClientError extends Error {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {number|null} [options.status] HTTP-like status when known.
   * @param {unknown} [options.cause]
   * @param {boolean} [options.transient] Override transient classification.
   * @param {string|null} [options.body] Raw error body for diagnostics.
   */
  constructor(message, { status = null, cause, transient, body = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ProviderClientError";
    this.status = status;
    this.body = body;
    this.transient =
      typeof transient === "boolean"
        ? transient
        : status == null || status === 429 || status >= 500;
  }
}

/** @param {unknown} err */
export function isProviderClientError(err) {
  return (
    err instanceof ProviderClientError ||
    err?.name === "ProviderClientError" ||
    err?.name === "OllamaClientError"
  );
}

/**
 * True when the loop may retry the call.
 * @param {unknown} err
 */
export function isTransientProviderError(err) {
  if (!isProviderClientError(err)) return false;
  if (typeof err.transient === "boolean") return err.transient;
  const status = err.status;
  if (typeof status === "number" && status < 500 && status !== 429) return false;
  return true;
}

/**
 * Dynamically import an optional peer SDK. Keeps the package zero-deps by
 * default; callers get an actionable install hint when the peer is missing.
 *
 * @param {string} packageName
 * @param {string} [installHint]
 * @returns {Promise<any>}
 */
export async function importPeerSdk(packageName, installHint) {
  try {
    return await import(packageName);
  } catch (err) {
    const hint = installHint ?? `npm install ${packageName}`;
    throw new ProviderClientError(
      `Provider requires the optional peer package '${packageName}'. Install it where you run bf-agent (${hint}).`,
      { cause: err, transient: false },
    );
  }
}

export const KNOWN_PROVIDERS = Object.freeze(["ollama", "openai", "anthropic", "copilot"]);

/**
 * @param {string|undefined|null} raw
 * @returns {"ollama"|"openai"|"anthropic"|"copilot"}
 */
export function normalizeProvider(raw) {
  const value = String(raw ?? "ollama").trim().toLowerCase();
  if (KNOWN_PROVIDERS.includes(value)) return /** @type {any} */ (value);
  throw new ProviderClientError(
    `Unknown provider '${raw}'. Expected one of: ${KNOWN_PROVIDERS.join(", ")}.`,
    { transient: false },
  );
}
