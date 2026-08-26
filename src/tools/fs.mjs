/**
 * Filesystem tools scoped to a workspace root. Every path from the model is
 * resolved against the root and must stay inside it — the pre-item-8
 * guardrail: no approval gates yet, but no escaping the workspace either.
 * Outputs are capped so one tool call cannot flood the context window.
 */

import { access, constants, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  classifyCleanupFileMutation,
  cleanupMutationBlockMessage,
  missingEditTargetBlock,
} from "./mutation-safety.mjs";

export const MAX_TOOL_OUTPUT_CHARS = 64_000;

/** Git merge conflict start marker (must be at column 0). */
export const CONFLICT_MARKER_RE = /^<<<<<<< /m;

/**
 * @param {string} text
 * @returns {boolean}
 */
export function containsConflictMarkers(text) {
  const s = String(text ?? "");
  return CONFLICT_MARKER_RE.test(s) || /^>>>>>>> /m.test(s);
}

/**
 * Nudge appended when a file or command dump still has merge conflict markers.
 * @param {string} text
 * @returns {string|null}
 */
export function conflictMarkerNote(text) {
  if (!containsConflictMarkers(text)) return null;
  return (
    "This output contains unresolved merge conflict markers (<<<<<<<). " +
    "Do not stop after git show of both sides — edit_file or write_file to remove the markers, " +
    "then git add and git commit, then run the named verification."
  );
}

/**
 * Catch obviously truncated source before it lands on disk (unbalanced braces
 * or an unclosed string). Applied to .cs/.mjs/.js/.py so a botched write_file
 * cannot replace a good file with a fragment.
 *
 * @param {string} filePath
 * @param {string} content
 * @returns {string|null} Error message, or null when the content looks complete.
 */
export function truncatedSourceIssue(filePath, content) {
  const ext = path.extname(String(filePath ?? "")).toLowerCase();
  if (![".cs", ".mjs", ".js", ".py"].includes(ext)) return null;
  const text = String(content ?? "");
  if (!text.trim()) return null;
  if (ext !== ".py" && /\/\/\s*(\.\.\.|incomplete)|NotImplementedException/i.test(text)) {
    return (
      `Refused to write '${filePath}': content contains placeholder/incomplete stubs. ` +
      "Write the full implementation and try again."
    );
  }
  if (ext === ".py" && /raise NotImplementedError|#\s*\.\.\.\s*$/m.test(text)) {
    return (
      `Refused to write '${filePath}': content contains placeholder/incomplete stubs. ` +
      "Write the full implementation and try again."
    );
  }
  const clash = csharpMemberNameClashIssue(filePath, text);
  if (clash) return clash;
  if (!hasUnbalancedDelimiters(text)) return null;
  return (
    `Refused to write '${filePath}': the content looks truncated or syntactically incomplete ` +
    "(unbalanced braces/parens or an unclosed string). Rewrite the full file and try again." +
    (ext === ".py" ? " Then run `python -m py_compile` on this path before finishing." : "")
  );
}

/**
 * Goals that explicitly ask for bash / POSIX shell, so a .sh file on Windows
 * is intentional rather than the model's Linux default.
 *
 * @param {string} [goal]
 * @returns {boolean}
 */
export function goalAllowsPosixShell(goal) {
  return /\b(bash|\.sh\b|\.bash\b|posix|git\s*bash|wsl|cygwin|msys2?|mingw|bourne)\b/i.test(
    String(goal ?? ""),
  );
}

const BASH_SHEBANG = /^#!\s*(?:\/(?:usr\/)?bin\/(?:env\s+)?)?(?:bash|sh)\b/;

/**
 * Models default to bash/.sh even when run_command is PowerShell. Refuse new
 * POSIX shell scripts on Windows unless the user asked for bash.
 *
 * @param {string} filePath
 * @param {string} content
 * @param {string} [goal]
 * @param {{ platform?: string, exists?: boolean }} [options]
 * @returns {string|null}
 */
export function windowsBashScriptIssue(
  filePath,
  content,
  goal,
  { platform = process.platform, exists = false } = {},
) {
  if (platform !== "win32") return null;
  if (exists) return null;
  if (goalAllowsPosixShell(goal)) return null;
  const rel = String(filePath ?? "").replace(/\\/g, "/");
  const ext = path.extname(rel).toLowerCase();
  const isSh = ext === ".sh" || ext === ".bash";
  const shebang = BASH_SHEBANG.test(String(content ?? "").trimStart());
  if (!isSh && !shebang) return null;
  return (
    `Refused to write '${filePath}': this is Windows. Create a PowerShell .ps1 script ` +
    "instead of bash/.sh unless the user asked for bash. Example: write hello.ps1 " +
    "and run it with run_command."
  );
}

function csharpMemberNameClashIssue(filePath, text) {
  if (path.extname(String(filePath ?? "")).toLowerCase() !== ".cs") return null;
  const classRe = /\bclass\s+(\w+)\b/g;
  let match;
  while ((match = classRe.exec(text))) {
    const name = match[1];
    const rest = text.slice(match.index + match[0].length);
    const next = rest.search(/\bclass\s+\w+/);
    const body = next === -1 ? rest : rest.slice(0, next);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const method = new RegExp(
      "\\b(?:public|private|internal|protected)(?:\\s+(?:static|async|virtual|override|sealed|partial|new|unsafe|readonly|extern))*\\s+(?!" +
        escaped +
        "\\b)[\\w.<>?\\[\\]]+\\s+" +
        escaped +
        "\\s*\\(",
    );
    if (method.test(body)) {
      return (
        `Refused to write '${filePath}': C# CS0542 — method '${name}' has the same name as its class. ` +
        `Keep the class/file name '${name}' and rename the method (e.g. ToSlug).`
      );
    }
  }
  return null;
}

function hasUnbalancedDelimiters(text) {
  let braces = 0;
  let parens = 0;
  let inString = false;
  let quote = "";
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "{") braces++;
    else if (ch === "}") braces--;
    else if (ch === "(") parens++;
    else if (ch === ")") parens--;
    if (braces < 0 || parens < 0) return true;
  }
  return inString || braces !== 0 || parens !== 0;
}

/**
 * Resolve a model-supplied path against the workspace root, rejecting
 * anything that lands outside it (absolute paths elsewhere, `..` escapes).
 *
 * @param {string} root Absolute workspace root.
 * @param {string} [relativePath] Path from the model; defaults to the root.
 * @returns {string} Absolute path inside the root.
 */
/**
 * Strip workspace-folder prefixes so `app/foo` and `/app/foo` resolve to
 * `foo` when the workspace root is `/app` (Harbor) instead of `/app/app/foo`.
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
  const bytes = Buffer.byteLength(text);
  let extra = `${omitted} characters / ${bytes} bytes omitted`;
  const trimmed = text.trim();
  if (text.length <= 500_000 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) extra += `; JSON array length ${parsed.length}`;
      else if (parsed && typeof parsed === "object") {
        const keys = Object.keys(parsed);
        extra += `; JSON keys (${keys.length}): ${keys.slice(0, 12).join(", ")}${keys.length > 12 ? ", …" : ""}`;
      }
    } catch {
      // not JSON
    }
  }
  return `${text.slice(0, half)}\n[... ${extra} ...]\n${text.slice(text.length - half)}`;
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
  const hits = names.filter((n) => {
    const nl = n.toLowerCase();
    const ns = nl.replace(/\.[^.]+$/, "");
    return nl.includes(stem.slice(0, 4)) || stem.includes(ns.slice(0, 4)) || ns.includes(stem.slice(0, 4));
  }).slice(0, 5);
  if (!hits.length) return "";
  return " Did you mean: " + hits.join(", ") + "?";
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

/** Literal single replacement — avoids `String.replace` interpreting `$` in the new text. */


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
          description: "1-based line number to start reading from (optional). Aliases: line_start, start_line.",
        },
        limit: { type: "integer", description: "Maximum number of lines to read (optional)." },
        line_start: { type: "integer", description: "Alias for offset (1-based start line)." },
        line_end: { type: "integer", description: "1-based inclusive end line (optional)." },
        start_line: { type: "integer", description: "Alias for offset." },
        end_line: { type: "integer", description: "Alias for line_end." },
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
      const capped = truncateOutput(text);
      const warning = conflictMarkerNote(text);
      return warning ? `${capped}\n[${warning}]` : capped;
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
      "Create or overwrite a text file inside the workspace. Missing parent directories are created. Use edit_file to change part of an existing file. Do not create a file the user asked you to edit if that file is missing; report the missing path instead." +
      (process.platform === "win32"
        ? " On Windows, new shell scripts must be PowerShell (.ps1), not bash/.sh, unless the user asked for bash."
        : ""),
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace root." },
        content: { type: "string", description: "Full content to write." },
      },
      required: ["path", "content"],
    },
    async execute({ path: filePath, content }) {
      if (!filePath) throw new Error("path is required.");
      assertCleanupMutationAllowed(registry, filePath, "write_file");
      const text = String(content ?? "");
      const truncated = truncatedSourceIssue(filePath, text);
      if (truncated) throw new Error(truncated);
      const target = resolveWithinRoot(root, filePath);
      const exists = await pathExists(target);
      const blocked = missingEditTargetBlock(registry.runContext?.goal, filePath, exists);
      if (blocked) throw new Error(blocked);
      const bashScript = windowsBashScriptIssue(filePath, text, registry.runContext?.goal, {
        exists,
      });
      if (bashScript) throw new Error(bashScript);
      await mkdir(path.dirname(target), { recursive: true });
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
            "Replace every occurrence of an identifier-only old_string (a name/typo). Do not use this for statements such as a return line — those need enclosing function context so they match once.",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute({ path: filePath, old_string, new_string, replace_all }) {
      assertCleanupMutationAllowed(registry, filePath, "edit_file");
      if (!old_string) throw new Error("old_string must not be empty.");
      if (old_string === String(new_string ?? "")) {
        throw new Error(
          "old_string and new_string are identical; nothing would change. Re-read the file and pick a real replacement.",
        );
      }
      const target = resolveWithinRoot(root, filePath);
      let text;
      try {
        text = await readFile(target, "utf8");
      } catch (err) {
        if (err && err.code === "ENOENT") {
          const hint = await similarPathHint(root, filePath);
          throw new Error("File '" + filePath + "' does not exist." + hint + " Re-read or list_dir, then use a real path.");
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
              nearbySnippet(text, old_string) +
              " After 2 misses on the same region, use write_file for a full rewrite instead of guessing escapes.",
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
        const flexibleTruncated = truncatedSourceIssue(filePath, flexible.updated);
        if (flexibleTruncated) throw new Error(flexibleTruncated);
        await writeFile(target, flexible.updated, "utf8");
        const pyNote =
          path.extname(filePath).toLowerCase() === ".py"
            ? "; run `python -m py_compile` on this path before finishing so indentation/syntax errors are caught"
            : "";
        return {
          path: path.relative(root, target),
          replacements: 1,
          note:
            "matched with indentation differences ignored; the file's original indentation was kept" +
            pyNote,
        };
      }
      if (occurrences > 1 && replace_all && !isIdentifierOnlySnippet(old_string)) {
        throw new Error(
          ambiguousSnippetMessage(old_string, occurrences, { replaceAllRequested: true, text }),
        );
      }
      if (occurrences > 1 && !replace_all) {
        throw new Error(ambiguousSnippetMessage(old_string, occurrences, { text }));
      }
      const updated = replace_all
        ? text.split(old_string).join(String(new_string ?? ""))
        : replaceOnce(text, old_string, String(new_string ?? ""));
      const truncated = truncatedSourceIssue(filePath, updated);
      if (truncated) throw new Error(truncated);
      await writeFile(target, updated, "utf8");
      const result = { path: path.relative(root, target), replacements: replace_all ? occurrences : 1 };
      if (path.extname(filePath).toLowerCase() === ".py") {
        result.note =
          "After editing Python, run `python -m py_compile` on this path before finishing " +
          "(catches try/except indent breaks).";
      }
      return result;
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
async function pathExists(absPath) {
  try {
    await access(absPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

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
