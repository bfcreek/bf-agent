/**
 * Byte-level workspace integrity checks for dev-bench scenarios.
 * Snapshots file hashes before/after an agent run to detect corruption,
 * unexpected writes, adds, or deletes.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_SKIP_DIRS = new Set([".halo-agent"]);

/**
 * @typedef {object} IntegrityRules
 * @property {boolean} [readOnly] Shorthand: no adds, changes, or deletes.
 * @property {string[]} [allowChanged] Relative paths that may change bytes.
 * @property {string[]} [allowAdded] Relative paths that may be created.
 * @property {string[]} [allowDeleted] Relative paths that may be removed.
 */

/**
 * @typedef {object} IntegrityResult
 * @property {boolean|null} pass True/false when checked; null when no rules.
 * @property {string} detail Human-readable summary.
 * @property {string[]} [unexpectedChanges]
 * @property {string[]} [unexpectedAdds]
 * @property {string[]} [unexpectedDeletes]
 */

/** @param {string} rel */
function normalizeRel(rel) {
  return rel.replaceAll("\\", "/");
}

/**
 * @param {string} rel Normalized relative path.
 * @param {string} pattern e.g. `.halo-agent` or `.halo-agent/**`
 */
function matchesExclude(rel, pattern) {
  const normalized = normalizeRel(pattern);
  if (normalized.endsWith("/**")) {
    const prefix = normalized.slice(0, -3);
    return rel === prefix || rel.startsWith(`${prefix}/`);
  }
  return rel === normalized || rel.startsWith(`${normalized}/`);
}

/**
 * @param {string} rel
 * @param {string[]} exclude
 */
function isExcluded(rel, exclude) {
  for (const pattern of exclude) {
    if (matchesExclude(rel, pattern)) return true;
  }
  for (const dir of DEFAULT_SKIP_DIRS) {
    if (rel === dir || rel.startsWith(`${dir}/`)) return true;
  }
  return false;
}

/**
 * Walk a workspace and hash every file (raw bytes).
 *
 * @param {string} dir Workspace root.
 * @param {object} [options]
 * @param {string[]} [options.exclude] Additional path patterns to skip.
 * @returns {Promise<Map<string, string>>} relative path → sha256 hex.
 */
export async function captureIntegritySnapshot(dir, options = {}) {
  const exclude = options.exclude ?? [];
  const root = path.resolve(dir);
  /** @type {Map<string, string>} */
  const hashes = new Map();

  async function walk(current, rel = "") {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const normalized = normalizeRel(childRel);
      if (isExcluded(normalized, exclude)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, childRel);
      } else if (entry.isFile()) {
        const buf = await readFile(full);
        hashes.set(normalized, createHash("sha256").update(buf).digest("hex"));
      }
    }
  }

  await walk(root);
  return hashes;
}

/**
 * @param {IntegrityRules|null|undefined} rules
 * @returns {{ allowChanged: string[], allowAdded: string[], allowDeleted: string[] }|null}
 */
export function resolveIntegrityRules(rules) {
  if (!rules) return null;
  if (rules.readOnly) {
    return { allowChanged: [], allowAdded: [], allowDeleted: [] };
  }
  return {
    allowChanged: (rules.allowChanged ?? []).map(normalizeRel),
    allowAdded: (rules.allowAdded ?? []).map(normalizeRel),
    allowDeleted: (rules.allowDeleted ?? []).map(normalizeRel),
  };
}

/**
 * Compare before/after snapshots against allowlists.
 *
 * @param {Map<string, string>} before
 * @param {Map<string, string>} after
 * @param {{ allowChanged: string[], allowAdded: string[], allowDeleted: string[] }} rules
 * @returns {IntegrityResult}
 */
export function assertIntegrity(before, after, rules) {
  const allowChanged = new Set(rules.allowChanged.map(normalizeRel));
  const allowAdded = new Set(rules.allowAdded.map(normalizeRel));
  const allowDeleted = new Set(rules.allowDeleted.map(normalizeRel));

  /** @type {string[]} */
  const unexpectedChanges = [];
  /** @type {string[]} */
  const unexpectedAdds = [];
  /** @type {string[]} */
  const unexpectedDeletes = [];

  for (const [rel, hashBefore] of before) {
    if (!after.has(rel)) {
      if (!allowDeleted.has(rel)) unexpectedDeletes.push(rel);
      continue;
    }
    if (hashBefore !== after.get(rel) && !allowChanged.has(rel)) {
      unexpectedChanges.push(rel);
    }
  }

  for (const rel of after.keys()) {
    if (!before.has(rel) && !allowAdded.has(rel)) {
      unexpectedAdds.push(rel);
    }
  }

  const pass =
    unexpectedChanges.length === 0 &&
    unexpectedAdds.length === 0 &&
    unexpectedDeletes.length === 0;

  if (pass) {
    return { pass: true, detail: "ok", unexpectedChanges, unexpectedAdds, unexpectedDeletes };
  }

  const parts = [];
  if (unexpectedChanges.length > 0) {
    parts.push(`unexpected changes: ${unexpectedChanges.join(", ")}`);
  }
  if (unexpectedAdds.length > 0) {
    parts.push(`unexpected adds: ${unexpectedAdds.join(", ")}`);
  }
  if (unexpectedDeletes.length > 0) {
    parts.push(`unexpected deletes: ${unexpectedDeletes.join(", ")}`);
  }

  return {
    pass: false,
    detail: parts.join("; "),
    unexpectedChanges,
    unexpectedAdds,
    unexpectedDeletes,
  };
}

/**
 * @param {string} dir
 * @param {Map<string, string>} beforeSnapshot
 * @param {IntegrityRules|null|undefined} integrityRules
 * @returns {Promise<IntegrityResult>}
 */
export async function checkScenarioIntegrity(dir, beforeSnapshot, integrityRules) {
  const rules = resolveIntegrityRules(integrityRules);
  if (!rules) return { pass: null, detail: "no integrity rules" };
  const after = await captureIntegritySnapshot(dir);
  return assertIntegrity(beforeSnapshot, after, rules);
}
