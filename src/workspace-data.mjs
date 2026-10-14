/**
 * Workspace-local agent state lives under `.bf/bf-agent/`.
 * Older installs used `.halo-agent/` or `bitfield/bf-agent/`; those are
 * migrated on first use.
 */

import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

/** Workspace-relative directory for sessions, checkpoints, spills, and index. */
export const AGENT_DATA_DIR = path.join(".bf", "bf-agent");

/** Posix form for docs, prompts, and cross-platform path checks. */
export const AGENT_DATA_DIR_POSIX = ".bf/bf-agent";

/** Previous workspace-relative data directories, oldest first. */
export const LEGACY_AGENT_DATA_DIRS = [".halo-agent", path.join("bitfield", "bf-agent")];

/** @deprecated Prefer LEGACY_AGENT_DATA_DIRS. */
export const LEGACY_AGENT_DATA_DIR = LEGACY_AGENT_DATA_DIRS[0];

/** Directory names to prune when walking a workspace (legacy + current). */
export const AGENT_DATA_SKIP_NAMES = new Set([".halo-agent", ".bf", "bf-agent"]);

/**
 * Absolute path under the agent data directory.
 * @param {string} workspaceRoot
 * @param {...string} parts
 */
export function agentDataPath(workspaceRoot, ...parts) {
  return path.join(path.resolve(workspaceRoot), AGENT_DATA_DIR, ...parts);
}

/**
 * Workspace-relative posix path under the agent data directory.
 * @param {...string} parts
 */
export function agentDataRel(...parts) {
  return [AGENT_DATA_DIR_POSIX, ...parts.map((p) => String(p).replaceAll("\\", "/"))]
    .filter(Boolean)
    .join("/");
}

/**
 * Move legacy data dirs → `.bf/bf-agent/` when found.
 * If both legacy and current exist, contents are merged (destination wins on
 * conflict) and the legacy directory is removed.
 *
 * @param {string} workspaceRoot
 * @returns {Promise<{migrated: boolean, merged: boolean}>}
 */
export async function migrateAgentDataDir(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const next = path.join(root, AGENT_DATA_DIR);
  let migrated = false;
  let merged = false;

  for (const legacyRel of LEGACY_AGENT_DATA_DIRS) {
    const legacy = path.join(root, legacyRel);
    const result = await migrateOne(legacy, next);
    if (result.migrated) migrated = true;
    if (result.merged) merged = true;
  }

  return { migrated, merged };
}

/**
 * @param {string} legacy Absolute legacy directory.
 * @param {string} next Absolute destination directory.
 * @returns {Promise<{migrated: boolean, merged: boolean}>}
 */
async function migrateOne(legacy, next) {
  let legacyStat;
  try {
    legacyStat = await stat(legacy);
  } catch (err) {
    if (err?.code === "ENOENT") return { migrated: false, merged: false };
    throw err;
  }
  if (!legacyStat.isDirectory()) return { migrated: false, merged: false };

  // Same resolved path (shouldn't happen) — nothing to do.
  if (path.resolve(legacy) === path.resolve(next)) {
    return { migrated: false, merged: false };
  }

  let nextExists = false;
  try {
    const nextStat = await stat(next);
    nextExists = nextStat.isDirectory();
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }

  if (!nextExists) {
    await mkdir(path.dirname(next), { recursive: true });
    await rename(legacy, next);
    return { migrated: true, merged: false };
  }

  await mergeDir(legacy, next);
  await rm(legacy, { recursive: true, force: true });
  return { migrated: true, merged: true };
}

/**
 * Migrate legacy data if needed, then ensure the data directory exists.
 * @param {string} workspaceRoot
 * @returns {Promise<string>} Absolute path to `.bf/bf-agent`.
 */
export async function ensureAgentDataDir(workspaceRoot) {
  await migrateAgentDataDir(workspaceRoot);
  const dir = agentDataPath(workspaceRoot);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * @param {string} srcDir
 * @param {string} destDir
 */
async function mergeDir(srcDir, destDir) {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(srcDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await mergeDir(from, to);
      continue;
    }
    try {
      await stat(to);
      // Destination already has this file; leave it.
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
      await rename(from, to);
    }
  }
}
