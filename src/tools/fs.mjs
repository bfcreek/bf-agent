/**
 * Filesystem tools scoped to a workspace root. Every path from the model is
 * resolved against the root and must stay inside it — the pre-item-8
 * guardrail: no approval gates yet, but no escaping the workspace either.
 * Outputs are capped so one tool call cannot flood the context window.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  classifyCleanupFileMutation,
  cleanupMutationBlockMessage,
} from "./mutation-safety.mjs";

export const MAX_TOOL_OUTPUT_CHARS = 64_000;

/**
 * Resolve a model-supplied path against the workspace root, rejecting
 * anything that lands outside it (absolute paths elsewhere, `..` escapes).
 *
 * @param {string} root Absolute workspace root.
 * @param {string} [relativePath] Path from the model; defaults to the root.
 * @returns {string} Absolute path inside the root.
 */
export function resolveWithinRoot(root, relativePath) {
  const target = path.resolve(root, relativePath ?? ".");
  const rel = path.relative(root, target);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    throw new Error(
      `Path '${relativePath}' is outside the workspace root. Use paths relative to the workspace.`,
    );
  }
  return target;
}

/** Cap tool output, noting how much was cut so the model knows to narrow the request. */
export function truncateOutput(text, limit = MAX_TOOL_OUTPUT_CHARS) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[output truncated: ${text.length - limit} of ${text.length} characters omitted]`;
}

/**
 * Cap output keeping the head and tail. Command output (build logs, test
 * runs) usually has the interesting part — the error — at the end, so plain
 * head truncation would hide it.
 */
export function truncateMiddle(text, limit = MAX_TOOL_OUTPUT_CHARS) {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  const omitted = text.length - half * 2;
  return `${text.slice(0, half)}\n[... ${omitted} characters omitted ...]\n${text.slice(text.length - half)}`;
}

/**
 * Whitespace-tolerant fallback for edit_file: models (small ones especially)
 * often reproduce the target snippet with wrong indentation or line endings,
 * which would fail the exact match. Find the snippet by comparing lines with
 * leading/trailing whitespace ignored; the replacement keeps the file's real
 * indentation by shifting every new line by the first-line indent delta.
 *
 * @param {string} text Full file contents.
 * @param {string} oldString Snippet as the model wrote it.
 * @param {string} newString Replacement as the model wrote it.
 * @returns {{updated: string, matches: number}|null} Null when no flexible
 *   match exists; matches > 1 means ambiguous (nothing replaced).
 */
export function replaceFlexible(text, oldString, newString) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const fileLines = text.split(/\r?\n/);
  const oldLines = oldString.split(/\r?\n/);
  const targets = oldLines.map((l) => l.trim());
  if (!targets.some((t) => t !== "")) return null;

  const hits = [];
  for (let i = 0; i + targets.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < targets.length; j++) {
      if (fileLines[i + j].trim() !== targets[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  if (hits.length === 0) return null;
  if (hits.length > 1) return { updated: text, matches: hits.length };

  const start = hits[0];
  const fileIndent = fileLines[start].match(/^[ \t]*/)[0];
  const snippetIndent = oldLines[0].match(/^[ \t]*/)[0];
  const newLines = newString.split(/\r?\n/).map((line) => {
    if (line.trim() === "") return line;
    if (line.startsWith(snippetIndent)) return fileIndent + line.slice(snippetIndent.length);
    return fileIndent + line.replace(/^[ \t]*/, "");
  });

  const updated = [
    ...fileLines.slice(0, start),
    ...newLines,
    ...fileLines.slice(start + targets.length),
  ].join(eol);
  return { updated, matches: 1 };
}

/** Literal single replacement — avoids `String.replace` interpreting `$` in the new text. */
export function replaceOnce(text, search, replacement) {
  const index = text.indexOf(search);
  if (index === -1) return text;
  return text.slice(0, index) + replacement + text.slice(index + search.length);
}

/**
 * @param {import("../tool-registry.mjs").ToolRegistry} registry
 * @param {object} options
 * @param {string} options.workspaceRoot Absolute directory the tools may touch.
 */
export function registerFileTools(registry, { workspaceRoot }) {
  const root = path.resolve(workspaceRoot);

  registry.register({
    name: "read_file",
    description:
      "Read a text file inside the workspace. Returns the whole file, or a line range when offset/limit are given. Long output is truncated.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace root." },
        offset: {
          type: "integer",
          description: "1-based line number to start reading from (optional).",
        },
        limit: { type: "integer", description: "Maximum number of lines to read (optional)." },
      },
      required: ["path"],
    },
    async execute({ path: filePath, offset, limit }) {
      const target = resolveWithinRoot(root, filePath);
      let text = await readFile(target, "utf8");
      if (offset || limit) {
        const lines = text.split("\n");
        const start = Math.max(0, (offset ?? 1) - 1);
        const end = limit ? start + limit : lines.length;
        text = lines.slice(start, end).join("\n");
      }
      return truncateOutput(text);
    },
  });

  registry.register({
    name: "list_dir",
    description:
      "List the contents of a directory inside the workspace. Directory names end with '/'.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to the workspace root. Defaults to the root.",
        },
      },
    },
    async execute({ path: dirPath }) {
      const target = resolveWithinRoot(root, dirPath);
      const entries = await readdir(target, { withFileTypes: true });
      const names = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort((a, b) => a.localeCompare(b));
      return { path: path.relative(root, target) || ".", entries: names };
    },
  });

  registry.register({
    name: "write_file",
    requiresApproval: true,
    description:
      "Create or overwrite a text file inside the workspace. Missing parent directories are created. Use edit_file to change part of an existing file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace root." },
        content: { type: "string", description: "Full content to write." },
      },
      required: ["path", "content"],
    },
    async execute({ path: filePath, content }) {
      assertCleanupMutationAllowed(registry, filePath, "write_file");
      const target = resolveWithinRoot(root, filePath);
      await mkdir(path.dirname(target), { recursive: true });
      const text = String(content ?? "");
      await writeFile(target, text, "utf8");
      return { path: path.relative(root, target), bytesWritten: Buffer.byteLength(text) };
    },
  });

  registry.register({
    name: "edit_file",
    requiresApproval: true,
    description:
      "Replace an exact text snippet in an existing file. old_string must match exactly once unless replace_all is true. Include enough surrounding context to make it unique. For identifier renames/typo fixes, prefer replace_all: true when old_string is just the misspelled name so every declaration, export, and reference updates in one call.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace root." },
        old_string: { type: "string", description: "Exact text to find." },
        new_string: { type: "string", description: "Text to replace it with." },
        replace_all: {
          type: "boolean",
          description:
            "Replace every occurrence instead of requiring a unique match. Prefer true for simple identifier renames when old_string is the typo alone.",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute({ path: filePath, old_string, new_string, replace_all }) {
      assertCleanupMutationAllowed(registry, filePath, "edit_file");
      if (!old_string) throw new Error("old_string must not be empty.");
      const target = resolveWithinRoot(root, filePath);
      const text = await readFile(target, "utf8");
      const occurrences = text.split(old_string).length - 1;
      if (occurrences === 0) {
        // Exact match failed — try the whitespace-tolerant match before
        // giving up, since mangled indentation is the usual culprit.
        const flexible = replaceFlexible(text, old_string, String(new_string ?? ""));
        if (!flexible) {
          throw new Error(
            "old_string was not found in the file, even ignoring indentation differences. Re-read the file and copy the exact text.",
          );
        }
        if (flexible.matches > 1) {
          throw new Error(
            `old_string matches ${flexible.matches} places (ignoring indentation); add surrounding context to make it unique.`,
          );
        }
        await writeFile(target, flexible.updated, "utf8");
        return {
          path: path.relative(root, target),
          replacements: 1,
          note: "matched with indentation differences ignored; the file's original indentation was kept",
        };
      }
      if (occurrences > 1 && !replace_all) {
        throw new Error(
          `old_string appears ${occurrences} times; add surrounding context to make it unique, or set replace_all.`,
        );
      }
      const updated = replace_all
        ? text.split(old_string).join(String(new_string ?? ""))
        : replaceOnce(text, old_string, String(new_string ?? ""));
      await writeFile(target, updated, "utf8");
      return { path: path.relative(root, target), replacements: replace_all ? occurrences : 1 };
    },
  });

  return registry;
}

/**
 * Unattended cleanup/delete goals: refuse write/edit unless the path was
 * explicitly named (and not protected). Ask-mode approvals skip this —
 * the human already confirmed the call.
 *
 * @param {import("../tool-registry.mjs").ToolRegistry} registry
 * @param {string} filePath
 * @param {string} toolName
 */
function assertCleanupMutationAllowed(registry, filePath, toolName) {
  if (registry.approvalHandler) return;
  const { verdict, target } = classifyCleanupFileMutation(
    filePath,
    registry.runContext?.goal,
  );
  if (verdict === "protected" || verdict === "unauthorized") {
    throw new Error(cleanupMutationBlockMessage(verdict, target, toolName));
  }
}
