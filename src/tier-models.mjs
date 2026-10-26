/**
 * Tier-based model routing: map scenario difficulty tiers to Ollama models.
 * Presets and explicit bands live in ~/.config/halo-agent/models.yaml; bench
 * config can override per project.
 *
 * Each band has a primary `model` and an optional `vision` model used when
 * the request carries image attachments (same band / tier selection rules).
 */

import { DEFAULT_THINK, OllamaClient } from "./ollama-client.mjs";
import { PINNED_MODELS, suggestModel } from "./model-routing.mjs";

export { PINNED_MODELS };

/** @typedef {{throughTier?: number, model: string, vision?: string}} TierModelBand */

export const DEFAULT_TIER_PRESET = "auto";

/**
 * Presets are built from the two pinned lines (PINNED_MODELS): the local pin
 * wherever local is allowed, the cloud pin wherever cloud is allowed.
 * `cloud-max` is the same cloud pin at maximum reasoning effort — not a
 * different model.
 *
 * @type {Record<string, TierModelBand[]>}
 */
export const TIER_PRESETS = {
  /** Ollama cloud only — no local GPU or RAM required. */
  cloud: [{ model: PINNED_MODELS.cloud, vision: PINNED_MODELS.cloud }],
  /** Cloud pin only, at max think (see getTierPresetPolicy). */
  "cloud-max": [{ model: PINNED_MODELS.cloud, vision: PINNED_MODELS.cloud }],
  /** Pinned local model for easy/medium work; pinned cloud model for hard tiers. */
  hybrid: [
    { throughTier: 3, model: PINNED_MODELS.local, vision: "devstral-small-2" },
    { model: PINNED_MODELS.cloud, vision: PINNED_MODELS.cloud },
  ],
  /** Pinned local model only — needs a capable GPU and enough RAM/VRAM. */
  local: [{ model: PINNED_MODELS.local, vision: "devstral-small-2" }],
};

const VALID_PRESETS = new Set(["auto", ...Object.keys(TIER_PRESETS)]);

/** Human-readable list for CLI help and parse errors. */
export const TIER_PRESET_HELP = formatPresetList(["auto", ...Object.keys(TIER_PRESETS)]);

/**
 * @param {string[]} names
 * @returns {string}
 */
function formatPresetList(names) {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function parseTierPresetArg(raw) {
  const name = String(raw ?? "").trim().toLowerCase();
  if (!VALID_PRESETS.has(name)) {
    throw new Error(`Unknown tier preset '${raw}'. Use ${TIER_PRESET_HELP}.`);
  }
  return name;
}

/**
 * Quality / routing policy implied by a named preset.
 * `cloud-max` keeps the run on the pinned cloud model at maximum reasoning effort.
 *
 * @param {string|null|undefined} preset
 * @returns {{think: string|null, cloudOnly: boolean}}
 */
export function getTierPresetPolicy(preset) {
  if (preset === "cloud-max") {
    return { think: "max", cloudOnly: true };
  }
  return { think: null, cloudOnly: false };
}

/**
 * Harbor (and similar wrappers) pass `--model "tier-preset cloud-max"` as if
 * that string were an Ollama tag. Treat it as `--tier-preset` + `auto` so
 * routing does not silently fall back to a weaker local model.
 *
 * @param {object} options
 * @returns {object} The same options object.
 */
export function coerceTierPresetModel(options) {
  const raw = String(options?.model ?? "").trim();
  const match = /^tier-preset\s+(\S+)/i.exec(raw);
  if (!match) return options;
  try {
    const preset = parseTierPresetArg(match[1]);
    if (!options.tierPreset) options.tierPreset = preset;
    options.model = "auto";
  } catch {
    // Unknown preset token — leave the model string for routing to report.
  }
  return options;
}

/**
 * Apply preset quality defaults without clobbering explicit overrides.
 *
 * @param {object} options
 * @param {string|null|undefined} preset
 * @param {object} [flags]
 * @param {boolean} [flags.thinkExplicit]
 * @returns {object} The same options object.
 */
export function applyTierPresetPolicy(options, preset, flags = {}) {
  const policy = getTierPresetPolicy(preset);
  if (policy.think && !flags.thinkExplicit && (options.think == null || options.think === DEFAULT_THINK)) {
    options.think = policy.think;
  }
  options.cloudOnly = policy.cloudOnly === true;
  return options;
}

/**
 * Pick the band for a difficulty tier, then return its primary or vision model.
 *
 * @param {number} tier
 * @param {TierModelBand[]|null|undefined} tierModels
 * @param {string} fallback
 * @param {{requireVision?: boolean}} [options]
 * @returns {string}
 */
export function resolveTierModel(tier, tierModels, fallback, { requireVision = false } = {}) {
  if (!tierModels?.length) return fallback;
  let band = null;
  for (const candidate of tierModels) {
    if (candidate.throughTier == null) continue;
    if (tier <= candidate.throughTier) {
      band = candidate;
      break;
    }
  }
  if (!band) band = tierModels[tierModels.length - 1];
  if (!band) return fallback;
  if (requireVision && band.vision) return band.vision;
  return band.model || fallback;
}

/**
 * @param {TierModelBand[]|null|undefined} tierModels
 * @returns {string[]}
 */
export function uniqueTierModels(tierModels) {
  if (!tierModels?.length) return [];
  const seen = new Set();
  const out = [];
  for (const band of tierModels) {
    for (const name of [band.model, band.vision]) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * @param {unknown} band
 * @param {number} index
 * @returns {TierModelBand}
 */
export function normalizeTierModelBand(band, index) {
  if (!band || typeof band !== "object" || Array.isArray(band)) {
    throw new Error(`tier-models[${index}] must be an object with model.`);
  }
  const raw = /** @type {Record<string, unknown>} */ (band);
  const model = raw.model ?? raw.Model;
  const throughTier = raw.throughTier ?? raw["through-tier"];
  const vision = raw.vision ?? raw.Vision;
  if (typeof model !== "string" || !model.trim()) {
    throw new Error(`tier-models[${index}] requires a model string.`);
  }
  if (throughTier != null && !Number.isFinite(Number(throughTier))) {
    throw new Error(`tier-models[${index}].through-tier must be a number when set.`);
  }
  if (vision != null && (typeof vision !== "string" || !vision.trim())) {
    throw new Error(`tier-models[${index}].vision must be a model string when set.`);
  }
  return {
    model: model.trim(),
    ...(throughTier != null ? { throughTier: Number(throughTier) } : {}),
    ...(vision != null ? { vision: String(vision).trim() } : {}),
  };
}

/** @param {unknown} raw */
export function normalizeTierModels(raw) {
  if (raw == null) return null;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("tier-models must be a non-empty list of { through-tier?, model, vision? } bands.");
  }
  return raw.map((band, index) => normalizeTierModelBand(band, index));
}

/**
 * @param {string} preset
 * @returns {TierModelBand[]}
 */
export function getTierPresetBands(preset) {
  const bands = TIER_PRESETS[preset];
  if (!bands) {
    throw new Error(`Unknown tier preset '${preset}'. Use ${TIER_PRESET_HELP}.`);
  }
  return bands.map((band) => ({ ...band }));
}

/**
 * Pick hybrid when a suitable local model is installed; otherwise cloud.
 *
 * @param {object} [options]
 * @param {{listModelsDetailed?: Function}} [options.client]
 * @param {string} [options.baseUrl]
 * @returns {Promise<"cloud"|"hybrid">}
 */
export async function detectAutoTierPreset({ client, baseUrl = "http://127.0.0.1:11434" } = {}) {
  try {
    const probe = client ?? new OllamaClient({ baseUrl });
    const models = await probe.listModelsDetailed();
    const suggestion = await suggestModel({ client: probe, models });
    if (suggestion && !suggestion.cloud) return "hybrid";
  } catch {
    // Ollama unreachable or no models — default to cloud (no GPU required).
  }
  return "cloud";
}

/**
 * @param {string} preset
 * @param {object} [options]
 * @param {{listModelsDetailed?: Function}} [options.client]
 * @param {string} [options.baseUrl]
 * @returns {Promise<TierModelBand[]>}
 */
export async function resolveTierPreset(preset, options = {}) {
  const name = parseTierPresetArg(preset || DEFAULT_TIER_PRESET);
  if (!VALID_PRESETS.has(name)) {
    throw new Error(`Unknown tier preset '${preset}'. Use ${TIER_PRESET_HELP}.`);
  }
  const resolved = name === "auto" ? await detectAutoTierPreset(options) : name;
  return getTierPresetBands(resolved);
}

/**
 * Merge bench file config with user config tier routing.
 *
 * Priority: bench tierModels (when set) > CLI tierPreset > user tierModels > user tierPreset.
 *
 * @param {object} options
 * @param {TierModelBand[]|null} [options.benchTierModels]
 * @param {boolean} [options.benchTierModelsExplicit]
 * @param {string|null} [options.cliTierPreset]
 * @param {TierModelBand[]|null} [options.userTierModels]
 * @param {string} [options.userTierPreset]
 * @param {string} [options.baseUrl]
 * @param {{listModelsDetailed?: Function}} [options.client]
 * @returns {Promise<TierModelBand[]|null>}
 */
export async function resolveEffectiveTierModels({
  benchTierModels = null,
  benchTierModelsExplicit = false,
  cliTierPreset = null,
  userTierModels = null,
  userTierPreset = DEFAULT_TIER_PRESET,
  baseUrl = "http://127.0.0.1:11434",
  client = null,
} = {}) {
  if (benchTierModelsExplicit) {
    return benchTierModels;
  }
  if (cliTierPreset) {
    return resolveTierPreset(cliTierPreset, { client, baseUrl });
  }
  if (userTierModels?.length) {
    return userTierModels;
  }
  return resolveTierPreset(userTierPreset, { client, baseUrl });
}
