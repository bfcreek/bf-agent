/**
 * Parse a Harbor job directory into a normalized task list.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Accept a Harbor job dir, or a recognized run dir that contains harbor/result.json.
 * @param {string} input
 */
export async function resolveJobDir(input) {
  const direct = path.resolve(input);
  if (await hasResultJson(direct)) return direct;
  const nested = path.join(direct, "harbor");
  if (await hasResultJson(nested)) return nested;
  return direct;
}

async function hasResultJson(dir) {
  try {
    await stat(path.join(dir, "result.json"));
    return true;
  } catch {
    return false;
  }
}

/**
 * @typedef {object} ParsedTask
 * @property {string} name
 * @property {string} trialName
 * @property {string} trialDir
 * @property {boolean} resolved
 * @property {number|null} reward
 * @property {string|null} exception
 * @property {number|null} seconds
 * @property {object|null} trialResult
 */

/**
 * @param {string} jobDir
 */
export async function parseHarborJob(jobDir) {
  const root = path.resolve(jobDir);
  const resultPath = path.join(root, "result.json");
  /** @type {object|null} */
  let jobResult = null;
  try {
    jobResult = JSON.parse(await readFile(resultPath, "utf8"));
  } catch {
    jobResult = null;
  }

  const fromJob = Array.isArray(jobResult?.trial_results) ? jobResult.trial_results : [];
  /** @type {Map<string, object>} */
  const byTrialName = new Map();
  for (const trial of fromJob) {
    if (trial?.trial_name) byTrialName.set(trial.trial_name, trial);
  }

  const trialDirs = await listTrialDirs(root);
  /** @type {ParsedTask[]} */
  const tasks = [];

  for (const trialDir of trialDirs) {
    const trialName = path.basename(trialDir);
    let trialResult = byTrialName.get(trialName) ?? null;
    if (!trialResult) {
      try {
        trialResult = JSON.parse(await readFile(path.join(trialDir, "result.json"), "utf8"));
      } catch {
        trialResult = { trial_name: trialName, task_name: trialName };
      }
    }
    tasks.push(summarizeTrial(trialDir, trialResult));
    byTrialName.delete(trialName);
  }

  for (const leftover of byTrialName.values()) {
    tasks.push(summarizeTrial(null, leftover));
  }

  tasks.sort((a, b) => a.name.localeCompare(b.name));
  return { jobDir: root, jobResult, tasks };
}

/**
 * @param {string} jobDir
 * @returns {Promise<string[]>}
 */
export async function listTrialDirs(jobDir) {
  let entries;
  try {
    entries = await readdir(jobDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const full = path.join(jobDir, entry.name);
    try {
      await stat(path.join(full, "result.json"));
      dirs.push(full);
    } catch {
      // not a trial
    }
  }
  return dirs;
}

/**
 * @param {string|null} trialDir
 * @param {object} trial
 * @returns {ParsedTask}
 */
export function summarizeTrial(trialDir, trial) {
  const reward = extractReward(trial);
  const exception = trial?.exception_info?.exception_type
    ? `${trial.exception_info.exception_type}: ${trial.exception_info.exception_message ?? ""}`.trim()
    : null;
  return {
    name: String(trial?.task_name ?? trial?.trial_name ?? (trialDir ? path.basename(trialDir) : "unknown")),
    trialName: String(trial?.trial_name ?? (trialDir ? path.basename(trialDir) : "unknown")),
    trialDir: trialDir ?? "",
    resolved: reward != null && reward >= 1,
    reward,
    exception,
    seconds: durationSeconds(trial?.started_at, trial?.finished_at),
    trialResult: trial ?? null,
  };
}

/**
 * @param {object} trial
 * @returns {number|null}
 */
export function extractReward(trial) {
  const rewards = trial?.verifier_result?.rewards;
  if (!rewards || typeof rewards !== "object") return null;
  if (typeof rewards.reward === "number") return rewards.reward;
  const values = Object.values(rewards).filter((v) => typeof v === "number");
  if (values.length === 0) return null;
  return Number(values[0]);
}

/**
 * @param {string|null|undefined} start
 * @param {string|null|undefined} end
 * @returns {number|null}
 */
export function durationSeconds(start, end) {
  if (!start || !end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, (b - a) / 1000);
}

/**
 * @param {Array<{resolved: boolean, exception: string|null, verdict?: {score: number}|null}>} tasks
 */
export function summarizeTasks(tasks) {
  const resolved = tasks.filter((t) => t.resolved).length;
  const errors = tasks.filter((t) => t.exception).length;
  const judged = tasks.filter((t) => t.verdict && typeof t.verdict.score === "number");
  const judgeAvg =
    judged.length > 0 ? judged.reduce((sum, t) => sum + t.verdict.score, 0) / judged.length : null;
  const totalSeconds = tasks.reduce((sum, t) => sum + (t.seconds ?? 0), 0);
  return {
    tasks: tasks.length,
    resolved,
    errors,
    resolveRate: tasks.length ? resolved / tasks.length : 0,
    judged: judged.length,
    judgeAvg,
    totalSeconds,
  };
}
