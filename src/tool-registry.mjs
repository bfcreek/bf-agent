/**
 * Registry of tools the agent may call. Each tool owns its JSON schema and
 * executor; the loop only sees `schemas()` and `execute()`.
 */

/**
 * @typedef {object} ToolDefinition
 * @property {string} name Stable snake_case identifier the model calls.
 * @property {string} description What the tool does, written for the model.
 * @property {object} parameters JSON schema for the arguments object.
 * @property {(args: object) => Promise<unknown>|unknown} execute
 * @property {boolean} [requiresApproval] Gate this tool behind the approval
 *   handler when one is set (writes, shell — anything that mutates state).
 */

const TOOL_TYPO_HINTS = {
  search_search: ["grep_search", "search_project", "web_search"],
  grep: ["grep_search"],
  search: ["grep_search", "search_project", "web_search"],
  read: ["read_file"],
  write: ["write_file"],
  edit: ["edit_file"],
  shell: ["run_command"],
  exec: ["run_command"],
  run: ["run_command"],
  list: ["list_dir"],
};

/**
 * @param {string} name
 * @param {string[]} validNames
 * @returns {string[]}
 */
export function suggestSimilarTools(name, validNames) {
  const key = String(name ?? "").toLowerCase();
  const hinted = TOOL_TYPO_HINTS[key];
  if (hinted) {
    const matched = hinted.filter((h) => validNames.includes(h));
    if (matched.length) return matched;
  }
  const stem = key.replace(/_(?:search|file|command)$/, "");
  return validNames
    .filter((n) => n.includes(stem) || stem.includes(n.split("_")[0] ?? ""))
    .slice(0, 4);
}

export class ToolRegistry {
  constructor() {
    /** @type {Map<string, ToolDefinition>} */
    this.tools = new Map();
    /** @type {((request: {name: string, args: object}) => Promise<boolean>|boolean)|null} */
    this.approvalHandler = null;
    /**
     * Per-run context tools may consult for safety decisions — the agent
     * loop sets `{ goal }` at the start of each run so tools like
     * run_command can check what the user actually authorized.
     * @type {{goal?: string}|null}
     */
    this.runContext = null;
  }

  /** Set (or clear) the per-run context. The agent loop calls this per run. */
  setRunContext(context) {
    this.runContext = context ?? null;
    return this;
  }

  /**
   * Gate tools marked `requiresApproval` behind this callback. Return true
   * to allow the call. When no handler is set, gated tools run freely
   * (agent mode).
   */
  setApprovalHandler(handler) {
    this.approvalHandler = handler;
    return this;
  }

  /** @param {ToolDefinition} tool */
  register(tool) {
    if (!tool?.name || typeof tool.execute !== "function") {
      throw new Error("Tool needs at least a name and an execute function.");
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered.`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  has(name) {
    return this.tools.has(name);
  }

  /** Tool schemas in the OpenAI function shape Ollama accepts. */
  schemas() {
    return [...this.tools.values()].map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.parameters ?? { type: "object", properties: {} },
      },
    }));
  }

  /**
   * Run one tool call. Never throws for tool-level failures: the result is
   * fed back to the model, which can recover or report. Only registry misuse
   * (unknown tool) is reported as `ok: false` with a hint listing valid names.
   *
   * @param {string} name
   * @param {object|string|null|undefined} args Object, or JSON text from
   *   models that stringify arguments.
   * @returns {Promise<{ok: boolean, result?: unknown, error?: string}>}
   */
  async execute(name, args) {
    const tool = this.tools.get(name);
    if (!tool) {
      const valid = [...this.tools.keys()];
      const similar = suggestSimilarTools(name, valid);
      const hint = similar.length ? ` Did you mean: ${similar.join(", ")}?` : "";
      return {
        ok: false,
        error: `Unknown tool '${name}'. Available tools: ${valid.join(", ") || "(none)"}.${hint}`,
      };
    }

    let parsedArgs = args;
    if (typeof args === "string") {
      try {
        parsedArgs = args.trim() ? JSON.parse(args) : {};
      } catch {
        const hint =
          name === "write_file" || name === "edit_file"
            ? " Ensure path/content (or old_string/new_string) are a valid JSON object with escaped quotes and \\n in strings."
            : "";
        return { ok: false, error: `Arguments for '${name}' were not valid JSON.${hint}` };
      }
    }

    if (tool.requiresApproval && this.approvalHandler) {
      let approved;
      try {
        approved = await this.approvalHandler({ name, args: parsedArgs ?? {} });
      } catch (err) {
        return { ok: false, error: `Approval check failed: ${err?.message ?? err}` };
      }
      if (!approved) {
        return {
          ok: false,
          error: `The user declined to allow '${name}'. Do not retry the same call; ask the user or find another way.`,
        };
      }
    }

    try {
      const result = await tool.execute(parsedArgs ?? {});
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: `Tool '${name}' failed: ${err?.message ?? err}` };
    }
  }
}
