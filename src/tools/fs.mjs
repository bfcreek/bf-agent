/**
 * Filesystem tools scoped to a workspace root. Every path from the model is
 * resolved against the root and must stay inside it — the pre-item-8
 * guardrail: no approval gates yet, but no escaping the workspace either.
 * Outputs are capped so one tool call cannot flood the context window.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
      "Replace an exact text snippet in an existing file. old_string must match exactly once unless replace_all is true. Include enough surrounding context to make it unique.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace root." },
        old_string: { type: "string", description: "Exact text to find." },
        new_string: { type: "string", description: "Text to replace it with." },
        replace_all: {
          type: "boolean",
          description: "Replace every occurrence instead of requiring a unique match.",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute({ path: filePath, old_string, new_string, replace_all }) {
      if (!old_string) throw new Error("old_string must not be empty.");
      const target = resolveWithinRoot(root, filePath);
      const text = await readFile(target, "utf8");
      const occurrences = text.split(old_string).length - 1;
      if (occurrences === 0) {
        throw new Error("old_string was not found in the file.");
      }
      if (occurrences > 1 && !replace_all) {
        throw new Error(
          `old_string appears ${occurrences} times; add surrounding context to make it unique, or set replace_all.`,
        );
      }
      const updated = replace_all
        ? text.split(old_string).join(new_string)
        : text.replace(old_string, new_string);
      await writeFile(target, updated, "utf8");
      return { path: path.relative(root, target), replacements: replace_all ? occurrences : 1 };
    },
  });

  return registry;
}
