/**
 * Model routing: resolve the requested model against what Ollama actually
 * has installed, and only accept tool-capable models. Models without native
 * tool support either reject the request or silently ignore tool schemas,
 * so detecting that up front beats a confusing mid-run failure.
 */

export class ModelRoutingError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelRoutingError";
  }
}

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
 * Ask Ollama itself whether a model supports tool calling: `/api/show`
 * reports a `capabilities` array. Accurate for any installed model — the
 * family regexes above are only the fallback for older Ollama versions or
 * when the probe fails.
 *
 * @param {{show?: Function}} client
 * @param {string} name Installed model name.
 * @returns {Promise<boolean|null>} Same contract as isLikelyToolCapable.
 */
export async function detectToolCapable(client, name) {
  if (client?.show) {
    try {
      const info = await client.show({ model: name });
      if (Array.isArray(info?.capabilities)) {
        return info.capabilities.includes("tools");
      }
    } catch {
      // old Ollama or transient failure — fall back to the family list
    }
  }
  return isLikelyToolCapable(name);
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
