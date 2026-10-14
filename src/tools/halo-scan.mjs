/**
 * Halo Scan embedding: register `@bitfieldcreek/halo-scan`'s structured,
 * read-only code tools (repo_overview, file_outline, get_symbol,
 * symbol_context, changed_symbols, ...) as native bf-agent tools.
 *
 * Why native and not `--mcp`: behind the lazy MCP bridge the model sees only
 * tool names and must spend two round trips (describe_tool, call_mcp_tool)
 * to use one, while `read_file` / `grep_search` are native functions it
 * already knows. Measured with the halo-scan tool bench, 0.2 of 10.2 calls
 * per question reached halo-scan through the bridge. Exposed natively, the
 * structured tools cut tool calls per question by 34-74% and prompt tokens
 * by 16-65% depending on the model, because one `symbol_context` or
 * `read_file paths:[...]` replaces a grep -> read -> read loop.
 *
 * Halo Scan is an optional peer: it is loaded from `HALO_SCAN_MODULE`, a
 * sibling `../bf-chat-tools` checkout, or the installed package, in that
 * order. When none is present the builtin tool set is used unchanged.
 *
 * Halo Scan's `read_file`, `list_dir`, `grep_search`, and `find_files` are
 * supersets of the builtins (batch reads, `expand: "symbol"`, enclosing
 * symbol tags) and replace them under the same names.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AGENT_DATA_HIDDEN_NAMES } from "../workspace-data.mjs";
import { createOutputSpiller } from "./output.mjs";

export const HALO_SCAN_PACKAGE = "@bitfieldcreek/halo-scan";

/** Tool-pack profile used when the caller does not choose one. */
export const DEFAULT_HALO_SCAN_PROFILE = "auto";

/**
 * Builtins that Halo Scan supersedes under the same name. Listed so callers
 * and tests can see what changes when the embedding is active.
 */
export const HALO_SCAN_SUPERSEDES = Object.freeze(["read_file", "list_dir", "grep_search", "find_files"]);

/**
 * The "find your context" bullets of the core prompt when Halo Scan is
 * embedded. These *replace* the builtin guidance (`composeSystemPrompt({
 * contextGuidance })`) rather than follow it: measured on gpt-oss:20b, a
 * prompt that opened with "use grep_search and find_files ... read_file ...
 * list_dir" kept the model on those primitives (60 grep, 38 read, 29 find
 * calls across 16 questions) while project_conventions, symbol_context, and
 * config_surface — each answering a question in one call — went unused.
 */
export const HALO_SCAN_CONTEXT_GUIDANCE = [
  "- Gather context yourself, starting with the structured code tools:",
  "  repo_overview for what a repo is and how it is built; project_conventions",
  "  for contributor rules, lint/format configs, and CI; entrypoint_map for how",
  "  to run it; config_surface for env keys and ports; dir_digest for the",
  "  shape of the tree. If a tool you need is not listed, activate_pack adds it.",
  "- For \"tell me about file X\" (exports, imports, importers, tests), call",
  "  file_brief first: one call answers it. Do not grep the file for exports.",
  "  To understand code, use file_outline (structure) and get_symbol (one",
  "  definition, or names[] for several) instead of reading whole files.",
  "  symbol_context gives a symbol's body, callers grouped by function, its",
  "  tests, type hierarchy, and (history: N) when it last changed, in one",
  "  call; use it before changing a symbol and for \"everything about X\".",
  "- find_references lists usages (group_by: \"caller\"); changed_symbols shows",
  "  what a diff or the last N commits touched and which tests cover it;",
  "  tests_for maps a file to its tests; test_inventory, called once over a",
  "  directory (never per file), gives case counts per file and the names;",
  "  markers lists TODO/FIXME; unused_exports finds dead exports; git_history",
  "  is for log/blame/diff and returns stats unless you ask for the patch.",
  "- grep_search is for strings, config keys, comments, and fuzzy names",
  "  (expand: \"symbol\" returns the enclosing bodies). find_files matches file",
  "  names, not contents. read_file paths:[...] reads several files at once.",
  "  Do not guess at file contents or APIs when a tool can show you.",
].join("\n");

/** @deprecated Use HALO_SCAN_CONTEXT_GUIDANCE with composeSystemPrompt. */
export const HALO_SCAN_PROMPT_OVERLAY = HALO_SCAN_CONTEXT_GUIDANCE;

/**
 * Alternatives named by the agent loop's streak nudge when Halo Scan is
 * embedded: the one-call tool for each question shape the bench saw the
 * model grind on with grep/read/list.
 */
export const HALO_SCAN_STREAK_HINT =
  "use the one-call tool for the question: find_references (group_by: \"caller\") for every usage of a symbol, " +
  "symbol_context for everything about one symbol, file_brief for what a file exports/imports and who uses it, " +
  "unused_exports for dead code, test_inventory for the test suite, dir_digest (depth: 3) for the tree, " +
  "project_conventions for contributor rules and configs, config_surface for env keys, changed_symbols for recent changes.";

/** @type {Promise<object|null>|null} */
let modulePromise = null;

/**
 * Locate and import Halo Scan. Resolution order: `HALO_SCAN_MODULE` (a path
 * or specifier), a sibling `bf-chat-tools` checkout next to this repo, then
 * the installed `@bitfieldcreek/halo-scan` package. Returns null when none
 * is available. The result is cached for the process.
 *
 * @param {{ env?: NodeJS.ProcessEnv, force?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
export function importHaloScan({ env = process.env, force = false } = {}) {
  if (modulePromise && !force) return modulePromise;
  modulePromise = (async () => {
    const override = env.HALO_SCAN_MODULE?.trim();
    if (override) {
      const spec = /^[./\\]|^[A-Za-z]:[\\/]/.test(override) ? pathToFileURL(path.resolve(override)).href : override;
      return import(spec);
    }
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sibling = path.resolve(here, "../../../bf-chat-tools/src/index.mjs");
    if (existsSync(sibling)) {
      try {
        return await import(pathToFileURL(sibling).href);
      } catch {
        // fall through to the package
      }
    }
    try {
      return await import(HALO_SCAN_PACKAGE);
    } catch {
      return null;
    }
  })();
  return modulePromise;
}

/** Reset the import cache (tests). */
export function resetHaloScanImportCache() {
  modulePromise = null;
}

/**
 * Normalize argument spellings models use for `read_file` so the embedded
 * tool accepts what the builtin accepted (line_start/line_end, start_line/end_line).
 * @param {object} args
 */
function normalizeReadArgs(args) {
  const o = { ...args };
  if (o.line_start != null && o.offset == null) {
    o.offset = o.line_start;
    if (o.line_end != null && o.limit == null) o.limit = Math.max(1, Number(o.line_end) - Number(o.line_start) + 1);
  }
  if (o.start_line != null && o.offset == null) {
    o.offset = o.start_line;
    if (o.end_line != null && o.limit == null) o.limit = Math.max(1, Number(o.end_line) - Number(o.start_line) + 1);
  }
  for (const k of ["line_start", "line_end", "start_line", "end_line"]) delete o[k];
  return o;
}

/** Hide the agent's own data directory from directory listings. */
function hideAgentData(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.entries)) return result;
  return {
    ...result,
    entries: result.entries.filter((name) => !AGENT_DATA_HIDDEN_NAMES.has(String(name).replace(/\/$/, ""))),
  };
}

/**
 * Wrap one Halo Scan tool as a bf-agent ToolDefinition: schema field rename,
 * argument normalization, and bf-agent's spill-to-file handling for long
 * output (Halo Scan truncates in memory; bf-agent keeps the full text on disk
 * and hands the model head + tail + path).
 *
 * @param {{name: string, description?: string, inputSchema?: object, execute: Function}} tool
 * @param {{ spill: (text: string, label?: string) => Promise<string> }} ctx
 * @returns {import("../tool-registry.mjs").ToolDefinition}
 */
export function wrapHaloScanTool(tool, { spill }) {
  const name = tool.name;
  return {
    name,
    description: tool.description ?? `Halo Scan tool '${name}'.`,
    parameters: tool.inputSchema ?? { type: "object", properties: {} },
    async execute(args) {
      let input = args ?? {};
      if (name === "read_file") input = normalizeReadArgs(input);
      let out = await tool.execute(input);
      if (name === "list_dir") out = hideAgentData(out);
      if (typeof out === "string") out = await spill(out, name);
      return out;
    },
  };
}

/**
 * Register Halo Scan's tools into a bf-agent registry.
 *
 * @param {import("../tool-registry.mjs").ToolRegistry} registry
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @param {string} [options.profile] Pack profile: `auto` (default; base packs
 *   plus up to two chosen by fingerprinting the repo), `base`, `full`, or a
 *   named pack. Non-full profiles add `activate_pack` so the model can pull
 *   in the rest on demand; newly activated tools are registered live.
 * @param {string[]} [options.exclude] Halo Scan tool names to leave out.
 * @param {object} [options.module] Pre-imported Halo Scan module (tests).
 * @returns {Promise<{
 *   names: string[],
 *   replaced: string[],
 *   added: string[],
 *   profile: string|null,
 *   aliasCount: number,
 * }|null>} Null when Halo Scan is not available.
 */
export async function registerHaloScanTools(
  registry,
  { workspaceRoot, profile = DEFAULT_HALO_SCAN_PROFILE, exclude, module } = {},
) {
  const mod = module ?? (await importHaloScan());
  if (!mod || typeof mod.createManagedToolset !== "function") return null;

  const root = path.resolve(workspaceRoot ?? process.cwd());
  const { registry: scanRegistry, listChanged, profile: resolvedProfile } = await mod.createManagedToolset({
    workspaceRoot: root,
    profile,
    exclude,
  });
  const spill = createOutputSpiller({ workspaceRoot: root });

  const names = [];
  const replaced = [];
  const added = [];
  const install = (tool) => {
    const wrapped = wrapHaloScanTool(tool, { spill });
    if (registry.has(tool.name)) {
      registry.replace(wrapped);
      replaced.push(tool.name);
    } else {
      registry.register(wrapped);
      added.push(tool.name);
    }
    names.push(tool.name);
  };
  for (const tool of scanRegistry.list()) install(tool);

  if (listChanged) {
    // activate_pack mutates Halo Scan's registry and fires onChange; mirror
    // the new tools into ours so they are callable on the next step.
    scanRegistry.onChange = () => {
      for (const tool of scanRegistry.list()) {
        if (!registry.has(tool.name)) install(tool);
      }
    };
  }

  let aliasCount = 0;
  if (mod.TOOL_ALIASES && typeof mod.TOOL_ALIASES === "object") {
    registry.registerAliases(mod.TOOL_ALIASES);
    aliasCount = Object.keys(mod.TOOL_ALIASES).length;
  }

  return {
    names,
    replaced,
    added,
    profile: resolvedProfile ?? (profile ? String(profile) : null),
    aliasCount,
  };
}
