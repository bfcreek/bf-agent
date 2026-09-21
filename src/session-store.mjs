/**
 * Session persistence: transcripts, step logs, and a running list of files
 * the agent changed, saved as JSON under `.halo-agent/sessions/` in the
 * workspace so a task can be resumed across CLI invocations.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * @typedef {object} SessionData
 * @property {string} name
 * @property {string} createdAt ISO timestamp.
 * @property {string} updatedAt ISO timestamp.
 * @property {Array<object>} messages Transcript, replayable as loop history.
 * @property {Array<object>} steps Step log accumulated across all runs.
 * @property {string[]} changedFiles Workspace-relative paths written or edited.
 * @property {string|null} [model] Model used by the most recent run.
 * @property {number|null} [numCtx] Context window sent to Ollama by the most recent run.
 * @property {number} [compactions]
 * @property {number} [compactionFailures]
 * @property {number} [truncatedTurns]
 */

export class SessionStore {
  /**
   * @param {object} options
   * @param {string} options.workspaceRoot Sessions live under
   *   `<workspaceRoot>/.halo-agent/sessions` unless `dir` is given.
   * @param {string} [options.dir] Explicit sessions directory.
   */
  constructor({ workspaceRoot, dir } = {}) {
    if (!workspaceRoot && !dir) {
      throw new Error("SessionStore needs a workspaceRoot or an explicit dir.");
    }
    this.dir = dir ?? path.join(workspaceRoot, ".halo-agent", "sessions");
  }

  filePath(name) {
    return path.join(this.dir, `${sanitizeName(name)}.json`);
  }

  /** @returns {Promise<SessionData|null>} null when the session does not exist. */
  async load(name) {
    try {
      return JSON.parse(await readFile(this.filePath(name), "utf8"));
    } catch (err) {
      if (err?.code === "ENOENT") return null;
      throw new Error(`Session '${name}' is unreadable: ${err.message}`);
    }
  }

  /** @param {SessionData} data */
  async save(name, data) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.filePath(name), JSON.stringify(data, null, 2), "utf8");
  }

  /**
   * Fold one run's result into an existing session (or start a new one).
   *
   * @param {SessionData|null} existing
   * @param {{messages: Array<object>, steps: Array<object>}} runResult
   * @returns {SessionData}
   */
  merge(name, existing, runResult) {
    const now = new Date().toISOString();
    const steps = [...(existing?.steps ?? []), ...runResult.steps];
    const changed = new Set(existing?.changedFiles ?? []);
    for (const file of changedFilesFromSteps(runResult.steps)) changed.add(file);
    return {
      name: sanitizeName(name),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      messages: runResult.messages,
      steps,
      changedFiles: [...changed].sort((a, b) => a.localeCompare(b)),
      stopReason: runResult.stopReason ?? existing?.stopReason,
      error: runResult.error ?? existing?.error,
      elapsedMs: (existing?.elapsedMs ?? 0) + (runResult.elapsedMs ?? 0),
      model: runResult.model ?? existing?.model ?? null,
      numCtx: runResult.numCtx ?? existing?.numCtx ?? null,
      compactions: (existing?.compactions ?? 0) + (runResult.compactions ?? 0),
      compactionFailures: (existing?.compactionFailures ?? 0) + (runResult.compactionFailures ?? 0),
      truncatedTurns: (existing?.truncatedTurns ?? 0) + (runResult.truncatedTurns ?? 0),
      checkpointRunId: runResult.checkpointRunId ?? existing?.checkpointRunId ?? null,
    };
  }

  /** @returns {Promise<string[]>} Session names, most recently updated last. */
  async list() {
    let entries;
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
    return entries
      .filter((e) => e.endsWith(".json"))
      .map((e) => e.slice(0, -".json".length))
      .sort((a, b) => a.localeCompare(b));
  }
}

/** Paths touched by successful write_file/edit_file calls in a step log. */
export function changedFilesFromSteps(steps) {
  const files = [];
  for (const step of steps) {
    for (const call of step.toolCalls ?? []) {
      if (!call.ok) continue;
      if (call.name === "write_file" || call.name === "edit_file") {
        const file = call.result?.path ?? call.args?.path;
        if (file) files.push(String(file));
      }
    }
  }
  return files;
}

function sanitizeName(name) {
  const safe = String(name).trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  if (!safe || safe === "." || safe === "..") {
    throw new Error(`'${name}' is not a usable session name.`);
  }
  return safe;
}
