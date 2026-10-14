/**
 * Filesystem tools scoped to a workspace root. Every path from the model is
 * resolved against the root and must stay inside it. Long output is spilled
 * to a file instead of truncated; writes are checkpointed first when a
 * CheckpointStore is provided.
 */

import { access, constants, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { AGENT_DATA_HIDDEN_NAMES } from "../workspace-data.mjs";
import { classifyCleanupFileMutation, cleanupMutationBlockMessage } from "./mutation-safety.mjs";
import { createOutputSpiller } from "./output.mjs";

export { MAX_TOOL_OUTPUT_CHARS, truncateMiddle, truncateOutput } from "./output.mjs";

/**
 * Strip workspace-folder prefixes so `app/foo` and `/app/foo` resolve to
 * `foo` when the workspace root is `/app` instead of `/app/app/foo`.
 * @param {string} root
 * @param {string} relativePath
 * @returns {string}
 */
export function normalizeWorkspaceRelativePath(root, relativePath) {
  const raw = String(relativePath ?? ".").trim() || ".";
  const rootAbs = path.resolve(root);
  const unix = raw.replace(/\\/g, "/");
  const posixRoot = rootAbs.replace(/\\/g, "/").replace(/\/$/, "");
  const base = path.basename(rootAbs);

  if (unix === posixRoot || unix === posixRoot + "/") return ".";
  if (unix.startsWith(posixRoot + "/")) return unix.slice(posixRoot.length + 1) || ".";

  if (path.isAbsolute(raw)) {
    const abs = path.resolve(raw);
    const rel = path.relative(rootAbs, abs);
    if (rel === "") return ".";
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel.replace(/\\/g, "/");
  }

  let rel = unix.replace(/^\.\//, "");
  if (base && (rel === base || rel.startsWith(`${base}/`))) {
    rel = rel === base ? "." : rel.slice(base.length + 1);
  }
  return rel || ".";
}

/**
 * Resolve a model-supplied path against the workspace root, rejecting
 * anything that lands outside it (absolute paths elsewhere, `..` escapes).
 *
 * @param {string} root Absolute workspace root.
 * @param {string} [relativePath] Path from the model; defaults to the root.
 * @returns {string} Absolute path inside the root.
 */
export function resolveWithinRoot(root, relativePath) {
  const normalized = normalizeWorkspaceRelativePath(root, relativePath ?? ".");
  const target = path.resolve(root, normalized);
  const rel = path.relative(root, target);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    throw new Error(
      `Path '${relativePath}' is outside the workspace root. Use paths relative to the workspace.`,
    );
  }
  return target;
}

/**
 * Reject write_file calls that mistakenly pass run_command fields.
 * @param {object} [args]
 * @returns {string|null}
 */
export function writeFileSchemaIssue(args) {
  const a = args ?? {};
  if (a.command != null || a.cmd != null) {
    return 'write_file requires "path" and "content", not run_command fields. Put shell commands in run_command.';
  }
  return null;
}

/**
 * Nearby file lines when old_string missed, so the model can copy exact text.
 * @param {string} text
 * @param {string} oldString
 * @returns {string}
 */
export function nearbySnippet(text, oldString) {
  const needle = String(oldString ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length >= 4);
  if (!needle) return "";
  const probe = needle.slice(0, Math.min(40, needle.length));
  const lines = String(text ?? "").split(/\n/);
  const idx = lines.findIndex((l) => l.includes(probe));
  if (idx < 0) return "";
  const from = Math.max(0, idx - 2);
  const to = Math.min(lines.length, idx + 3);
  return (
    `\n Nearby file text (lines ${from + 1}-${to}, copy exact whitespace into old_string):\n` +
    lines.slice(from, to).join("\n")
  );
}

async function similarPathHint(root, filePath) {
  const base = path.basename(filePath).toLowerCase().replace(/[^a-z0-9.]+/g, "");
  if (base.length < 3) return "";
  let dirAbs = root;
  try {
    dirAbs = resolveWithinRoot(root, path.dirname(filePath) === "." ? "." : path.dirname(filePath));
  } catch {
    dirAbs = root;
  }
  let names = [];
  try {
    names = await readdir(dirAbs);
  } catch {
    return "";
  }
  const stem = base.replace(/\.[^.]+$/, "");
  const hits = names
    .filter((n) => {
      const nl = n.toLowerCase();
      const ns = nl.replace(/\.[^.]+$/, "");
      return nl.includes(stem.slice(0, 4)) || stem.includes(ns.slice(0, 4)) || ns.includes(stem.slice(0, 4));
    })
    .slice(0, 5);
  if (!hits.length) return "";
  return " Did you mean: " + hits.join(", ") + "?";
}

/**
 * Whitespace-tolerant fallback for edit_file: models often reproduce the
 * target snippet with wrong indentation or line endings, which would fail
 * the exact match. Find the snippet by comparing lines with leading/trailing
 * whitespace ignored; the replacement keeps the file's real indentation by
 * shifting every new line by the first-line indent delta.
 *
 * @param {string} text Full file contents.
 * @param {string} oldString Snippet as the model wrote it.
 * @param {string} newString Replacement as the model wrote it.
 * @returns {{updated: string, matches: number, hitLines?: number[]}|null} Null when no
 *   flexible match exists; matches > 1 means ambiguous (nothing replaced).
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
  if (hits.length > 1) return { updated: text, matches: hits.length, hitLines: hits };

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

export function isIdentifierOnlySnippet(text) {
  return /^[\w.]+$/.test(String(text ?? "").trim());
}

const SCOPE_HEADER =
  /^(export\s+)?(default\s+)?(async\s+)?(def|class|fn|func|function|interface|struct|enum)\s+\w+|^(public|private|internal|protected|static)\b|^(export\s+)?(const|let|var)\s+\w+\s*=/;

export function isScopeHeaderLine(line) {
  const t = String(line ?? "").trim();
  if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("*")) return false;
  return SCOPE_HEADER.test(t);
}

/**
 * Unique old_string candidates that include enclosing function/class context
 * so the model can retry an ambiguous edit without replace_all.
 *
 * @param {string} text
 * @param {string} oldString
 * @param {{ indentInsensitive?: boolean, hitLines?: number[] }} [options]
 * @returns {string[]}
 */
export function suggestedUniqueSnippets(text, oldString, options = {}) {
  const source = String(text ?? "");
  const needle = String(oldString ?? "");
  if (!source || !needle) return [];
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const oldLineCount = Math.max(1, needle.split(/\r?\n/).length);
  let starts = Array.isArray(options.hitLines) ? options.hitLines.filter((n) => Number.isInteger(n)) : [];
  if (starts.length === 0) {
    if (options.indentInsensitive) {
      const targets = needle.split(/\r?\n/).map((l) => l.trim());
      for (let i = 0; i + targets.length <= lines.length; i++) {
        if (targets.every((t, j) => lines[i + j].trim() === t)) starts.push(i);
      }
    } else {
      let from = 0;
      while (from < source.length) {
        const idx = source.indexOf(needle, from);
        if (idx === -1) break;
        starts.push(source.slice(0, idx).split(/\r?\n/).length - 1);
        from = idx + Math.max(needle.length, 1);
      }
    }
  }

  const unique = [];
  const seen = new Set();
  for (const start of starts) {
    if (unique.length >= 3) break;
    const end = Math.min(lines.length - 1, start + oldLineCount - 1);
    let header = start;
    while (header > 0 && !isScopeHeaderLine(lines[header])) header -= 1;
    if (!isScopeHeaderLine(lines[header])) header = Math.max(0, start - 1);
    const snippet =
      end - header + 1 > 8
        ? [lines[header], ...lines.slice(start, end + 1)].join(eol)
        : lines.slice(header, end + 1).join(eol);
    const key = snippet.trim();
    if (!key || key === needle.trim() || seen.has(key)) continue;
    seen.add(key);
    unique.push(snippet);
  }
  return unique;
}

function formatSnippetSuggestions(snippets) {
  if (!snippets.length) return "";
  return (
    " Suggested unique old_string values (copy one enclosing function; omit replace_all):\n" +
    snippets.map((s) => `---\n${s}`).join("\n") +
    "\n---"
  );
}

function ambiguousSnippetMessage(oldString, count, options = {}) {
  const indent = options.indentInsensitive ? " (ignoring indentation)" : "";
  const suggestions = formatSnippetSuggestions(
    suggestedUniqueSnippets(options.text ?? "", oldString, {
      indentInsensitive: options.indentInsensitive,
      hitLines: options.hitLines,
    }),
  );
  if (options.replaceAllRequested) {
    return (
      `replace_all is for identifier renames. This snippet matches ${count} places${indent} — ` +
      "include the enclosing function (def/class line plus the target lines) and omit replace_all." +
      suggestions
    );
  }
  if (isIdentifierOnlySnippet(oldString)) {
    return (
      `old_string appears ${count} times${indent}; add surrounding context to make it unique, ` +
      "or set replace_all if you intend to rename every occurrence." +
      suggestions
    );
  }
  return (
    `old_string appears ${count} times${indent}; include the enclosing function ` +
    "(def/class line plus the target lines) so the match is unique. Do not set replace_all — that would change every site." +
    suggestions
  );
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
 * @param {import("../checkpoints.mjs").CheckpointStore} [options.checkpoints]
 *   When set, files are snapshotted before write_file / edit_file.
 */
export function registerFileTools(registry, { workspaceRoot, checkpoints }) {
  const root = path.resolve(workspaceRoot);
  const spill = createOutputSpiller({ workspaceRoot: root });

  registry.register({
    name: "read_file",
    description:
      "Read a text file inside the workspace. Returns the whole file, or a line range when offset/limit are given. Very long output is saved to a file and returned as head + tail + path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace root." },
        offset: { type: "integer", description: "1-based line number to start reading from (optional)." },
        limit: { type: "integer", description: "Maximum number of lines to read (optional)." },
      },
      required: ["path"],
    },
    async execute({ path: filePath, offset, limit, line_start, line_end, start_line, end_line }) {
      const target = resolveWithinRoot(root, filePath);
      let text = await readFile(target, "utf8");
      const startLine = offset ?? line_start ?? start_line;
      const endLine = line_end ?? end_line;
      const lineCount =
        limit ??
        (startLine != null && endLine != null ? Number(endLine) - Number(startLine) + 1 : undefined);
      if (startLine || lineCount) {
        const lines = text.split("\n");
        const start = Math.max(0, (startLine ?? 1) - 1);
        const end = lineCount ? start + lineCount : lines.length;
        text = lines.slice(start, end).join("\n");
      }
      return spill(text, `read-${path.basename(filePath)}`);
    },
  });

  registry.register({
    name: "list_dir",
    description: "List the contents of a directory inside the workspace. Directory names end with '/'.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to the workspace root. Defaults to the root." },
      },
    },
    async execute({ path: dirPath }) {
      const target = resolveWithinRoot(root, dirPath);
      const entries = await readdir(target, { withFileTypes: true });
      const names = entries
        // The agent's own data dir (sessions, checkpoints, spills) is noise
        // to the model; small models have been seen reading its index file.
        .filter((e) => !AGENT_DATA_HIDDEN_NAMES.has(e.name))
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
    async execute({ path: filePath, content, ...rest }) {
      const schemaIssue = writeFileSchemaIssue({ path: filePath, content, ...rest });
      if (schemaIssue) throw new Error(schemaIssue);
      if (!filePath) throw new Error("path is required.");
      assertCleanupMutationAllowed(registry, filePath, "write_file");
      const text = String(content ?? "");
      const target = resolveWithinRoot(root, filePath);
      const rel = path.relative(root, target);
      await checkpoints?.snapshot(rel, { tool: "write_file" });
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, text, "utf8");
      return { path: rel, bytesWritten: Buffer.byteLength(text) };
    },
  });

  registry.register({
    name: "edit_file",
    requiresApproval: true,
    description:
      "Replace an exact text snippet in an existing file. old_string must match exactly once unless replace_all is true. Include enough surrounding context to make it unique. For identifier renames, set replace_all: true with old_string as just the identifier.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace root." },
        old_string: { type: "string", description: "Exact text to find." },
        new_string: { type: "string", description: "Text to replace it with." },
        replace_all: {
          type: "boolean",
          description: "Replace every occurrence (for identifier renames). Otherwise old_string must match exactly once.",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute({ path: filePath, old_string, new_string, replace_all }) {
      assertCleanupMutationAllowed(registry, filePath, "edit_file");
      if (!old_string) throw new Error("old_string must not be empty.");
      if (old_string === String(new_string ?? "")) {
        throw new Error("old_string and new_string are identical; nothing would change.");
      }
      const target = resolveWithinRoot(root, filePath);
      const rel = path.relative(root, target);
      let text;
      try {
        text = await readFile(target, "utf8");
      } catch (err) {
        if (err && err.code === "ENOENT") {
          const hint = await similarPathHint(root, filePath);
          throw new Error(`File '${filePath}' does not exist.${hint} Use list_dir or find_files, then a real path.`);
        }
        throw err;
      }
      const occurrences = text.split(old_string).length - 1;
      if (occurrences === 0) {
        // Exact match failed — try the whitespace-tolerant match before
        // giving up, since mangled indentation is the usual culprit.
        const flexible = replaceFlexible(text, old_string, String(new_string ?? ""));
        if (!flexible) {
          throw new Error(
            "old_string was not found in the file, even ignoring indentation differences. Re-read the file and copy the exact text." +
              nearbySnippet(text, old_string),
          );
        }
        if (flexible.matches > 1) {
          throw new Error(
            ambiguousSnippetMessage(old_string, flexible.matches, {
              indentInsensitive: true,
              text,
              hitLines: flexible.hitLines,
            }),
          );
        }
        await checkpoints?.snapshot(rel, { tool: "edit_file" });
        await writeFile(target, flexible.updated, "utf8");
        return {
          path: rel,
          replacements: 1,
          note: "matched with indentation differences ignored; the file's original indentation was kept",
        };
      }
      if (occurrences > 1 && replace_all && !isIdentifierOnlySnippet(old_string)) {
        throw new Error(ambiguousSnippetMessage(old_string, occurrences, { replaceAllRequested: true, text }));
      }
      if (occurrences > 1 && !replace_all) {
        throw new Error(ambiguousSnippetMessage(old_string, occurrences, { text }));
      }
      const updated = replace_all
        ? text.split(old_string).join(String(new_string ?? ""))
        : replaceOnce(text, old_string, String(new_string ?? ""));
      await checkpoints?.snapshot(rel, { tool: "edit_file" });
      await writeFile(target, updated, "utf8");
      return { path: rel, replacements: replace_all ? occurrences : 1 };
    },
  });

  return registry;
}

export async function pathExists(absPath) {
  try {
    await access(absPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Unattended cleanup/delete goals: refuse write/edit unless the path was
 * explicitly named (and not protected). An approved call (ask-mode yes,
 * or --auto-approve) skips this — the user already confirmed the call.
 */
function assertCleanupMutationAllowed(registry, filePath, toolName) {
  if (registry.callApproved) return;
  const { verdict, target } = classifyCleanupFileMutation(filePath, registry.runContext?.goal);
  if (verdict === "protected" || verdict === "unauthorized") {
    throw new Error(cleanupMutationBlockMessage(verdict, target, toolName));
  }
}
