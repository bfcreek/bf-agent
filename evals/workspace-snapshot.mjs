/**
 * Capture a bounded snapshot of a workspace for the judge model.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_SKIP = new Set([
  "node_modules",
  ".git",
  ".halo-agent",
  ".bf",
  "bf-agent",
  "package-lock.json",
]);

/**
 * @param {string} root
 * @param {object} [options]
 * @param {number} [options.maxFiles]
 * @param {number} [options.maxFileBytes]
 * @param {Set<string>} [options.skipDirs]
 * @param {boolean} [options.listOnly] Paths and sizes only, no file contents.
 */
export async function captureWorkspaceSnapshot(root, options = {}) {
  const maxFiles = options.maxFiles ?? 40;
  const maxFileBytes = options.maxFileBytes ?? 12_000;
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP;
  const listOnly = options.listOnly === true;

  /** @type {Array<{path: string, bytes: number, text?: string, truncated?: boolean, error?: string}>} */
  const files = [];

  async function walk(dir, rel = "") {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      files.push({ path: rel || ".", bytes: 0, error: err.message });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      const full = path.join(dir, entry.name);
      let info;
      try {
        info = await stat(full);
      } catch (err) {
        files.push({ path: childRel, bytes: 0, error: err.message });
        continue;
      }
      const record = { path: childRel, bytes: info.size };
      if (listOnly) {
        files.push(record);
        continue;
      }
      try {
        const buf = await readFile(full);
        if (buf.length > maxFileBytes) {
          record.text = buf.subarray(0, maxFileBytes).toString("utf8");
          record.truncated = true;
        } else {
          record.text = buf.toString("utf8");
        }
      } catch (err) {
        record.error = err.message;
      }
      files.push(record);
    }
  }

  await walk(root);
  return { root, fileCount: files.length, files, listOnly };
}

/**
 * @param {ReturnType<typeof captureWorkspaceSnapshot> extends Promise<infer T> ? T : never} snapshot
 */
export function formatSnapshotForPrompt(snapshot) {
  const lines = [`Workspace: ${snapshot.root}`, `Files (${snapshot.fileCount}):`];
  if (snapshot.listOnly) {
    for (const file of snapshot.files) {
      lines.push(`  ${file.path} (${file.bytes} bytes)${file.error ? ` [unreadable: ${file.error}]` : ""}`);
    }
    return lines.join("\n");
  }
  for (const file of snapshot.files) {
    lines.push(`\n--- ${file.path} (${file.bytes} bytes) ---`);
    if (file.error) {
      lines.push(`[unreadable: ${file.error}]`);
    } else if (file.text !== undefined) {
      lines.push(file.text);
      if (file.truncated) lines.push("\n[truncated]");
    }
  }
  return lines.join("\n");
}
