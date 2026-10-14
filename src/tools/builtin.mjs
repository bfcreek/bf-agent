/**
 * Standard tool set for the agent: diagnostics (get_time, echo), filesystem
 * access, code search, web access, shell execution, and rule fetching — the
 * file and shell tools scoped to a workspace root. Write/shell tools are
 * approval-gated; shell deletion commands and write_file/edit_file under
 * vague cleanup goals are blocked outright unless this call was approved
 * (ask-mode prompt or auto-approve).
 */

import { listRules } from "../context-builder.mjs";
import { registerFileTools } from "./fs.mjs";
import { registerFetchUrlTool } from "./fetch-url.mjs";
import { registerProjectSearchTool } from "./project-search.mjs";
import { registerSearchTools } from "./search.mjs";
import { registerShellTools } from "./shell.mjs";
import { registerWebSearchTool } from "./web-search.mjs";

/**
 * @param {import("../tool-registry.mjs").ToolRegistry} registry
 * @param {object} [options]
 * @param {string} [options.workspaceRoot] Directory file/shell tools are
 *   confined to. Defaults to the process working directory.
 * @param {{embed: Function}} [options.searchClient] Embedding client: powers
 *   fetch_url's micro-RAG and, with `projectIndex`, search_project.
 * @param {boolean} [options.projectIndex] Register search_project over the
 *   local project index (default true when a searchClient is given; callers
 *   that embed Halo Scan normally leave it off).
 * @param {string} [options.embeddingModel]
 * @param {typeof fetch} [options.fetchImpl] Injectable fetch for web tools.
 * @param {import("../checkpoints.mjs").CheckpointStore} [options.checkpoints]
 *   Snapshot files before write_file / edit_file.
 */
export function registerBuiltinTools(
  registry,
  {
    workspaceRoot = process.cwd(),
    searchClient,
    projectIndex = true,
    embeddingModel,
    fetchImpl,
    checkpoints,
  } = {},
) {
  registry.register({
    name: "get_time",
    description:
      "Get the current local date and time on this machine. Use when the user asks about the current time or date.",
    parameters: { type: "object", properties: {} },
    execute() {
      const now = new Date();
      return { iso: now.toISOString(), local: now.toString(), timezoneOffsetMinutes: now.getTimezoneOffset() };
    },
  });

  registry.register({
    name: "echo",
    description: "Return the given text unchanged. Diagnostic tool for verifying tool calling works.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "Text to echo back." } },
      required: ["text"],
    },
    execute({ text }) {
      return String(text ?? "");
    },
  });

  registerFileTools(registry, { workspaceRoot, checkpoints });
  registerSearchTools(registry, { workspaceRoot });
  registerRuleTool(registry, { workspaceRoot });
  registerWebSearchTool(registry, { fetchImpl });
  registerFetchUrlTool(registry, { fetchImpl, client: searchClient, embeddingModel });
  registerShellTools(registry, { workspaceRoot });
  if (searchClient && projectIndex) {
    registerProjectSearchTool(registry, { workspaceRoot, client: searchClient, embeddingModel });
  }

  return registry;
}

/**
 * `fetch_rule`: pull in a `.cursor/rules` rule the system prompt listed by
 * name and description (Cursor's "Apply Intelligently" rules).
 *
 * @param {import("../tool-registry.mjs").ToolRegistry} registry
 * @param {{workspaceRoot: string}} options
 */
export function registerRuleTool(registry, { workspaceRoot }) {
  registry.register({
    name: "fetch_rule",
    description:
      "Read a project rule listed under 'Available rules' in your instructions. Fetch a rule when its description matches the work you are about to do.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Rule name as listed." } },
      required: ["name"],
    },
    async execute({ name }) {
      const rules = await listRules(workspaceRoot);
      const key = String(name ?? "").trim().replace(/\.(mdc|md)$/i, "");
      const rule = rules.find((r) => r.name === key) ?? rules.find((r) => r.source === String(name).trim());
      if (!rule) {
        const known = rules.map((r) => r.name);
        throw new Error(`No rule named '${name}'. Available rules: ${known.join(", ") || "(none)"}.`);
      }
      return `Rule '${rule.name}' (${rule.source}):\n\n${rule.body}`;
    },
  });
  return registry;
}
