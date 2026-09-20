/**
 * Append bench run metrics to a durable scoreboard history file.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { summarizeEfficiency } from "./efficiency.mjs";
import { localPaths } from "./local-layout.mjs";
import { scoreboardPath as recognizedScoreboardPath } from "./recognized/layout.mjs";

/** Local (dev-bench) scoreboard — lives under halo-agent-benchmark/local/. */
export const DEFAULT_SCOREBOARD = localPaths().scoreboard;

/** Terminal-Bench scoreboard — lives under halo-agent-benchmark/recognized/terminal-bench/. */
export const TB_SCOREBOARD = recognizedScoreboardPath("terminal-bench");

/**
 * Pass/efficiency aggregates for one bench run. `passRate` is the outcome
 * signal (oracle + outcome score); the rest describe how the runs went.
 *
 * @param {Array<object>} results dev-bench rows
 */
export function computeRunMetrics(results) {
  const rows = results ?? [];
  if (!rows.length) {
    return {
      passRate: 0,
      avgSteps: 0,
      avgToolCalls: null,
      avgProcessScore: null,
      avgPromptTokens: null,
      verifiedRate: null,
      avgHeuristicScore: null,
      flagCounts: {},
    };
  }
  const passed = rows.filter(
    (r) =>
      r.precheck?.pass !== false &&
      r.integrity?.pass !== false &&
      (r.verdict?.score ?? 0) >= 60 &&
      !r.error,
  ).length;
  const steps = rows.map((r) => r.agent?.steps ?? 0);
  const processScores = rows
    .map((r) => r.verdict?.process?.score)
    .filter((s) => typeof s === "number");
  const efficiency = summarizeEfficiency(rows.map((r) => r.agent?.efficiency));
  return {
    passRate: passed / rows.length,
    avgSteps: steps.reduce((a, b) => a + b, 0) / rows.length,
    avgToolCalls: efficiency.avgToolCalls,
    avgProcessScore: processScores.length
      ? processScores.reduce((a, b) => a + b, 0) / processScores.length
      : null,
    avgPromptTokens: efficiency.avgPromptTokens,
    verifiedRate: efficiency.verifiedRate,
    avgHeuristicScore: efficiency.avgHeuristicScore,
    flagCounts: efficiency.flagCounts,
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
