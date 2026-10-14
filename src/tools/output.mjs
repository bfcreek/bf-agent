/**
 * Tool output handling. Cursor never truncates a long tool result: it writes
 * the full text to a file and hands the model the head, the tail, and the
 * path, so the model can read more with its own tools. This module does the
 * same for every builtin, spilling to `.bf/bf-agent/tool-output/` inside
 * the workspace. In-memory head/tail truncation is the fallback when there is
 * nowhere to spill.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { AGENT_DATA_DIR, migrateAgentDataDir } from "../workspace-data.mjs";

/** Output longer than this (in characters) is spilled to a file. */
export const MAX_TOOL_OUTPUT_CHARS = 32_000;

/** Characters of head and tail kept inline when output is spilled. */
export const SPILL_HEAD_CHARS = 12_000;
export const SPILL_TAIL_CHARS = 8_000;

export const TOOL_OUTPUT_DIR = path.join(AGENT_DATA_DIR, "tool-output");

let spillCounter = 0;

/**
 * Cap output in memory, keeping the head and tail. Build and test logs put
 * the interesting part — the error — at the end, so plain head truncation
 * would hide it.
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function truncateMiddle(text, limit = MAX_TOOL_OUTPUT_CHARS) {
  const s = String(text ?? "");
  if (s.length <= limit) return s;
  const half = Math.floor(limit / 2);
  const omitted = s.length - half * 2;
  return `${s.slice(0, half)}\n[... ${omitted} characters omitted ...]\n${s.slice(s.length - half)}`;
}

/**
 * Cap output in memory, keeping the head only, noting what was cut.
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function truncateOutput(text, limit = MAX_TOOL_OUTPUT_CHARS) {
  const s = String(text ?? "");
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}\n[output truncated: ${s.length - limit} of ${s.length} characters omitted]`;
}

/**
 * Build a spill function bound to a workspace. The returned function takes
 * output text and a short label; long output is written to a file and
 * replaced with head + tail + a pointer.
 *
 * @param {object} options
 * @param {string} [options.workspaceRoot] Where `.bf/bf-agent/tool-output` lives.
 *   Without it, output falls back to in-memory truncation.
 * @param {number} [options.limit]
 * @param {number} [options.headChars]
 * @param {number} [options.tailChars]
 * @returns {(text: string, label?: string) => Promise<string>}
 */
export function createOutputSpiller({
  workspaceRoot,
  limit = MAX_TOOL_OUTPUT_CHARS,
  headChars = SPILL_HEAD_CHARS,
  tailChars = SPILL_TAIL_CHARS,
} = {}) {
  const root = workspaceRoot ? path.resolve(workspaceRoot) : null;
  return async function spill(text, label = "output") {
    const s = String(text ?? "");
    if (s.length <= limit) return s;
    if (!root) return truncateMiddle(s, limit);

    const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "output";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    spillCounter = (spillCounter + 1) % 10_000;
    const fileName = `${stamp}-${safeLabel}-${String(spillCounter).padStart(4, "0")}.txt`;
    const rel = path.join(TOOL_OUTPUT_DIR, fileName).split(path.sep).join("/");
    try {
      await migrateAgentDataDir(root);
      await mkdir(path.join(root, TOOL_OUTPUT_DIR), { recursive: true });
      await writeFile(path.join(root, rel), s, "utf8");
    } catch {
      return truncateMiddle(s, limit);
    }

    const lineCount = s.split(/\r?\n/).length;
    const head = s.slice(0, headChars);
    const tail = s.slice(Math.max(headChars, s.length - tailChars));
    const omitted = s.length - head.length - tail.length;
    return [
      head,
      `\n[... ${omitted} characters omitted. Full output (${s.length} characters, ${lineCount} lines) saved to ${rel} — read_file it with offset/limit, or grep_search it, to see more. ...]\n`,
      tail,
    ].join("");
  };
}
