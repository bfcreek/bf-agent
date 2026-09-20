/**
 * Dev-bench checkpoint: save progress after each scenario so an interrupted
 * run can resume without re-running completed scenarios.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const CHECKPOINT_VERSION = 1;
export const DEFAULT_CHECKPOINT_REL = ".halo-agent/bench-checkpoint.json";
const CHECKPOINT_FILE_RE = /^bench-checkpoint(?:-(.+))?\.json$/;

/**
 * Stable key for a bench run — changes when scenario set or core options differ.
 *
 * @param {string[]} scenarioNames Ordered scenario names for this run.
 * @param {object} options Parsed bench options.
 */
export function buildRunKey(scenarioNames, options) {
  const payload = {
    scenarios: scenarioNames,
    models: options.models,
    tierModels: options.tierModels ?? null,
    tierPreset: options.tierPreset ?? null,
    skipJudge: options.skipJudge,
    progression: options.progression,
    stopBelowScore: options.stopBelowScore,
    maxTier: options.maxTier,
    minTier: options.minTier,
    languageFilter: options.languageFilter ?? null,
    judgeModel: options.judgeModel,
    think: options.think ?? null,
    keepWorkspace: options.keepWorkspace,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

/**
 * @param {string[]} scenarioNames
 * @param {object} options
 */
export function describeRunSelection(scenarioNames, options) {
  let label;
  if (options.scenarioFilter) label = `scenario ${options.scenarioFilter}`;
  else if (options.scenarioList?.length) label = `scenarios: ${options.scenarioList.join(", ")}`;
  else if (options.maxTier != null && options.minTier == null) {
    const tierLabel = `tier ≤${options.maxTier}`;
    label = options.progression ? `${tierLabel} (progression)` : `${tierLabel} (flat)`;
  } else if (options.minTier != null) label = `tier ≥${options.minTier}`;
  else label = options.progression ? `all scenarios (progression)` : `all scenarios (flat)`;

  if (options.languageFilter?.length) {
    return `language ${options.languageFilter.join("+")}, ${label}`;
  }
  return label;
}

/**
 * @param {string} checkpointPath Absolute or cwd-relative path.
 */
export function resolveCheckpointPath(checkpointPath = DEFAULT_CHECKPOINT_REL) {
  return path.resolve(checkpointPath);
}

/**
 * Per-language checkpoint next to the default file.
 * `--language csharp` → `.halo-agent/bench-checkpoint-csharp.json`
 *
 * @param {string[]|null|undefined} languageFilter
 * @param {string} [baseRel]
 */
export function checkpointRelForLanguage(languageFilter, baseRel = DEFAULT_CHECKPOINT_REL) {
  const langs = Array.isArray(languageFilter) ? languageFilter.filter(Boolean) : [];
  const posixBase = String(baseRel).replaceAll("\\", "/");
  if (!langs.length) return posixBase;
  const dir = path.posix.dirname(posixBase);
  const file = `bench-checkpoint-${[...langs].sort().join("+")}.json`;
  return dir === "." ? file : `${dir}/${file}`;
}

/**
 * @param {object|null} checkpoint
 * @returns {string[]|null}
 */
export function languageFilterFromCheckpoint(checkpoint) {
  if (checkpoint?.languageFilter?.length) return [...checkpoint.languageFilter];
  const label = String(checkpoint?.selectionLabel ?? "");
  const match = label.match(/^language ([^,]+), /);
  if (!match) return null;
  const langs = match[1].split("+").map((part) => part.trim()).filter(Boolean);
  return langs.length ? langs : null;
}

/**
 * @param {string} [dirRel]
 * @returns {Promise<{path: string, fileName: string, languageKey: string|null, languageFilter: string[]|null, record: object}[]>}
 */
export async function listCheckpoints(dirRel = path.posix.dirname(DEFAULT_CHECKPOINT_REL)) {
  const dir = path.resolve(dirRel);
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }

  const found = [];
  for (const fileName of names) {
    const match = fileName.match(CHECKPOINT_FILE_RE);
    if (!match) continue;
    const fullPath = path.join(dir, fileName);
    const record = await loadCheckpoint(fullPath);
    if (!record) continue;
    found.push({
      path: fullPath,
      fileName,
      languageKey: match[1] ?? null,
      languageFilter: languageFilterFromCheckpoint(record) ?? (match[1] ? match[1].split("+") : null),
      record,
    });
  }
  return found;
}

/**
 * @param {string} [dirRel]
 * @returns {Promise<string[]>} Cleared absolute paths.
 */
export async function clearAllCheckpoints(dirRel = path.posix.dirname(DEFAULT_CHECKPOINT_REL)) {
  const dir = path.resolve(dirRel);
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }

  const cleared = [];
  for (const fileName of names) {
    if (!CHECKPOINT_FILE_RE.test(fileName)) continue;
    const fullPath = path.join(dir, fileName);
    await clearCheckpoint(fullPath);
    cleared.push(fullPath);
  }
  return cleared;
}

/**
 * @param {string} checkpointPath
 * @returns {Promise<object|null>}
 */
export async function loadCheckpoint(checkpointPath) {
  const target = resolveCheckpointPath(checkpointPath);
  try {
    const raw = JSON.parse(await readFile(target, "utf8"));
    if (raw?.version !== CHECKPOINT_VERSION) return null;
    return raw;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * @param {string} checkpointPath
 */
export async function clearCheckpoint(checkpointPath) {
  const target = resolveCheckpointPath(checkpointPath);
  try {
    await rm(target, { force: true });
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

/**
 * @param {string} checkpointPath
 * @param {object} data
 */
export async function saveCheckpoint(checkpointPath, data) {
  const target = resolveCheckpointPath(checkpointPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(data, null, 2), "utf8");
}

/**
 * @param {object|null} checkpoint
 * @param {string} runKey
 * @param {string[]} scenarioNames
 */
export function checkpointMatchesRun(checkpoint, runKey, scenarioNames) {
  if (!checkpoint) return false;
  if (checkpoint.runKey !== runKey) return false;
  const saved = checkpoint.scenarioNames ?? [];
  if (saved.length !== scenarioNames.length) return false;
  return saved.every((name, i) => name === scenarioNames[i]);
}

/**
 * @param {object} params
 * @param {string} params.runKey
 * @param {string} params.selectionLabel
 * @param {string[]} params.scenarioNames
 * @param {string[]} params.completedNames
 * @param {object[]} params.results
 * @param {string} params.startedAt
 * @param {string[]|null} [params.languageFilter]
 * @param {string|null} [params.resolvedModel]
 * @param {number|null} [params.stoppedAtTier]
 * @param {string|null} [params.stopReason]
 */
export function buildCheckpointRecord({
  runKey,
  selectionLabel,
  scenarioNames,
  completedNames,
  results,
  startedAt,
  languageFilter = null,
  resolvedModel = null,
  stoppedAtTier = null,
  stopReason = null,
}) {
  return {
    version: CHECKPOINT_VERSION,
    runKey,
    selectionLabel,
    scenarioNames,
    completedNames,
    results,
    startedAt,
    updatedAt: new Date().toISOString(),
    languageFilter: languageFilter?.length ? [...languageFilter] : null,
    resolvedModel,
    stoppedAtTier,
    stopReason,
  };
}

/** True when the scenario timed out / was aborted — record the miss, keep going. */
export function isScenarioTimeoutError(error) {
  const msg = String(error ?? "");
  return /aborted|timed out|\btimeout\b/i.test(msg);
}

/** True when the Cursor judge returned unusable JSON — keep agent results, keep going. */
export function isJudgeJsonError(error) {
  const msg = String(error ?? "");
  return /judge response was not valid json/i.test(msg);
}

/** True when the model provider hiccuped (5xx, reset) — record the miss, keep going. */
export function isTransientProviderError(error) {
  const msg = String(error ?? "");
  return (
    /\/api\/chat returned 5\d\d/i.test(msg) ||
    /internal server error/i.test(msg) ||
    /\bECONNRESET\b/i.test(msg) ||
    /\bECONNREFUSED\b/i.test(msg) ||
    /\bfetch failed\b/i.test(msg) ||
    /\bsocket hang up\b/i.test(msg)
  );
}

/** Stop the bench sequence on runner errors, not timeouts, judge JSON, or provider 5xx. */
export function shouldStopBench(row) {
  if (!row?.error) return false;
  if (isScenarioTimeoutError(row.error)) return false;
  if (isJudgeJsonError(row.error)) return false;
  if (isTransientProviderError(row.error)) return false;
  return true;
}
