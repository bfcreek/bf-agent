/**
 * File checkpoints. Before the agent writes or edits a file, the current
 * contents are copied under `.bf/bf-agent/checkpoints/<run>/` so a wrong
 * turn can be undone without git. Modeled on Cursor's checkpoints: file-level,
 * local, separate from version control, and only for undoing agent changes.
 */

import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { AGENT_DATA_DIR, migrateAgentDataDir } from "./workspace-data.mjs";

export const CHECKPOINT_DIR = path.join(AGENT_DATA_DIR, "checkpoints");

/**
 * @typedef {object} CheckpointEntry
 * @property {string} path Workspace-relative file path.
 * @property {boolean} existed False when the file did not exist before the write.
 * @property {string} at ISO timestamp.
 * @property {string} tool Tool that triggered the snapshot.
 */

export class CheckpointStore {
  /**
   * @param {object} options
   * @param {string} options.workspaceRoot
   * @param {string} [options.runId] Defaults to a timestamp.
   */
  constructor({ workspaceRoot, runId } = {}) {
    if (!workspaceRoot) throw new Error("CheckpointStore needs a workspaceRoot.");
    this.root = path.resolve(workspaceRoot);
    this.runId = runId ?? new Date().toISOString().replace(/[:.]/g, "-");
    this.dir = path.join(this.root, CHECKPOINT_DIR, this.runId);
    /** @type {Map<string, CheckpointEntry>} first snapshot per file wins */
    this.entries = new Map();
    this._ready = migrateAgentDataDir(this.root);
  }

  async #ready() {
    await this._ready;
  }

  /** Workspace-relative path of this run's checkpoint directory. */
  get relativeDir() {
    return path.relative(this.root, this.dir).split(path.sep).join("/");
  }

  /**
   * Snapshot a file before it changes. Only the first snapshot per file in a
   * run is kept — that is the state to restore to.
   *
   * @param {string} relPath Workspace-relative path.
   * @param {{ tool?: string }} [meta]
   * @returns {Promise<CheckpointEntry|null>} Null when already snapshotted.
   */
  async snapshot(relPath, { tool = "write_file" } = {}) {
    await this.#ready();
    const rel = String(relPath).split(path.sep).join("/");
    if (this.entries.has(rel)) return null;
    const source = path.join(this.root, rel);
    const target = path.join(this.dir, "files", rel);
    let existed = true;
    try {
      const info = await stat(source);
      if (!info.isFile()) return null;
    } catch {
      existed = false;
    }
    await mkdir(path.dirname(target), { recursive: true });
    if (existed) await copyFile(source, target);
    const entry = { path: rel, existed, at: new Date().toISOString(), tool };
    this.entries.set(rel, entry);
    await this.#writeManifest();
    return entry;
  }

  async #writeManifest() {
    await mkdir(this.dir, { recursive: true });
    const manifest = { runId: this.runId, files: [...this.entries.values()] };
    await writeFile(path.join(this.dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  }

  /**
   * Restore every file in a checkpoint run to its snapshotted state. Files
   * that did not exist before are deleted.
   *
   * @param {string} workspaceRoot
   * @param {string} runId
   * @returns {Promise<{restored: string[], removed: string[]}>}
   */
  static async restore(workspaceRoot, runId) {
    const root = path.resolve(workspaceRoot);
    await migrateAgentDataDir(root);
    const dir = path.join(root, CHECKPOINT_DIR, runId);
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    const restored = [];
    const removed = [];
    for (const entry of manifest.files ?? []) {
      const target = path.join(root, entry.path);
      if (entry.existed) {
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(dir, "files", entry.path), target);
        restored.push(entry.path);
      } else {
        await rm(target, { force: true });
        removed.push(entry.path);
      }
    }
    return { restored, removed };
  }

  /**
   * @param {string} workspaceRoot
   * @returns {Promise<Array<{runId: string, files: CheckpointEntry[]}>>} Oldest first.
   */
  static async list(workspaceRoot) {
    const root = path.resolve(workspaceRoot);
    await migrateAgentDataDir(root);
    const base = path.join(root, CHECKPOINT_DIR);
    let names;
    try {
      names = await readdir(base);
    } catch (err) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
    const runs = [];
    for (const runId of names.sort()) {
      try {
        const manifest = JSON.parse(await readFile(path.join(base, runId, "manifest.json"), "utf8"));
        runs.push({ runId, files: manifest.files ?? [] });
      } catch {
        // skip unreadable runs
      }
    }
    return runs;
  }
}
