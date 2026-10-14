/**
 * Context builder: what the model sees before step 1.
 *
 * Follows Cursor's context model. Static context is small — environment,
 * git snapshot, always-on instruction files — and everything else is
 * discovered on demand with tools. Rules that are not always-on are listed
 * by name and description only; the model pulls one in with `fetch_rule`
 * when it looks relevant. Nested AGENTS.md files are listed by path and read
 * when the model works in that directory.
 */

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { getConfigDir } from "./user-config.mjs";
import { AGENT_DATA_HIDDEN_NAMES } from "./workspace-data.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_ENTRIES = 40;

/** Workspace files Cursor-style agents treat as always-on project instructions. */
export const WORKSPACE_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules"];

export const USER_INSTRUCTIONS_FILE = "instructions.md";

export const MAX_INSTRUCTION_CHARS = 12_000;
export const MAX_SINGLE_INSTRUCTION_CHARS = 6000;

/** Directories never scanned for nested AGENTS.md. */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", ".halo-agent", ".bf", "bf-agent", "vendor", "target"]);
const NESTED_AGENTS_MAX_DEPTH = 4;
const GIT_STATUS_MAX_LINES = 30;

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
    // The agent's own data directory is not part of the user's project.
    .filter((e) => !AGENT_DATA_HIDDEN_NAMES.has(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort((a, b) => a.localeCompare(b));
  return names.length > maxEntries ? names.slice(0, maxEntries) : names;
}

/**
 * Git snapshot for the prompt: branch and a short status, like Cursor's
 * `<git_status>` block. Empty string when the workspace is not a repo or git
 * is unavailable.
 *
 * @param {string} root
 * @param {{ exec?: typeof execFileAsync }} [options]
 * @returns {Promise<string>}
 */
export async function buildGitSnapshot(root, { exec = execFileAsync } = {}) {
  const run = async (args) => {
    const { stdout } = await exec("git", args, { cwd: root, timeout: 3000, windowsHide: true });
    return String(stdout ?? "").trimEnd();
  };
  let branch;
  try {
    // symbolic-ref works on a fresh repo with no commits; rev-parse covers
    // a detached HEAD.
    branch = await run(["symbolic-ref", "--short", "-q", "HEAD"]).catch(() =>
      run(["rev-parse", "--abbrev-ref", "HEAD"]),
    );
  } catch {
    return "";
  }
  let status = "";
  try {
    status = await run(["status", "--short"]);
  } catch {
    // leave status empty
  }
  // Keep the leading column of `--short` codes (" M" vs "M ") intact.
  const lines = status ? status.split(/\r?\n/).filter((l) => l.trim()) : [];
  const shown = lines.slice(0, GIT_STATUS_MAX_LINES);
  const out = ["## Git", `- Branch: ${branch || "(detached)"}`];
  if (lines.length === 0) out.push("- Working tree clean.");
  else {
    out.push(`- Status (${lines.length} change${lines.length === 1 ? "" : "s"}):`, "```", ...shown);
    if (lines.length > shown.length) out.push(`... and ${lines.length - shown.length} more`);
    out.push("```");
  }
  return out.join("\n");
}

/**
 * Describe the environment and workspace as a text block for the system
 * prompt: platform, shell, workspace root, git snapshot, top-level listing.
 *
 * @param {object} [options]
 * @param {string} [options.workspaceRoot]
 * @param {number} [options.maxEntries] Cap on listed top-level entries.
 * @param {boolean} [options.git] Include the git snapshot (default true).
 * @returns {Promise<string>}
 */
export async function buildEnvironmentContext({
  workspaceRoot,
  maxEntries = DEFAULT_MAX_ENTRIES,
  git = true,
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
    `- Do not prefix paths with the workspace folder name; if the root is /app, write "filter.py", not "app/filter.py" or "/app/filter.py".`,
    `- Platform: ${process.platform} (${os.type()} ${os.release()}); run_command uses ${shell}.`,
    ...(isWindows
      ? ["- Shell scripts: write PowerShell (.ps1), not bash/.sh, unless the user asks for bash. Chain commands with ';' not '&&'."]
      : []),
    `- Node.js: ${process.version}`,
    `- Local date: ${new Date().toString()}`,
  ];

  if (git && names.some((n) => n === ".git/" || n === ".git")) {
    const snapshot = await buildGitSnapshot(root);
    if (snapshot) lines.push("", snapshot);
  }

  lines.push(
    "",
    "## Workspace top-level contents",
    names.length > 0 ? names.map((n) => `- ${n}`).join("\n") : "(empty directory)",
  );
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
 * Cursor always-apply rules: `alwaysApply: true`, or no globs and no
 * description when the flag is omitted. Described or file-scoped rules are
 * offered to the model by name instead and fetched on demand.
 *
 * @param {Record<string, string|boolean>} attributes
 * @returns {boolean}
 */
export function shouldAlwaysApplyRule(attributes) {
  if (attributes?.alwaysApply === true) return true;
  if (attributes?.alwaysApply === false) return false;
  const globs = attributes?.globs ?? attributes?.glob;
  if (globs) return false;
  return !attributes?.description;
}

/**
 * @typedef {object} RuleEntry
 * @property {string} name File name without extension (what `fetch_rule` takes).
 * @property {string} source Workspace-relative path.
 * @property {string} description
 * @property {string} globs
 * @property {boolean} alwaysApply
 * @property {string} body
 */

/**
 * All rules under `.cursor/rules` (recursively), parsed.
 * @param {string} [workspaceRoot]
 * @returns {Promise<RuleEntry[]>}
 */
export async function listRules(workspaceRoot) {
  const root = path.resolve(workspaceRoot ?? process.cwd());
  const rulesDir = path.join(root, ".cursor", "rules");
  /** @type {RuleEntry[]} */
  const rules = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !/\.(mdc|md)$/i.test(entry.name)) continue;
      const raw = await readOptionalFile(full);
      if (!raw) continue;
      const { attributes, body } = parseRuleFrontmatter(raw);
      if (!body) continue;
      rules.push({
        name: entry.name.replace(/\.(mdc|md)$/i, ""),
        source: path.relative(root, full).split(path.sep).join("/"),
        description: String(attributes.description ?? ""),
        globs: String(attributes.globs ?? attributes.glob ?? ""),
        alwaysApply: shouldAlwaysApplyRule(attributes),
        body,
      });
    }
  };
  await walk(rulesDir);
  return rules;
}

/**
 * Nested AGENTS.md files below the root (root-level ones are inlined by
 * `loadAppliedInstructions`). Returned as workspace-relative paths.
 * @param {string} [workspaceRoot]
 * @returns {Promise<string[]>}
 */
export async function listNestedAgentsFiles(workspaceRoot) {
  const root = path.resolve(workspaceRoot ?? process.cwd());
  const found = [];
  const walk = async (dir, depth) => {
    if (depth > NESTED_AGENTS_MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && depth > 0 && entry.name === "AGENTS.md") {
        found.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join("/"));
      }
    }
  };
  await walk(root, 0);
  return found.sort((a, b) => a.localeCompare(b));
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

function capText(text, maxChars = MAX_SINGLE_INSTRUCTION_CHARS) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated — ${text.length - maxChars} more characters; read_file the source for the rest]`;
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
 * Then list, by name only, what the model can pull in on demand: described
 * or file-scoped rules (`fetch_rule`) and nested AGENTS.md files (read_file).
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
    sections.push({ title: "User instructions", source: USER_INSTRUCTIONS_FILE, body: capText(userText) });
  }

  for (const rel of WORKSPACE_INSTRUCTION_FILES) {
    const text = await readOptionalFile(path.join(root, rel));
    if (!text) continue;
    sections.push({ title: "Workspace instructions", source: rel, body: capText(text) });
  }

  const rules = await listRules(root);
  for (const rule of rules) {
    if (!rule.alwaysApply) continue;
    sections.push({ title: "Workspace instructions", source: rule.source, body: capText(rule.body) });
  }

  const parts = [];
  const inlined = formatInstructionSections(sections);
  if (inlined) parts.push(inlined);

  const onDemand = rules.filter((r) => !r.alwaysApply);
  if (onDemand.length > 0) {
    parts.push(
      [
        "## Available rules (fetch with fetch_rule when relevant)",
        ...onDemand.map((r) => {
          const scope = r.globs ? ` [applies to ${r.globs}]` : "";
          const desc = r.description ? `: ${r.description}` : "";
          return `- ${r.name}${scope}${desc}`;
        }),
      ].join("\n"),
    );
  }

  const nested = await listNestedAgentsFiles(root);
  if (nested.length > 0) {
    parts.push(
      [
        "## Directory instructions (read_file before working in that directory)",
        ...nested.map((p) => `- ${p}`),
      ].join("\n"),
    );
  }

  return parts.join("\n\n");
}

/**
 * Compose a full system prompt: core instructions, model overlay, instruction
 * files and rule index, environment, then any extra context the caller adds.
 *
 * @param {object} options
 * @param {string} options.basePrompt
 * @param {string} [options.modelOverlay] From `modelPromptOverlay(model)`.
 * @param {string} [options.workspaceRoot]
 * @param {string} [options.extraContext] Appended last (e.g. an MCP tool index).
 * @param {string} [options.projectContext] Deprecated alias of `extraContext`.
 * @param {string} [options.userConfigDir]
 * @returns {Promise<string>}
 */
export async function buildSystemPrompt({
  basePrompt,
  modelOverlay,
  workspaceRoot,
  extraContext,
  projectContext,
  userConfigDir,
} = {}) {
  const [context, instructions] = await Promise.all([
    buildEnvironmentContext({ workspaceRoot }),
    loadAppliedInstructions({ workspaceRoot, userConfigDir }),
  ]);
  const parts = [basePrompt];
  if (modelOverlay?.trim()) parts.push(modelOverlay.trim());
  if (instructions?.trim()) parts.push(instructions.trim());
  parts.push(context);
  const extra = extraContext ?? projectContext;
  if (extra?.trim()) parts.push(extra.trim());
  return parts.join("\n\n");
}
