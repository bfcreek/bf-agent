/**
 * User-facing model routing config (~/.config/halo-agent/models.yaml).
 * Tier presets and bands for the CLI and dev-bench. Separate from config.yaml.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveModelAuto } from "./model-routing.mjs";
import {
  DEFAULT_TIER_PRESET,
  normalizeTierModels,
  parseTierPresetArg,
  resolveEffectiveTierModels,
  resolveTierModel,
} from "./tier-models.mjs";
import { getConfigDir, openConfigInEditor, parseSimpleYaml } from "./user-config.mjs";

export const MODELS_CONFIG_FILE_NAME = "models.yaml";
export const DEFAULT_TASK_TIER = 2;

const MODELS_CONFIG_TEMPLATE = `# halo-agent model routing
# Used by the CLI and dev-bench to pick easy / medium / hard models.
# Run: halo-agent models config edit

# Preset: auto (detect local models), cloud (no GPU), hybrid, local
preset: auto

# Default task difficulty for a single CLI run (0=safety … 6=hardest).
default-tier: ${DEFAULT_TASK_TIER}

# Optional explicit bands (override preset):
# bands:
#   - through-tier: 1
#     model: glm-4.6:cloud
#   - through-tier: 3
#     model: kimi-k2.6:cloud
#   - model: kimi-k2.7-code:cloud
`;

/** @returns {string} */
export function getModelsConfigPath() {
  if (process.env.HALO_MODELS_CONFIG) {
    return path.resolve(process.env.HALO_MODELS_CONFIG);
  }
  return path.join(getConfigDir(), MODELS_CONFIG_FILE_NAME);
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {{ values: { tierPreset: string, defaultTier: number, tierModels: import("./tier-models.mjs").TierModelBand[]|null }, errors: string[] }}
 */
export function normalizeModelsConfigValues(raw) {
  const values = {
    tierPreset: DEFAULT_TIER_PRESET,
    defaultTier: DEFAULT_TASK_TIER,
    tierModels: null,
  };
  const errors = [];

  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;

    switch (key) {
      case "preset":
      case "tier-preset":
        try {
          values.tierPreset = parseTierPresetArg(String(value));
        } catch (err) {
          errors.push(err.message);
        }
        break;
      case "default-tier": {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0 && n <= 6) values.defaultTier = n;
        else errors.push(`models config 'default-tier' must be 0–6, got '${value}'.`);
        break;
      }
      case "bands":
      case "tier-models":
        try {
          values.tierModels = normalizeTierModels(value);
        } catch (err) {
          errors.push(err.message);
        }
        break;
      default:
        errors.push(`Unknown models config key '${key}'.`);
    }
  }

  return { values, errors };
}

/** @returns {Promise<{ values: ReturnType<typeof normalizeModelsConfigValues>["values"], errors: string[], path: string, exists: boolean }>} */
export async function loadModelsConfig() {
  const configPath = getModelsConfigPath();
  if (!existsSync(configPath)) {
    return {
      values: normalizeModelsConfigValues({}).values,
      errors: [],
      path: configPath,
      exists: false,
    };
  }

  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch (err) {
    return {
      values: normalizeModelsConfigValues({}).values,
      errors: [`Cannot read models config ${configPath}: ${err.message}`],
      path: configPath,
      exists: true,
    };
  }

  let raw;
  try {
    raw = parseSimpleYaml(text);
  } catch (err) {
    return {
      values: normalizeModelsConfigValues({}).values,
      errors: [`Invalid YAML in ${configPath}: ${err.message}`],
      path: configPath,
      exists: true,
    };
  }

  const { values, errors } = normalizeModelsConfigValues(raw);
  return { values, errors, path: configPath, exists: true };
}

/** @returns {Promise<string>} */
export async function ensureModelsConfigFile() {
  const configPath = getModelsConfigPath();
  await mkdir(path.dirname(configPath), { recursive: true });
  if (!existsSync(configPath)) {
    await writeFile(configPath, MODELS_CONFIG_TEMPLATE, "utf8");
  }
  return configPath;
}

/**
 * Resolve the Ollama model for a CLI or serve invocation.
 *
 * @param {object} options Parsed CLI options.
 * @param {string} options.model
 * @param {string|null} [options.tierPreset]
 * @param {number|null} [options.taskTier]
 * @param {string} options.baseUrl
 * @param {{listModelsDetailed?: Function, show?: Function}} client
 * @param {ReturnType<typeof normalizeModelsConfigValues>["values"]} [modelsConfig]
 * @param {boolean} [modelsConfigExists]
 */
export async function resolveCliModel(
  options,
  client,
  modelsConfig = normalizeModelsConfigValues({}).values,
  modelsConfigExists = false,
) {
  if (options.model && options.model !== "auto" && options.model !== "tier") {
    return resolveModelAuto({ requested: options.model, client });
  }

  const tierModels = await resolveEffectiveTierModels({
    cliTierPreset: options.tierPreset ?? null,
    userTierModels: modelsConfig.tierModels,
    userTierPreset: modelsConfig.tierPreset,
    baseUrl: options.baseUrl,
    client,
  });

  const useTier =
    options.model === "tier" ||
    options.tierPreset ||
    (options.model === "auto" && modelsConfigExists);

  if (!useTier || !tierModels?.length) {
    return resolveModelAuto({ requested: "auto", client });
  }

  const taskTier = options.taskTier ?? modelsConfig.defaultTier ?? DEFAULT_TASK_TIER;
  const bandModel = resolveTierModel(taskTier, tierModels, "auto");
  return resolveModelAuto({ requested: bandModel, client });
}

export { openConfigInEditor };
