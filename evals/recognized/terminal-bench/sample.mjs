/**
 * Random Terminal-Bench subsets. Harbor `--n-tasks` takes the first N after
 * filters, not a shuffle — this catalog + seeded pick is what mini uses.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomInt } from "node:crypto";

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** @type {Record<string, string>} */
const CATALOG_FILES = {
  "2.1": "tasks-2.1.json",
  "terminal-bench/terminal-bench-2-1": "tasks-2.1.json",
};

/**
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {string[]} names
 * @param {{ count: number, seed?: number|null }} opts
 */
export function pickRandomTasks(names, opts) {
  const pool = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))];
  const count = Number(opts.count);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`--sample requires a positive integer, got ${opts.count}.`);
  }
  const seed = opts.seed == null ? randomInt(0, 2 ** 32) : toSeed(opts.seed);
  const rand = mulberry32(seed);
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const n = Math.min(count, shuffled.length);
  return {
    seed,
    count: n,
    requested: count,
    poolSize: pool.length,
    truncated: count > pool.length,
    tasks: shuffled.slice(0, n),
  };
}

/**
 * @param {string|number} value
 */
export function toSeed(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value >>> 0;
  const n = Number.parseInt(String(value), 10);
  if (Number.isFinite(n)) return n >>> 0;
  throw new Error(`--seed must be an integer, got ${value}.`);
}

/**
 * @param {string} [dataset]
 */
export function catalogPathForDataset(dataset = "2.1") {
  const key = String(dataset ?? "2.1").trim();
  const file = CATALOG_FILES[key];
  if (!file) return null;
  return path.join(DIR, file);
}

/**
 * @param {string} [dataset]
 * @returns {Promise<string[]>}
 */
export async function loadTaskCatalog(dataset = "2.1") {
  const catalogPath = catalogPathForDataset(dataset);
  if (!catalogPath) {
    throw new Error(
      `No local task catalog for dataset '${dataset}'. Pass --include names, or use dataset 2.1.`,
    );
  }
  const raw = JSON.parse(await readFile(catalogPath, "utf8"));
  const tasks = Array.isArray(raw) ? raw : raw.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error(`Task catalog ${catalogPath} has no tasks.`);
  }
  return tasks.map((t) => String(t).trim()).filter(Boolean);
}

/**
 * Resolve `--sample` against an explicit include list or the dataset catalog.
 *
 * @param {{ sample?: number|null, seed?: number|string|null, includeTaskNames?: string[], dataset?: string }} options
 */
export async function resolveSampledIncludes(options) {
  const sample = options.sample;
  if (sample == null || sample === false) return null;
  const count = Number(sample);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`--sample requires a positive integer, got ${options.sample}.`);
  }
  const include = (options.includeTaskNames ?? []).map((s) => String(s).trim()).filter(Boolean);
  const pool = include.length > 0 ? include : await loadTaskCatalog(options.dataset ?? "2.1");
  const picked = pickRandomTasks(pool, { count, seed: options.seed ?? null });
  return { ...picked, fromInclude: include.length > 0 };
}
