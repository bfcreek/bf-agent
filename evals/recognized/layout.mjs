/**
 * Recognized-bench output lives next to the dev-bench tree:
 *   <parent>/halo-agent-benchmark/recognized/<suite>/<run-id>/
 * Harbor's job directory is <run-id>/harbor/.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultBenchmarkRoot } from "../workspace-layout.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const RECOGNIZED_DIRNAME = "recognized";

/**
 * @param {string} [repoRoot]
 * @returns {string}
 */
export function recognizedRoot(repoRoot = REPO_ROOT) {
  return path.join(defaultBenchmarkRoot(repoRoot), RECOGNIZED_DIRNAME);
}

/**
 * @param {string} [iso]
 * @returns {string}
 */
export function timestampRunId(iso = new Date().toISOString()) {
  return iso.replaceAll(":", "-").replaceAll(".", "-");
}

/**
 * @param {string} suiteId
 * @param {string} runId
 * @param {object} [options]
 * @param {string} [options.root]
 * @param {string} [options.repoRoot]
 */
export function runDirectory(suiteId, runId, options = {}) {
  const root = options.root ?? recognizedRoot(options.repoRoot);
  return path.join(root, suiteId, runId);
}

/**
 * @param {string} runDir
 */
export function harborJobDirectory(runDir) {
  return path.join(runDir, "harbor");
}

/**
 * @param {string} runDir
 */
export function reportPaths(runDir) {
  return {
    json: path.join(runDir, "report.json"),
    markdown: path.join(runDir, "report.md"),
  };
}

/**
 * @param {string} suiteId
 * @param {object} [options]
 * @param {string} [options.root]
 * @param {string} [options.repoRoot]
 */
export function latestReportPaths(suiteId, options = {}) {
  const root = options.root ?? recognizedRoot(options.repoRoot);
  const dir = path.join(root, suiteId);
  return {
    json: path.join(dir, "latest.json"),
    markdown: path.join(dir, "latest.md"),
  };
}

/**
 * Durable TB scoreboard — one JSONL across runs for a suite.
 * @param {string} [suiteId]
 * @param {object} [options]
 * @param {string} [options.root]
 * @param {string} [options.repoRoot]
 */
export function scoreboardPath(suiteId = "terminal-bench", options = {}) {
  const root = options.root ?? recognizedRoot(options.repoRoot);
  return path.join(root, suiteId, "scoreboard-history.jsonl");
}
