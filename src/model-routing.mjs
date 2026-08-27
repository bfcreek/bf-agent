/**
 * Model routing: resolve the requested model against what Ollama actually
 * has installed, and only accept tool-capable models. Models without native
 * tool support either reject the request or silently ignore tool schemas,
 * so detecting that up front beats a confusing mid-run failure.
 *
 * Auto-selection (`--model auto`, the default) goes further: it picks the
 * strongest installed model that is tool-capable AND thinking-capable, at
 * least MIN_EFFECTIVE_PARAMS_B parameters, and fits in memory. A weak model
 * that flails through an agent task wastes more than it saves, so when no
 * local model qualifies, installed Ollama cloud models are used instead —
 * local-first, cloud only when we must.
 */

import os from "node:os";

export class ModelRoutingError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelRoutingError";
  }
}

/** Below this many billions of parameters, agent tasks mostly fail. */
export const MIN_EFFECTIVE_PARAMS_B = 7;

/** A local model should fit in this share of total memory to run comfortably. */
export const MEMORY_FIT_FRACTION = 0.5;

/** Families whose Ollama templates support native tool calling. */
const TOOL_CAPABLE = [
  /^llama3\.[123]/,
  /^llama4/,
  /^qwen2\.5/,
  /^qwen3/,
  /^qwq/,
  /^mistral/,
  /^mixtral/,
  /^devstral/,
  /^magistral/,
  /^command-r/,
  /^firefunction/,
  /^hermes3/,
  /^gpt-oss/,
  /^granite3/,
  /^nemotron/,
  /^smollm2/,
];

/** Families known to lack tool calling (vision, embedding, legacy chat). */
const NOT_TOOL_CAPABLE = [
  /^gemma/,
  /^llama2/,
  /^llava/,
  /^minicpm/,
  /^phi3/,
  /embed/,
  /vision/,
  /(^|[^a-z])vl\b/,
  /^qwen2\.5vl/,
];

/**
 * Families whose templates support thinking/reasoning. Fallback only —
 * /api/show capabilities is the real source (see detectCapabilities).
 * qwen3-coder is explicitly non-thinking, hence the lookahead.
 */
const THINKING_CAPABLE = [
  /^qwen3(?!-coder)/,
  /^qwq/,
  /^gpt-oss/,
  /^deepseek-r1/,
  /^magistral/,
  /^phi4-reasoning/,
  /^exaone-deep/,
];

/**
 * @param {string} name Model name, with or without a tag.
 * @returns {boolean|null} true/false when the family is known, null when unknown.
 */
export function isLikelyToolCapable(name) {
  const base = String(name).toLowerCase();
  if (NOT_TOOL_CAPABLE.some((re) => re.test(base))) return false;
  if (TOOL_CAPABLE.some((re) => re.test(base))) return true;
  return null;
}

/**
 * @param {string} name
 * @throws {ModelRoutingError} When the family is known to lack tools or is unknown.
 */
export function assertToolCapable(name) {
  const capable = isLikelyToolCapable(name);
  if (capable === true) return;
  if (capable === false) {
    throw new ModelRoutingError(
      `Model '${name}' does not support tool calling. Choose a tool-capable model (e.g. llama3.2, qwen3-coder).`,
    );
  }
  throw new ModelRoutingError(
    `Model '${name}' is not a known tool-capable family. Choose a model with native tool support (e.g. llama3.2, qwen3-coder).`,
  );
}

/**
 * @param {string} name
 * @returns {boolean|null} true when the family is known to think, null when unknown.
 */
export function isLikelyThinkingCapable(name) {
  const base = String(name).toLowerCase();
  if (THINKING_CAPABLE.some((re) => re.test(base))) return true;
  return null;
}

/** Ollama cloud models carry a -cloud / :cloud suffix and run remotely. */
export function isCloudModel(name) {
  return /(-|:)cloud$/i.test(String(name));
}

/**
 * Parse Ollama's human parameter-size string ("20.9B", "1T", "500M") into
 * billions. Falls back to estimating from the file size (~0.6 bytes per
 * parameter at the common q4 quantization) and returns 0 when unknowable.
 *
 * @param {string} parameterSize
 * @param {number} [sizeBytes]
 * @returns {number} Parameters in billions.
 */
export function parseParamsBillions(parameterSize, sizeBytes = 0) {
  const match = /^([\d.]+)\s*([bmt])/i.exec(String(parameterSize).trim());
  if (match) {
    const value = Number.parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (Number.isFinite(value)) {
      if (unit === "t") return value * 1000;
      if (unit === "m") return value / 1000;
      return value;
    }
  }
  if (sizeBytes > 0) return sizeBytes / 0.6e9;
  return 0;
}

/**
 * Ask Ollama itself what a model supports: `/api/show` reports a
 * `capabilities` array ("tools", "thinking", ...). Accurate for any
 * installed model — the family regexes above are only the fallback for
 * older Ollama versions or when the probe fails.
 *
 * @param {{show?: Function}} client
 * @param {string} name Installed model name.
 * @returns {Promise<{tools: boolean|null, thinking: boolean|null}>}
 */
export async function detectCapabilities(client, name) {
  if (client?.show) {
    try {
      const info = await client.show({ model: name });
      if (Array.isArray(info?.capabilities)) {
        return {
          tools: info.capabilities.includes("tools"),
          thinking: info.capabilities.includes("thinking"),
        };
      }
    } catch {
      // old Ollama or transient failure — fall back to the family lists
    }
  }
  return { tools: isLikelyToolCapable(name), thinking: isLikelyThinkingCapable(name) };
}

/**
 * @param {{show?: Function}} client
 * @param {string} name Installed model name.
 * @returns {Promise<boolean|null>} Same contract as isLikelyToolCapable.
 */
export async function detectToolCapable(client, name) {
  return (await detectCapabilities(client, name)).tools;
}

/**
 * Pick the strongest suitable installed model. Requirements: tool calling
 * and thinking (both improve agent reliability), at least
 * MIN_EFFECTIVE_PARAMS_B parameters (below that agent tasks mostly fail),
 * and — for local models — a file size that fits comfortably in memory.
 * Local models win when any qualify; otherwise installed Ollama cloud
 * models are considered, since a capable cloud model beats an ineffective
 * local one.
 *
 * @param {object} options
 * @param {{show?: Function}} options.client Capability probe.
 * @param {Array<{name: string, sizeBytes?: number, parameterSize?: string}>} options.models
 *   Installed models (from listModelsDetailed, or bare {name} objects).
 * @param {number} [options.totalMemBytes] Defaults to this machine's RAM.
 * @param {number} [options.vramBytes] Pass 0 to ignore the GPU, omit to probe.
 * @returns {Promise<{model: string, paramsB: number, cloud: boolean, reason: string}|null>}
 */
export async function suggestModel({ client, models, totalMemBytes = os.totalmem(), vramBytes }) {
  const { resolveModelFitBudget } = await import("./hardware.mjs");
  const { budgetBytes: memoryBudget } = await resolveModelFitBudget({ totalMemBytes, vramBytes });
  const locals = [];
  const clouds = [];

  for (const entry of models ?? []) {
    const { tools, thinking } = await detectCapabilities(client, entry.name);
    if (tools !== true || thinking !== true) continue;
    const paramsB = parseParamsBillions(entry.parameterSize ?? "", entry.sizeBytes ?? 0);
    if (paramsB < MIN_EFFECTIVE_PARAMS_B) continue;
    if (isCloudModel(entry.name)) {
      clouds.push({ name: entry.name, paramsB });
    } else if (!entry.sizeBytes || entry.sizeBytes <= memoryBudget) {
      locals.push({ name: entry.name, paramsB });
    }
  }

  const best = (list) =>
    list.sort((a, b) => b.paramsB - a.paramsB || a.name.localeCompare(b.name))[0];

  const local = best(locals);
  if (local) {
    return {
      model: local.name,
      paramsB: local.paramsB,
      cloud: false,
      reason: `strongest local model with thinking + tools that fits in memory (${Math.round(local.paramsB)}B parameters)`,
    };
  }
  const cloud = best(clouds);
  if (cloud) {
    return {
      model: cloud.name,
      paramsB: cloud.paramsB,
      cloud: true,
      reason: "no local model is strong enough (thinking + tools, " +
        `>=${MIN_EFFECTIVE_PARAMS_B}B parameters, fitting in memory); using an installed Ollama cloud model`,
    };
  }
  return null;
}

const NO_SUITABLE_MODEL_HELP =
  `No installed model is suitable for agent use (needs tool calling + thinking, ` +
  `>=${MIN_EFFECTIVE_PARAMS_B}B parameters, and to fit in memory). ` +
  "Pull a stronger local model (e.g. ollama pull qwen3:14b) or an Ollama cloud model " +
  "(e.g. ollama pull gpt-oss:120b-cloud), or pass --model to override.";

/**
 * Resolve the model for a run. "auto" (or empty) picks the best installed
 * model via suggestModel. An explicit name is honored as long as it is
 * installed and tool-capable — thinking and the size floor are advisory
 * (warning) for explicit choices, never blocking.
 *
 * @param {object} options
 * @param {string} [options.requested] Model name or "auto".
 * @param {{show?: Function, listModelsDetailed: Function}} options.client
 * @param {number} [options.totalMemBytes]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{model: string, warnings: string[]}>}
 * @throws {ModelRoutingError} When nothing suitable can be used.
 */
export async function resolveModelAuto({ requested, client, totalMemBytes, signal }) {
  const warnings = [];
  const models = await client.listModelsDetailed({ signal });
  const auto = !requested || requested === "auto";

  if (!auto) {
    const match = findInstalled(requested, models.map((m) => m.name));
    if (match) {
      const { tools, thinking } = await detectCapabilities(client, match);
      if (tools === false) {
        throw new ModelRoutingError(
          `Model '${match}' does not support tool calling. Choose a tool-capable model or use --model auto.`,
        );
      }
      if (tools === null) {
        warnings.push(`Could not verify that '${match}' supports tool calling; continuing anyway.`);
      }
      const entry = models.find((m) => m.name === match);
      const paramsB = parseParamsBillions(entry?.parameterSize ?? "", entry?.sizeBytes ?? 0);
      if (paramsB > 0 && paramsB < MIN_EFFECTIVE_PARAMS_B) {
        warnings.push(
          `Model '${match}' (~${paramsB.toFixed(1)}B parameters) may be too weak for agent tasks; --model auto picks the strongest installed model.`,
        );
      } else if (thinking === false) {
        warnings.push(
          `Model '${match}' does not support thinking; thinking models tend to be more reliable agents.`,
        );
      }
      const { resolveModelFitBudget } = await import("./hardware.mjs");
      const budget = await resolveModelFitBudget({ totalMemBytes });
      if (
        budget.basis === "vram" &&
        !isCloudModel(match) &&
        entry?.sizeBytes > budget.budgetBytes
      ) {
        const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
        warnings.push(
          `Model '${match}' (${gb(entry.sizeBytes)}) exceeds the ${gb(budget.budgetBytes)} that fits on a ${gb(budget.vramBytes)} GPU; Ollama will run part of it on the CPU, which is much slower.`,
        );
      }
      return { model: match, warnings };
    }
    if (models.length === 0) {
      assertToolCapable(requested);
      warnings.push(`Could not verify '${requested}' is installed; Ollama returned no models.`);
      return { model: requested, warnings };
    }
    warnings.push(`Model '${requested}' is not installed; auto-selecting instead.`);
  }

  const suggestion = await suggestModel({ client, models, totalMemBytes });
  if (!suggestion) throw new ModelRoutingError(NO_SUITABLE_MODEL_HELP);
  warnings.push(`Using '${suggestion.model}': ${suggestion.reason}.`);
  return { model: suggestion.model, warnings };
}

/**
 * Resolve a requested model against the installed list, asking Ollama for
 * real capabilities when a client is provided (see detectToolCapable).
 *
 * @param {object} options
 * @param {string} options.requested Model the user asked for.
 * @param {string[]} options.installed Names from Ollama (usually tagged).
 * @param {{show?: Function}} [options.client] Enables the capability probe.
 * @returns {Promise<{model: string, warnings: string[]}>}
 * @throws {ModelRoutingError} When no tool-capable model can be used.
 */
export async function resolveModelDetected({ requested, installed, client }) {
  const warnings = [];
  if (!installed || installed.length === 0) {
    assertToolCapable(requested);
    warnings.push(`Could not verify '${requested}' is installed; Ollama returned no models.`);
    return { model: requested, warnings };
  }

  const match = findInstalled(requested, installed);
  if (match) {
    const capable = await detectToolCapable(client, match);
    if (capable === false) {
      throw new ModelRoutingError(
        `Model '${match}' does not support tool calling. Choose a tool-capable model (e.g. llama3.2, qwen3-coder).`,
      );
    }
    if (capable === null) {
      // Regexes could not classify it and the probe was unavailable — run
      // with it rather than refusing a model the user explicitly installed.
      warnings.push(
        `Could not verify that '${match}' supports tool calling; continuing anyway.`,
      );
    }
    return { model: match, warnings };
  }

  for (const name of installed) {
    if ((await detectToolCapable(client, name)) === true) {
      warnings.push(`Model '${requested}' is not installed; falling back to '${name}'.`);
      return { model: name, warnings };
    }
  }

  throw new ModelRoutingError(
    `Model '${requested}' is not installed and no tool-capable model was found. Install one with: ollama pull llama3.2`,
  );
}

/**
 * Resolve a requested model against the installed list.
 *
 * @param {object} options
 * @param {string} options.requested Model the user asked for.
 * @param {string[]} options.installed Names from Ollama (usually tagged).
 * @returns {{model: string, warnings: string[]}} The installed tool-capable
 *   match or a tool-capable fallback.
 * @throws {ModelRoutingError} When no tool-capable model can be used.
 */
export function resolveModel({ requested, installed }) {
  const warnings = [];
  if (!installed || installed.length === 0) {
    assertToolCapable(requested);
    warnings.push(
      `Could not verify '${requested}' is installed; Ollama returned no models.`,
    );
    return { model: requested, warnings };
  }

  const match = findInstalled(requested, installed);
  if (match) {
    assertToolCapable(match);
    return { model: match, warnings };
  }

  const fallback = installed.find((name) => isLikelyToolCapable(name) === true);
  if (fallback) {
    warnings.push(`Model '${requested}' is not installed; falling back to '${fallback}'.`);
    return { model: fallback, warnings };
  }

  throw new ModelRoutingError(
    `Model '${requested}' is not installed and no tool-capable model was found. Install one with: ollama pull llama3.2`,
  );
}

/**
 * Group installed Ollama model names by tool-calling compliance.
 *
 * @param {string[]} installed Names from Ollama (usually tagged).
 * @returns {{compliant: string[], notCompliant: string[], unknown: string[]}}
 */
export function listClassifiedModels(installed) {
  const compliant = [];
  const notCompliant = [];
  const unknown = [];
  for (const name of installed ?? []) {
    const capable = isLikelyToolCapable(name);
    if (capable === true) compliant.push(name);
    else if (capable === false) notCompliant.push(name);
    else unknown.push(name);
  }
  const byName = (a, b) => a.localeCompare(b);
  compliant.sort(byName);
  notCompliant.sort(byName);
  unknown.sort(byName);
  return { compliant, notCompliant, unknown };
}

/**
 * Like listClassifiedModels, but probing each model's real capabilities via
 * the client (see detectToolCapable).
 *
 * @param {{show?: Function}} client
 * @param {string[]} installed
 * @returns {Promise<{compliant: string[], notCompliant: string[], unknown: string[]}>}
 */
export async function listClassifiedModelsDetected(client, installed) {
  const compliant = [];
  const notCompliant = [];
  const unknown = [];
  for (const name of installed ?? []) {
    const capable = await detectToolCapable(client, name);
    if (capable === true) compliant.push(name);
    else if (capable === false) notCompliant.push(name);
    else unknown.push(name);
  }
  const byName = (a, b) => a.localeCompare(b);
  compliant.sort(byName);
  notCompliant.sort(byName);
  unknown.sort(byName);
  return { compliant, notCompliant, unknown };
}

/** Exact match, then `name:latest`, then any tag of the same base name. */
function findInstalled(requested, installed) {
  if (installed.includes(requested)) return requested;
  if (!requested.includes(":")) {
    const latest = `${requested}:latest`;
    if (installed.includes(latest)) return latest;
    const tagged = installed.find((name) => name.split(":")[0] === requested);
    if (tagged) return tagged;
  }
  return null;
}
