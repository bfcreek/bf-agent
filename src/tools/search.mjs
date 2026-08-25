/**
 * Code search tools: grep_search (regex over file contents) and find_files
 * (glob over file names). Without these the model has to read files one at a
 * time or shell out to platform-specific search commands — the single most
 * common way small models waste loop steps. Pure Node, workspace-scoped,
 * output-capped like every other builtin.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { resolveWithinRoot, truncateOutput } from "./fs.mjs";

/** Directories that are never worth searching and can be enormous. */
const SKIP_DIRS = new Set([
  ".git",
  ".halo-agent",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
  "target",
  "vendor",
]);

const MAX_FILE_BYTES = 512_000;
const MAX_FILES_SCANNED = 5000;
const DEFAULT_MAX_MATCHES = 50;
const MAX_MATCHES_CAP = 200;
const MAX_LINE_CHARS = 300;
const MAX_FOUND_FILES = 200;

/**
 * Convert a glob pattern to a regular expression. Supports `*` (within one
 * path segment), `**` (across segments), and `?` (one character).
 * Case-insensitive: file name casing is unreliable across platforms.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        source += "[^/]*";
      }
    } else if (c === "?") {
      source += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      source += `\\${c}`;
    } else {
      source += c;
    }
  }
  return new RegExp(`^${source}$`, "i");
}

/** True when the buffer looks binary (NUL byte in the first 8 KB). */
function looksBinary(buf) {
  const probe = buf.subarray(0, 8192);
  return probe.includes(0);
}

/**
 * Walk the tree under `startAbs`, yielding `/`-separated paths relative to
 * `rootAbs`, pruning SKIP_DIRS, and stopping at `maxFiles`.
 *
 * @returns {Promise<{files: string[], truncated: boolean}>}
 */
async function collectFiles(rootAbs, startAbs, maxFiles = MAX_FILES_SCANNED) {
  const files = [];
  let truncated = false;
  const queue = [startAbs];

  while (queue.length > 0) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        return { files, truncated };
      }
      const abs = path.join(dir, entry.name);
      files.push(path.relative(rootAbs, abs).split(path.sep).join("/"));
    }
  }
  return { files, truncated };
}

/**
 * @param {import("../tool-registry.mjs").ToolRegistry} registry
 * @param {object} options
 * @param {string} options.workspaceRoot
 */
export function registerSearchTools(registry, { workspaceRoot }) {
  const root = path.resolve(workspaceRoot);

  registry.register({
    name: "grep_search",
    description:
      "Search file contents in the workspace with a regular expression. " +
      "Returns matching lines as 'path:line: text'. Use this to find where " +
      "something is defined or used instead of reading files one by one. " +
      "When the user asked which file defines a symbol, reply with that file's " +
      "workspace-relative path after the search — do not stop with an empty message. " +
      "Common directories like node_modules and .git are skipped.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regular expression to search for (JavaScript syntax).",
        },
        path: {
          type: "string",
          description: "Directory or file to search, relative to the workspace root. Defaults to the whole workspace.",
        },
        glob: {
          type: "string",
          description:
            "Only search files whose name matches this glob, e.g. '*.mjs' or 'src/**/*.js'. " +
            "Omit glob (or use '*.py' / '*.cs') when the workspace is not JavaScript. " +
            "If the glob matches no files, the search automatically repeats without a glob.",
        },
        case_insensitive: {
          type: "boolean",
          description: "Ignore case when matching (default false).",
        },
        max_results: {
          type: "integer",
          description: `Stop after this many matching lines (default ${DEFAULT_MAX_MATCHES}, max ${MAX_MATCHES_CAP}).`,
        },
      },
      required: ["pattern"],
    },
    async execute({ pattern, path: searchPath, glob, case_insensitive, max_results }) {
      if (!pattern) throw new Error("pattern must not be empty.");
      let regex;
      try {
        regex = new RegExp(pattern, case_insensitive ? "i" : "");
      } catch (err) {
        throw new Error(`Invalid regular expression '${pattern}': ${err.message}`);
      }
      const maxMatches = Math.min(Math.max(1, max_results ?? DEFAULT_MAX_MATCHES), MAX_MATCHES_CAP);
      const start = resolveWithinRoot(root, searchPath);

      let candidates;
      let scanTruncated = false;
      const startStat = await stat(start);
      if (startStat.isFile()) {
        candidates = [path.relative(root, start).split(path.sep).join("/")];
      } else {
        ({ files: candidates, truncated: scanTruncated } = await collectFiles(root, start));
      }

      const scannedBeforeGlob = candidates.length;
      let globFallbackNote = "";
      if (glob) {
        const globRe = globToRegExp(glob);
        const matchWholePath = glob.includes("/");
        const afterGlob = candidates.filter((rel) =>
          matchWholePath ? globRe.test(rel) : globRe.test(rel.split("/").pop()),
        );
        if (afterGlob.length === 0) {
          globFallbackNote =
            `Note: glob '${glob}' matched 0 of ${scannedBeforeGlob} file(s); searched all files instead.`;
        } else {
          candidates = afterGlob;
        }
      }

      const matches = [];
      let filesWithMatches = 0;
      let hitLimit = false;
      for (const rel of candidates) {
        if (hitLimit) break;
        let buf;
        try {
          buf = await readFile(path.join(root, rel));
        } catch {
          continue;
        }
        if (buf.length > MAX_FILE_BYTES || looksBinary(buf)) continue;
        const lines = buf.toString("utf8").split(/\r?\n/);
        let matchedThisFile = false;
        for (let i = 0; i < lines.length; i++) {
          if (!regex.test(lines[i])) continue;
          matchedThisFile = true;
          matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, MAX_LINE_CHARS)}`);
          if (matches.length >= maxMatches) {
            hitLimit = true;
            break;
          }
        }
        if (matchedThisFile) filesWithMatches++;
      }

      if (matches.length === 0) {
        const prefix = globFallbackNote ? `${globFallbackNote} ` : "";
        if (glob && !globFallbackNote) {
          return (
            `No matches for /${pattern}/ in ${candidates.length} file(s) searched ` +
            `(glob '${glob}' may be too narrow — retry without glob or with '*.py' / '*.cs').`
          );
        }
        return `${prefix}No matches for /${pattern}/ in ${candidates.length} file(s) searched.`;
      }
      const notes = [];
      if (hitLimit)
        notes.push(
          `stopped at ${maxMatches} matches — more may exist; do not assume these are the only ` +
            "occurrences. Re-run with a higher max_results or a narrower pattern/path to see the rest",
        );
      if (scanTruncated) notes.push(`only the first ${MAX_FILES_SCANNED} files were scanned`);
      const header = `${matches.length} match(es) in ${filesWithMatches} file(s)${notes.length ? ` (${notes.join("; ")})` : ""}:`;
      const lines = globFallbackNote ? [globFallbackNote, header, ...matches] : [header, ...matches];
      return truncateOutput(lines.join("\n"));
    },
  });

  registry.register({
    name: "find_files",
    description:
      "Find files in the workspace by name. Glob patterns: '*' within a path " +
      "segment, '**' across segments, '?' one character. A pattern without '/' " +
      "matches file names anywhere in the tree (e.g. '*.test.mjs'); a pattern " +
      "with '/' matches the whole relative path (e.g. 'src/**/*.mjs').",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern to match against file names or relative paths.",
        },
        path: {
          type: "string",
          description: "Directory to search under, relative to the workspace root. Defaults to the whole workspace.",
        },
      },
      required: ["pattern"],
    },
    async execute({ pattern, path: searchPath }) {
      if (!pattern) throw new Error("pattern must not be empty.");
      const start = resolveWithinRoot(root, searchPath);
      const { files, truncated } = await collectFiles(root, start);
      const globRe = globToRegExp(pattern);
      const matchWholePath = pattern.includes("/");
      const found = files
        .filter((rel) => (matchWholePath ? globRe.test(rel) : globRe.test(rel.split("/").pop())))
        .slice(0, MAX_FOUND_FILES);
      if (found.length === 0) {
        return `No files matching '${pattern}' in ${files.length} file(s) scanned.`;
      }
      const notes = [];
      if (found.length === MAX_FOUND_FILES) notes.push(`showing the first ${MAX_FOUND_FILES}`);
      if (truncated) notes.push(`only the first ${MAX_FILES_SCANNED} files were scanned`);
      const header = `${found.length} file(s)${notes.length ? ` (${notes.join("; ")})` : ""}:`;
      return [header, ...found].join("\n");
    },
  });

  return registry;
}
