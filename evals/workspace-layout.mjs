/**
 * Persistent bench workspaces live in a sibling folder of this repo:
 *   <parent>/halo-agent-benchmark/<language>/t<tier>/<scenario>/
 *
 * Folders stay after a run so you can inspect them. A scenario's folder is
 * deleted immediately before that scenario starts. `--reset` deletes the
 * folders for that language sequence (or the whole tree if no --language).
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { removeWorkspaceDir } from "./workspace-cleanup.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_BENCHMARK_DIRNAME = "halo-agent-benchmark";

/**
 * @param {string} [repoRoot]
 * @returns {string}
 */
export function defaultBenchmarkRoot(repoRoot = REPO_ROOT) {
  return path.resolve(repoRoot, "..", DEFAULT_BENCHMARK_DIRNAME);
}

/**
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isInsideDir(parent, child) {
  const from = path.resolve(parent);
  const to = path.resolve(child);
  const rel = path.relative(from, to);
  return rel === "" || (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * @param {string} name
 * @returns {string}
 */
export function sanitizePathSegment(name) {
  const cleaned = String(name ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "scenario";
}

/**
 * @param {{ language?: string|null }} [scenario]
 * @returns {string}
 */
export function languageFolder(scenario) {
  const lang = String(scenario?.language ?? "js").toLowerCase();
  if (lang === "javascript") return "js";
  if (lang === "c#" || lang === "cs") return "csharp";
  if (lang === "py") return "python";
  return sanitizePathSegment(lang);
}

/**
 * @param {{ name: string, tier?: number, language?: string|null }} scenario
 * @param {string} [root]
 * @returns {string}
 */
export function scenarioWorkspacePath(scenario, root = defaultBenchmarkRoot()) {
  const lang = languageFolder(scenario);
  const tier = Number.isFinite(scenario?.tier) ? `t${scenario.tier}` : "t";
  const name = sanitizePathSegment(scenario?.name);
  return path.join(path.resolve(root), lang, tier, name);
}

/**
 * @param {string[]|null|undefined} languageFilter
 * @param {string} [root]
 * @returns {string[]}
 */
export function sequenceWorkspacePaths(languageFilter, root = defaultBenchmarkRoot()) {
  const base = path.resolve(root);
  const langs = Array.isArray(languageFilter) ? languageFilter.filter(Boolean) : [];
  if (langs.length === 0) return [base];
  return langs.map((lang) => path.join(base, languageFolder({ language: lang })));
}

/**
 * @param {string} dir
 * @param {string} root
 */
async function removeIfInsideRoot(dir, root) {
  const target = path.resolve(dir);
  const base = path.resolve(root);
  if (!isInsideDir(base, target)) {
    throw new Error(`Refusing to delete '${target}' — it is outside the benchmark root '${base}'.`);
  }
  return removeWorkspaceDir(target, { settleMs: 0 });
}

/**
 * Delete a scenario folder if it exists, then recreate it empty.
 *
 * @param {{ name: string, tier?: number, language?: string|null }} scenario
 * @param {object} [options]
 * @param {string} [options.root]
 * @returns {Promise<string>} Absolute workspace directory.
 */
export async function prepareScenarioWorkspace(scenario, options = {}) {
  const root = options.root ?? defaultBenchmarkRoot();
  const dir = scenarioWorkspacePath(scenario, root);
  await removeIfInsideRoot(dir, root);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Delete output folders for a language sequence (or the whole tree).
 *
 * @param {string[]|null|undefined} languageFilter
 * @param {object} [options]
 * @param {string} [options.root]
 * @returns {Promise<string[]>} Paths that were targeted for deletion.
 */
export async function resetSequenceWorkspaces(languageFilter, options = {}) {
  const root = options.root ?? defaultBenchmarkRoot();
  const targets = sequenceWorkspacePaths(languageFilter, root);
  for (const dir of targets) {
    await removeIfInsideRoot(dir, root);
  }
  return targets;
}
