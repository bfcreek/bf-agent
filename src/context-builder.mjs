/**
 * Context builder: gives the model its bearings before step 1 so it does not
 * burn loop steps discovering where it is. Injected into the system prompt by
 * the CLI and server.
 *
 * Instruction files follow the same layering Cursor applies: user-level
 * instructions, then workspace AGENTS.md / .cursor/rules (always-apply).
 */

import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getConfigDir } from "./user-config.mjs";

const DEFAULT_MAX_ENTRIES = 40;

/** Workspace files Cursor-style agents treat as always-on project instructions. */
export const WORKSPACE_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules"];

export const USER_INSTRUCTIONS_FILE = "instructions.md";

export const MAX_INSTRUCTION_CHARS = 8000;
export const MAX_SINGLE_INSTRUCTION_CHARS = 4000;

/**
 * Top-level workspace entry names (directories suffixed with `/`).
 * @param {string} [workspaceRoot]
 * @param {number} [maxEntries]
 * @returns {Promise<string[]>}
 */
export async function listWorkspaceTopLevel(workspaceRoot, maxEntries = DEFAULT_MAX_ENTRIES) {
  const root = path.resolve(workspaceRoot ?? process.cwd());
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort((a, b) => a.localeCompare(b));
  return names.length > maxEntries ? names.slice(0, maxEntries) : names;
}

/**
 * Describe the environment and workspace as a text block for the system
 * prompt: platform, shell, workspace root, and a top-level listing.
 *
 * @param {object} [options]
 * @param {string} [options.workspaceRoot]
 * @param {number} [options.maxEntries] Cap on listed top-level entries.
 * @returns {Promise<string>}
 */
export async function buildEnvironmentContext({
  workspaceRoot,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  const root = path.resolve(workspaceRoot ?? process.cwd());
  const isWindows = process.platform === "win32";
  const shell = isWindows ? "PowerShell" : "/bin/sh";

  let names = [];
  let listingNote = "";
  try {
    const all = await listWorkspaceTopLevel(root, Number.MAX_SAFE_INTEGER);
    if (all.length > maxEntries) {
      listingNote = `(and ${all.length - maxEntries} more entries — use list_dir to see the rest)`;
      names = all.slice(0, maxEntries);
    } else {
      names = all;
    }
  } catch (err) {
    listingNote = `(could not list workspace: ${err?.message ?? err})`;
  }

  const lines = [
    "## Environment",
    `- Workspace root: ${root} — file tool paths are relative to this directory.`,
    `- Do not prefix paths with the workspace folder name. If the root is /app, write_file "filter.py" not "app/filter.py" or "/app/filter.py" (those create /app/app/filter.py).`,
    `- Multi-line scripts: write_file a path then run_command that path — do not put large heredocs or nested quotes inside run_command JSON.`,
    `- Artifact tasks: creating an empty/stub file is not completion when the instruction defines behavioral output — run the named verification command and match stdout before stopping.`,
    `- Verification means commands explicitly named in the user instruction — not generic examples like test.mjs or test.py unless the instruction names them. If no such command exists after the artifact is written, re-read the output file and stop.`,
    `- Never declare a task complete without running every acceptance command named in the instruction and confirming exit 0 plus the expected output shape.`,
    `- For 7z/archive extraction: exit 0 with 'No files to process' or 'Files: 0' is not success — confirm decrypted files exist before finishing.`,
    `- For PyTorch/ML tasks: read /tests before implementing; token IDs stay torch.long; run pytest — py_compile alone is not verification. Avoid module-level print() on import.`,
    `- For weights.json deliverables: write valid JSON (not cp of .pth/.pt), validate with json.load, then run ./cli_tool weights.json <image> before finishing.`,
    `- Lookup-and-write: acquire data once, write_file the required output, verify — do not finish with a todo list.`,
    `- Install-and-run tasks: successful install/compile alone is not done — run the named command and confirm exit 0.`,
    `- Numbered deliverables: every output path listed in numbered steps must exist on disk before finishing.`,
    `- Leaderboard/API URLs return JSON, not HTML — use curl -s and python -c json parsing when fetch_url fails.`,
    `- For artifact-creation tasks: if the required output path is still missing after several tool steps, keep working — do not give a final answer.`,
    `- For system paths outside the workspace (/etc/apt, /usr/local/bin), use run_command — write_file cannot touch them.`,
    `- Internal thinking/reasoning never counts as progress — artifact-creation tasks require an early write_file or run_command tool call.`,
    `- Platform: ${process.platform} (${os.type()} ${os.release()}); run_command uses ${shell}.`,
    ...(isWindows
      ? [
          "- Shell scripts: write PowerShell (.ps1). Do not default to bash or .sh — bash is not the default shell and may not be installed. Chain commands with ';' not '&&'.",
        ]
      : []),
    ...(names.some((n) => n === ".git" || n === ".git/")
      ? [
          "- This workspace is a git repository. After a merge CONFLICT, resolve <<<<<<< markers with edit_file, then git add/commit, then verify — do not stop after git show of both sides.",
        ]
      : []),
    ...(names.some((n) => /lodepng|cjson/i.test(n))
      ? [
          "- Workspace includes lodepng/cJSON — when the task asks for a binary cli_tool, compile the native C path (gcc/make) instead of a Python wrapper.",
        ]
      : []),
    `- Node.js: ${process.version}`,
    `- Local date: ${new Date().toString()}`,
    "",
    "## Workspace top-level contents",
    names.length > 0 ? names.map((n) => `- ${n}`).join("\n") : "(empty directory)",
  ];
  if (listingNote) lines.push(listingNote);
  return lines.join("\n");
}

/**
 * Parse YAML-ish frontmatter from a Cursor `.mdc` rule file.
 *
 * @param {string} text
 * @returns {{ attributes: Record<string, string|boolean>, body: string }}
 */
export function parseRuleFrontmatter(text) {
  const raw = String(text ?? "");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { attributes: {}, body: raw.trim() };
  /** @type {Record<string, string|boolean>} */
  const attributes = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    const value = kv[2].trim().replace(/^['"]|['"]$/g, "");
    if (/^(true|false)$/i.test(value)) attributes[kv[1]] = /^true$/i.test(value);
    else attributes[kv[1]] = value;
  }
  return { attributes, body: match[2].trim() };
}

/**
 * Cursor always-apply rules: `alwaysApply: true`, or no globs when the flag
 * is omitted. File-scoped rules (`globs:` / `alwaysApply: false`) stay out
 * because this runtime has no open-editor set.
 *
 * @param {Record<string, string|boolean>} attributes
 * @returns {boolean}
 */
export function shouldAlwaysApplyRule(attributes) {
  if (attributes?.alwaysApply === true) return true;
  if (attributes?.alwaysApply === false) return false;
  const globs = attributes?.globs ?? attributes?.glob;
  return !globs;
}

/**
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
async function readOptionalFile(filePath) {
  try {
    const text = (await readFile(filePath, "utf8")).trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string}
 */
function capText(text, maxChars = MAX_SINGLE_INSTRUCTION_CHARS) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated — ${text.length - maxChars} more characters]`;
}

/**
 * @param {Array<{ title: string, source: string, body: string }>} sections
 * @param {number} [maxChars]
 * @returns {string}
 */
function formatInstructionSections(sections, maxChars = MAX_INSTRUCTION_CHARS) {
  const blocks = [];
  let used = 0;
  for (const section of sections) {
    const header = `## ${section.title} (from ${section.source})`;
    const full = `${header}\n\n${section.body}`;
    if (used + full.length + 2 <= maxChars) {
      blocks.push(full);
      used += full.length + 2;
      continue;
    }
    const overhead = header.length + 20;
    const remaining = maxChars - used - overhead;
    if (remaining < 200) break;
    blocks.push(`${header}\n\n${section.body.slice(0, remaining)}\n\n[truncated]`);
    break;
  }
  return blocks.join("\n\n");
}

/**
 * Load Cursor-style instruction files: user `instructions.md`, workspace
 * AGENTS.md / CLAUDE.md / .cursorrules, and always-apply `.cursor/rules`.
 *
 * @param {object} [options]
 * @param {string} [options.workspaceRoot]
 * @param {string} [options.userConfigDir] Override the user-config directory
 *   (tests). Defaults to `getConfigDir()`.
 * @returns {Promise<string>}
 */
export async function loadAppliedInstructions({ workspaceRoot, userConfigDir } = {}) {
  const root = path.resolve(workspaceRoot ?? process.cwd());
  const sections = [];

  const userDir = userConfigDir ?? getConfigDir();
  const userText = await readOptionalFile(path.join(userDir, USER_INSTRUCTIONS_FILE));
  if (userText) {
    sections.push({
      title: "User instructions",
      source: USER_INSTRUCTIONS_FILE,
      body: capText(userText),
    });
  }

  for (const rel of WORKSPACE_INSTRUCTION_FILES) {
    const text = await readOptionalFile(path.join(root, rel));
    if (!text) continue;
    sections.push({
      title: "Workspace instructions",
      source: rel,
      body: capText(text),
    });
  }

  const rulesDir = path.join(root, ".cursor", "rules");
  try {
    const entries = await readdir(rulesDir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && /\.(mdc|md)$/i.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of files) {
      const raw = await readOptionalFile(path.join(rulesDir, entry.name));
      if (!raw) continue;
      const { attributes, body } = parseRuleFrontmatter(raw);
      if (!body || !shouldAlwaysApplyRule(attributes)) continue;
      sections.push({
        title: "Workspace instructions",
        source: `.cursor/rules/${entry.name}`,
        body: capText(body),
      });
    }
  } catch {
    // no .cursor/rules directory
  }

  return formatInstructionSections(sections);
}

/**
 * Compose a full system prompt: base behavior instructions, Cursor-style
 * instruction files, then environment context.
 *
 * @param {object} options
 * @param {string} options.basePrompt
 * @param {string} [options.workspaceRoot]
 * @param {string} [options.projectContext] Injected project overview / index note.
 * @param {string} [options.userConfigDir]
 * @returns {Promise<string>}
 */
export async function buildSystemPrompt({
  basePrompt,
  workspaceRoot,
  projectContext,
  userConfigDir,
} = {}) {
  const [context, instructions] = await Promise.all([
    buildEnvironmentContext({ workspaceRoot }),
    loadAppliedInstructions({ workspaceRoot, userConfigDir }),
  ]);
  const parts = [basePrompt];
  if (instructions?.trim()) parts.push(instructions.trim());
  parts.push(context);
  if (projectContext?.trim()) parts.push(projectContext.trim());
  return parts.join("\n\n");
}
