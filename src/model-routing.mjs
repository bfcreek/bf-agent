/**
 * Model routing: resolve the requested model against what Ollama actually
 * has installed, and steer toward tool-capable models. Models without native
 * tool support either reject the request or silently ignore tool schemas,
 * so detecting that up front beats a confusing mid-run failure.
 */

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
 * Resolve a requested model against the installed list.
 *
 * @param {object} options
 * @param {string} options.requested Model the user asked for.
 * @param {string[]} options.installed Names from Ollama (usually tagged).
 * @returns {{model: string, warnings: string[]}} The model to use — the
 *   installed match, a tool-capable fallback, or the request unchanged when
 *   nothing better exists.
 */
export function resolveModel({ requested, installed }) {
  const warnings = [];
  if (!installed || installed.length === 0) {
    return { model: requested, warnings };
  }

  const match = findInstalled(requested, installed);
  if (match) {
    if (isLikelyToolCapable(match) === false) {
      warnings.push(
        `Model '${match}' likely does not support tool calling; the agent may not be able to use its tools.`,
      );
    }
    return { model: match, warnings };
  }

  const fallback = installed.find((name) => isLikelyToolCapable(name) === true);
  if (fallback) {
    warnings.push(`Model '${requested}' is not installed; falling back to '${fallback}'.`);
    return { model: fallback, warnings };
  }

  warnings.push(
    `Model '${requested}' is not installed and no tool-capable fallback was found. Ollama will likely reject the request.`,
  );
  return { model: requested, warnings };
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
