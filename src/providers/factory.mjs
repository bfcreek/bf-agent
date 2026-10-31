/**
 * Provider factory: Ollama (bundled default) or optional peer SDK clients.
 * Copilot is a nested worker — the returned client is the supervisor LLM.
 */

import { OllamaClient } from "../ollama-client.mjs";
import { KNOWN_PROVIDERS, normalizeProvider, ProviderClientError } from "../provider-client.mjs";
import { createAnthropicClient } from "./anthropic-client.mjs";
import {
  COPILOT_SUPERVISOR_OVERLAY,
  createCompletionGuard,
  createDelegationTracker,
  registerDelegateCopilotTool,
} from "./copilot-worker.mjs";
import { createOpenAIClient } from "./openai-client.mjs";

export { KNOWN_PROVIDERS, normalizeProvider };

/** Default Ollama URL from CLI builtins — not a valid OpenAI/Anthropic endpoint. */
const LOCAL_OLLAMA_URL = /^https?:\/\/(127\.0\.0\.1|localhost|::1|host\.docker\.internal)(:11434)?\/?$/i;

/**
 * Drop the CLI's Ollama default so peer SDKs use their public API defaults,
 * unless the caller passed a real custom gateway.
 * @param {string|undefined|null} baseUrl
 * @returns {string|undefined}
 */
export function peerBaseUrl(baseUrl) {
  const raw = String(baseUrl ?? "").trim();
  if (!raw || LOCAL_OLLAMA_URL.test(raw.replace(/\/+$/, ""))) return undefined;
  return raw;
}

/**
 * @typedef {object} ProviderSetup
 * @property {"ollama"|"openai"|"anthropic"|"copilot"} provider
 * @property {"llm"|"nested"} kind
 * @property {import("../provider-client.mjs").LlmClient} client
 * @property {"ollama"|"openai"|"anthropic"} [supervisorProvider]
 * @property {string} [worker]
 * @property {{calls: Array<object>}} [tracker]
 * @property {(opts: object) => void} [applyNested]
 */

/**
 * Create an LLM client (and nested-mode metadata for Copilot).
 *
 * @param {object} [options]
 * @param {string} [options.provider]
 * @param {string} [options.model]
 * @param {string} [options.baseUrl]
 * @param {string} [options.apiKey]
 * @param {number|null|"auto"} [options.numCtx]
 * @param {boolean|string} [options.think]
 * @param {string|number|null} [options.keepAlive] Ollama keep_alive per chat call
 * @param {string} [options.supervisorProvider] For provider=copilot
 * @param {string} [options.supervisorModel] For provider=copilot
 * @param {string} [options.supervisorBaseUrl]
 * @returns {Promise<ProviderSetup>}
 */
export async function createProviderClient({
  provider = "ollama",
  model,
  baseUrl,
  apiKey,
  numCtx,
  think,
  keepAlive,
  supervisorProvider,
  supervisorModel,
  supervisorBaseUrl,
} = {}) {
  const name = normalizeProvider(provider);

  if (name === "ollama") {
    const client = new OllamaClient({
      baseUrl,
      model: model ?? "llama3.2",
      ...(numCtx !== undefined ? { numCtx } : {}),
      ...(think !== undefined ? { think } : {}),
      ...(keepAlive !== undefined ? { keepAlive } : {}),
    });
    return { provider: "ollama", kind: "llm", client };
  }

  if (name === "openai") {
    // CLI defaults baseUrl to local Ollama; that must not become OpenAI's baseURL.
    const client = await createOpenAIClient({
      model,
      apiKey,
      baseUrl: peerBaseUrl(baseUrl),
    });
    return { provider: "openai", kind: "llm", client };
  }

  if (name === "anthropic") {
    const client = await createAnthropicClient({
      model,
      apiKey,
      baseUrl: peerBaseUrl(baseUrl),
    });
    return { provider: "anthropic", kind: "llm", client };
  }

  // Nested Copilot: outer loop driven by a supervisor LLM (default Ollama).
  // `--model` selects the Copilot worker model; supervisor uses
  // `--supervisor-model` (Ollama defaults to auto when omitted).
  const nestedSupervisor = normalizeProvider(supervisorProvider ?? "ollama");
  if (nestedSupervisor === "copilot") {
    throw new ProviderClientError(
      "supervisor-provider cannot be 'copilot' (nested workers are not recursive).",
      { transient: false },
    );
  }

  let resolvedSupervisorModel = supervisorModel;
  if (resolvedSupervisorModel == null || resolvedSupervisorModel === "") {
    if (nestedSupervisor === "ollama") resolvedSupervisorModel = "auto";
    else {
      throw new ProviderClientError(
        `Copilot nested mode with supervisor-provider=${nestedSupervisor} requires --supervisor-model.`,
        { transient: false },
      );
    }
  }

  const supervisor = await createProviderClient({
    provider: nestedSupervisor,
    model: resolvedSupervisorModel,
    baseUrl: supervisorBaseUrl ?? (nestedSupervisor === "ollama" ? baseUrl : undefined),
    apiKey,
    numCtx,
    think,
    keepAlive,
  });

  const tracker = createDelegationTracker();
  const workerModel = model && model !== "auto" ? model : undefined;

  return {
    provider: "copilot",
    kind: "nested",
    client: supervisor.client,
    supervisorProvider: nestedSupervisor,
    worker: "copilot",
    tracker,
    applyNested({ registry, hooks = {}, workspaceRoot, onDelta, approvalHandler } = {}) {
      registerDelegateCopilotTool(registry, {
        workspaceRoot,
        tracker,
        model: workerModel,
        onDelta,
        approvalHandler,
      });
      const stop = createCompletionGuard({ tracker, inner: hooks.stop });
      return {
        hooks: { ...hooks, stop },
        systemOverlay: COPILOT_SUPERVISOR_OVERLAY,
      };
    },
  };
}

/** True when model auto-routing / Ollama tags apply. */
export function providerUsesOllamaRouting(provider) {
  const name = normalizeProvider(provider);
  if (name === "ollama") return true;
  if (name === "copilot") return true; // supervisor defaults to ollama routing
  return false;
}

/**
 * Whether the given provider setup should run Ollama model auto-routing on
 * the returned client.
 * @param {ProviderSetup} setup
 */
export function shouldRouteOllamaModel(setup) {
  if (!setup) return false;
  if (setup.provider === "ollama") return true;
  if (setup.provider === "copilot" && setup.supervisorProvider === "ollama") return true;
  return false;
}
