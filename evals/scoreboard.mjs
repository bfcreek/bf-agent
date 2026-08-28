/**
 * Append bench run metrics to a durable scoreboard history file.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_SCOREBOARD = "evals/scoreboard-history.jsonl";
export const TB_SCOREBOARD = "evals/tb-scoreboard-history.jsonl";

/**
 * @param {Array<object>} results
 * @returns {{passRate: number, avgSteps: number, cloudRate: number, avgEscalations: number}}
 */
export function computeRunMetrics(results) {
  const rows = results ?? [];
  if (!rows.length) {
    return { passRate: 0, avgSteps: 0, cloudRate: 0, avgEscalations: 0 };
  }
  const passed = rows.filter(
    (r) =>
      r.precheck?.pass !== false &&
      r.integrity?.pass !== false &&
      (r.verdict?.score ?? 0) >= 60 &&
      !r.error,
  ).length;
  const steps = rows.map((r) => r.agent?.steps ?? 0);
  const clouds = rows.filter((r) => r.agent?.cloudUsed === true).length;
  const escalations = rows.map((r) => r.agent?.escalationCount ?? 0);
  return {
    passRate: passed / rows.length,
    avgSteps: steps.reduce((a, b) => a + b, 0) / rows.length,
    cloudRate: clouds / rows.length,
    avgEscalations: escalations.reduce((a, b) => a + b, 0) / rows.length,
  };
}

/**
 * @param {object} entry
 * @param {string} [filePath]
 */
export async function appendScoreboardEntry(entry, filePath = DEFAULT_SCOREBOARD) {
  const abs = path.resolve(filePath);
  await mkdir(path.dirname(abs), { recursive: true });
  const line = JSON.stringify({ ...entry, recordedAt: new Date().toISOString() }) + "\n";
  await appendFile(abs, line, "utf8");
}

/**
 * @param {string} [filePath]
 * @returns {Promise<object[]>}
 */
export async function loadScoreboardHistory(filePath = DEFAULT_SCOREBOARD) {
  try {
    const text = await readFile(path.resolve(filePath), "utf8");
    return text
      .split(/\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}
