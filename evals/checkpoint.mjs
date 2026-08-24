/**
 * Dev-bench checkpoint: save progress after each scenario so an interrupted
 * run can resume without re-running completed scenarios.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const CHECKPOINT_VERSION = 1;
export const DEFAULT_CHECKPOINT_REL = ".halo-agent/bench-checkpoint.json";

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
    skipJudge: options.skipJudge,
    progression: options.progression,
    stopBelowScore: options.stopBelowScore,
    maxTier: options.maxTier,
    minTier: options.minTier,
    judgeModel: options.judgeModel,
    planning: options.planning,
    taskHints: options.taskHints,
    keepWorkspace: options.keepWorkspace,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

/**
 * @param {string[]} scenarioNames
 * @param {object} options
 */
export function describeRunSelection(scenarioNames, options) {
  if (options.scenarioFilter) return `scenario ${options.scenarioFilter}`;
  if (options.scenarioList?.length) {
    return `scenarios: ${options.scenarioList.join(", ")}`;
  }
  if (options.maxTier != null && options.minTier == null) {
    const tierLabel = `tier ≤${options.maxTier}`;
    return options.progression ? `${tierLabel} (progression)` : `${tierLabel} (flat)`;
  }
  if (options.minTier != null) return `tier ≥${options.minTier}`;
  if (options.progression) return `all scenarios (progression)`;
  return `all scenarios (flat)`;
}

/**
 * @param {string} checkpointPath Absolute or cwd-relative path.
 */
export function resolveCheckpointPath(checkpointPath = DEFAULT_CHECKPOINT_REL) {
  return path.resolve(checkpointPath);
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
    resolvedModel,
    stoppedAtTier,
    stopReason,
  };
}

/** Stop the bench sequence when a scenario hits a runner or judge error. */
export function shouldStopBench(row) {
  return Boolean(row?.error);
}
