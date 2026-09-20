/**
 * Local (dev-bench) reports and train artifacts live next to scenario workspaces:
 *   <parent>/halo-agent-benchmark/local/
 *
 * Recognized benches keep their own tree under `recognized/`. Nothing from a
 * bench run should land in the repo root.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultBenchmarkRoot } from "./workspace-layout.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const LOCAL_DIRNAME = "local";

/**
 * @param {string} [repoRoot]
 * @returns {string}
 */
export function localBenchRoot(repoRoot = REPO_ROOT) {
  return path.join(defaultBenchmarkRoot(repoRoot), LOCAL_DIRNAME);
}

/**
 * Default report / plan / scoreboard paths for the local bench.
 * @param {string} [repoRoot]
 */
export function localPaths(repoRoot = REPO_ROOT) {
  const dir = localBenchRoot(repoRoot);
  return {
    dir,
    json: path.join(dir, "latest.json"),
    markdown: path.join(dir, "latest.md"),
    capability: path.join(dir, "capability.json"),
    public: path.join(dir, "public.json"),
    recommendationsJson: path.join(dir, "recommendations-plan.json"),
    recommendationsMd: path.join(dir, "recommendations-plan.md"),
    trainLog: path.join(dir, "ha-train-log.md"),
    scoreboard: path.join(dir, "scoreboard-history.jsonl"),
  };
}
