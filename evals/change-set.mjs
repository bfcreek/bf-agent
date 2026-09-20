/**
 * What the agent changed, from its own checkpoints.
 *
 * `CheckpointStore` snapshots every file before the first write_file /
 * edit_file in a run, so `<root>/.halo-agent/checkpoints/<run>/` plus the
 * current workspace is an exact before/after for every file the agent
 * touched. That is a much tighter judge input than a bounded snapshot of the
 * whole workspace: the judge sees the diff, not sixty files.
 *
 * Files changed through shell commands are not checkpointed; callers keep a
 * workspace snapshot as the fallback for that and for runs without
 * checkpoints (Harbor trials whose /app artifact was not collected).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { CHECKPOINT_DIR } from "../src/checkpoints.mjs";

const DEFAULT_MAX_DIFF_LINES = 400;
const DEFAULT_MAX_FILE_BYTES = 200_000;
const MAX_LCS_LINES = 2000;

/**
 * @typedef {object} ChangedFile
 * @property {string} path
 * @property {"added"|"modified"|"deleted"|"unchanged"} status
 * @property {string|null} before
 * @property {string|null} after
 * @property {string} diff Unified diff, or a note when the file is binary/huge.
 * @property {boolean} truncated
 * @property {string} tool Tool that first touched the file.
 */

/**
 * @typedef {object} ChangeSet
 * @property {"checkpoints"|"none"} source
 * @property {string} root
 * @property {string[]} runIds
 * @property {ChangedFile[]} files
 */

/**
 * @param {string} root Directory that contains `.halo-agent/checkpoints`.
 * @param {object} [options]
 * @param {string[]} [options.runIds] Restrict to these checkpoint runs (default: all, oldest first).
 * @param {number} [options.maxDiffLines]
 * @param {number} [options.maxFileBytes]
 * @returns {Promise<ChangeSet>}
 */
export async function collectChangeSet(root, options = {}) {
  const absRoot = path.resolve(root);
  const base = path.join(absRoot, CHECKPOINT_DIR);
  const maxDiffLines = options.maxDiffLines ?? DEFAULT_MAX_DIFF_LINES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  let runIds;
  try {
    runIds = (await readdir(base)).sort();
  } catch (err) {
    if (err?.code === "ENOENT") return { source: "none", root: absRoot, runIds: [], files: [] };
    throw err;
  }
  if (options.runIds?.length) {
    const wanted = new Set(options.runIds);
    runIds = runIds.filter((id) => wanted.has(id));
  }

  // Earliest snapshot per path wins: that is the true "before" even when a
  // multi-phase scenario ran several agents over the same workspace.
  /** @type {Map<string, {runId: string, entry: object}>} */
  const firstSeen = new Map();
  const usedRuns = [];
  for (const runId of runIds) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(base, runId, "manifest.json"), "utf8"));
    } catch {
      continue;
    }
    usedRuns.push(runId);
    for (const entry of manifest.files ?? []) {
      if (!entry?.path || firstSeen.has(entry.path)) continue;
      firstSeen.set(entry.path, { runId, entry });
    }
  }
  if (firstSeen.size === 0) {
    return { source: usedRuns.length ? "checkpoints" : "none", root: absRoot, runIds: usedRuns, files: [] };
  }

  /** @type {ChangedFile[]} */
  const files = [];
  for (const [rel, { runId, entry }] of [...firstSeen.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const before = entry.existed
      ? await readTextOrNull(path.join(base, runId, "files", rel), maxFileBytes)
      : { text: null, binary: false, bytes: 0 };
    const after = await readTextOrNull(path.join(absRoot, rel), maxFileBytes);
    const existsAfter = after.exists;

    let status;
    if (!entry.existed && existsAfter) status = "added";
    else if (entry.existed && !existsAfter) status = "deleted";
    else if (entry.existed && existsAfter && before.text === after.text && !before.binary && !after.binary) status = "unchanged";
    else status = "modified";

    let diff;
    let truncated = false;
    if (before.binary || after.binary) {
      diff = `[binary or oversized file: before ${before.bytes} bytes, after ${after.bytes} bytes]`;
    } else if (status === "unchanged") {
      diff = "[no net change]";
    } else {
      const full = unifiedDiff(before.text ?? "", after.text ?? "", rel, {
        beforeLabel: entry.existed ? `a/${rel}` : "/dev/null",
        afterLabel: existsAfter ? `b/${rel}` : "/dev/null",
      });
      const lines = full.split("\n");
      if (lines.length > maxDiffLines) {
        diff = `${lines.slice(0, maxDiffLines).join("\n")}\n[... diff truncated: ${lines.length - maxDiffLines} more lines ...]`;
        truncated = true;
      } else {
        diff = full;
      }
    }

    files.push({
      path: rel,
      status,
      before: before.text,
      after: after.text,
      diff,
      truncated,
      tool: String(entry.tool ?? "unknown"),
    });
  }

  return { source: "checkpoints", root: absRoot, runIds: usedRuns, files };
}

/**
 * @param {ChangeSet} changeSet
 * @param {object} [options]
 * @param {number} [options.maxTotalChars] Stop emitting diffs past this budget.
 */
export function formatChangeSetForPrompt(changeSet, { maxTotalChars = 60_000 } = {}) {
  if (!changeSet || changeSet.files.length === 0) {
    return "(the agent did not write or edit any files through its file tools)";
  }
  const counts = { added: 0, modified: 0, deleted: 0, unchanged: 0 };
  for (const f of changeSet.files) counts[f.status] += 1;
  const lines = [
    `Files touched by write_file/edit_file: ${changeSet.files.length} (${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted, ${counts.unchanged} no net change)`,
    "Changes made through shell commands are not listed here; check the workspace listing for those.",
  ];
  let used = lines.join("\n").length;
  let emitted = 0;
  for (const file of changeSet.files) {
    const header = `\n--- ${file.path} [${file.status}, via ${file.tool}] ---`;
    if (used + header.length + file.diff.length > maxTotalChars) {
      lines.push(`\n[... ${changeSet.files.length - emitted} more file(s) omitted for length ...]`);
      break;
    }
    lines.push(header, file.diff);
    used += header.length + file.diff.length + 2;
    emitted += 1;
  }
  return lines.join("\n");
}

/**
 * Minimal unified diff (3 lines of context). LCS-based; falls back to a
 * whole-file replacement hunk when either side is too large to align.
 *
 * @param {string} before
 * @param {string} after
 * @param {string} name
 * @param {{beforeLabel?: string, afterLabel?: string, context?: number}} [options]
 */
export function unifiedDiff(before, after, name = "file", options = {}) {
  const context = options.context ?? 3;
  const a = splitLines(before);
  const b = splitLines(after);
  const head = [`--- ${options.beforeLabel ?? `a/${name}`}`, `+++ ${options.afterLabel ?? `b/${name}`}`];

  if (a.length === 0 && b.length === 0) return head.join("\n");

  /** @type {Array<{type: " "|"-"|"+", line: string, ai: number, bi: number}>} */
  let ops;
  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    ops = [
      ...a.map((line, i) => ({ type: "-", line, ai: i, bi: 0 })),
      ...b.map((line, i) => ({ type: "+", line, ai: a.length, bi: i })),
    ];
  } else {
    ops = diffOps(a, b);
  }

  // Group into hunks with context.
  const hunks = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === " ") {
      i += 1;
      continue;
    }
    const start = Math.max(0, i - context);
    let end = i;
    let lastChange = i;
    while (end < ops.length && end - lastChange <= context * 2) {
      if (ops[end].type !== " ") lastChange = end;
      end += 1;
    }
    end = Math.min(ops.length, lastChange + context + 1);
    hunks.push(ops.slice(start, end));
    i = end;
  }

  const out = [...head];
  for (const hunk of hunks) {
    const aStart = (hunk.find((o) => o.type !== "+")?.ai ?? hunk[0].ai) + 1;
    const bStart = (hunk.find((o) => o.type !== "-")?.bi ?? hunk[0].bi) + 1;
    const aCount = hunk.filter((o) => o.type !== "+").length;
    const bCount = hunk.filter((o) => o.type !== "-").length;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const op of hunk) out.push(`${op.type}${op.line}`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------

function diffOps(a, b) {
  const n = a.length;
  const m = b.length;
  // Trim common prefix/suffix first: cheap and keeps the DP small.
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix += 1;

  const midA = a.slice(prefix, n - suffix);
  const midB = b.slice(prefix, m - suffix);

  // LCS table on the middle.
  const rows = midA.length + 1;
  const cols = midB.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        midA[i] === midB[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }

  const ops = [];
  for (let k = 0; k < prefix; k++) ops.push({ type: " ", line: a[k], ai: k, bi: k });
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      ops.push({ type: " ", line: midA[i], ai: prefix + i, bi: prefix + j });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      ops.push({ type: "-", line: midA[i], ai: prefix + i, bi: prefix + j });
      i += 1;
    } else {
      ops.push({ type: "+", line: midB[j], ai: prefix + i, bi: prefix + j });
      j += 1;
    }
  }
  while (i < midA.length) {
    ops.push({ type: "-", line: midA[i], ai: prefix + i, bi: prefix + j });
    i += 1;
  }
  while (j < midB.length) {
    ops.push({ type: "+", line: midB[j], ai: prefix + i, bi: prefix + j });
    j += 1;
  }
  for (let k = 0; k < suffix; k++) {
    ops.push({ type: " ", line: a[n - suffix + k], ai: n - suffix + k, bi: m - suffix + k });
  }
  return ops;
}

function splitLines(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

async function readTextOrNull(file, maxBytes) {
  let info;
  try {
    info = await stat(file);
  } catch {
    return { exists: false, text: null, binary: false, bytes: 0 };
  }
  if (!info.isFile()) return { exists: false, text: null, binary: false, bytes: 0 };
  if (info.size > maxBytes) return { exists: true, text: null, binary: true, bytes: info.size };
  const buf = await readFile(file);
  if (buf.includes(0)) return { exists: true, text: null, binary: true, bytes: buf.length };
  return { exists: true, text: buf.toString("utf8"), binary: false, bytes: buf.length };
}
