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
 * @typedef {object} ToolAlias
 * @property {string} target Registered tool the alias resolves to.
 * @property {(args: object) => object} [args] Rewrites the caller's arguments
 *   into the target's schema (e.g. `query` -> `pattern`).
 */

const grepAliasArgs = (a) => {
  const o = { ...a };
  if (o.query != null && o.pattern == null) o.pattern = o.query;
  if (o.regex != null && o.pattern == null) o.pattern = o.regex;
  delete o.query;
  delete o.regex;
  return o;
};

const readAliasArgs = (a) => {
  const o = { ...a };
  if (o.file != null && o.path == null) o.path = o.file;
  if (o.filename != null && o.path == null) o.path = o.filename;
  if (o.line_start != null && o.offset == null) {
    o.offset = o.line_start;
    if (o.line_end != null && o.limit == null) o.limit = Math.max(1, o.line_end - o.line_start + 1);
  }
  if (o.start_line != null && o.offset == null) {
    o.offset = o.start_line;
    if (o.end_line != null && o.limit == null) o.limit = Math.max(1, o.end_line - o.start_line + 1);
  }
  for (const k of ["file", "filename", "line_start", "line_end", "start_line", "end_line"]) delete o[k];
  return o;
};

const shellAliasArgs = (a) => {
  const o = { ...a };
  if (o.cmd != null && o.command == null) o.command = o.cmd;
  delete o.cmd;
  return o;
};

/**
 * Names models reach for that are not real tools, mapped onto the builtin
 * they meant. Costs no schema tokens: an alias only resolves when its target
 * is registered, and the call runs as the target. Measured on the halo-scan
 * tool bench: roughly 60 of 97 tool errors on gpt-oss:20b were calls to
 * names like `search` and `open_file`.
 *
 * @type {Readonly<Record<string, ToolAlias>>}
 */
export const DEFAULT_TOOL_ALIASES = Object.freeze({
  search: { target: "grep_search", args: grepAliasArgs },
  search_file: { target: "grep_search", args: grepAliasArgs },
  search_files: { target: "grep_search", args: grepAliasArgs },
  search_code: { target: "grep_search", args: grepAliasArgs },
  search_text: { target: "grep_search", args: grepAliasArgs },
  grep: { target: "grep_search", args: grepAliasArgs },
  rg: { target: "grep_search", args: grepAliasArgs },
  open_file: { target: "read_file", args: readAliasArgs },
  view_file: { target: "read_file", args: readAliasArgs },
  cat: { target: "read_file", args: readAliasArgs },
  read: { target: "read_file", args: readAliasArgs },
  list_files: { target: "find_files" },
  glob: { target: "find_files" },
  ls: { target: "list_dir" },
  list_directory: { target: "list_dir" },
  shell: { target: "run_command", args: shellAliasArgs },
  bash: { target: "run_command", args: shellAliasArgs },
  execute_command: { target: "run_command", args: shellAliasArgs },
  run_shell_command: { target: "run_command", args: shellAliasArgs },
});

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
     * Tools to approve without prompting. `"all"` covers every gated tool;
     * a Set names specific tools. Null means nothing is auto-approved.
     * @type {"all"|Set<string>|null}
     */
    this.autoApprove = null;
    /**
     * True only while executing a gated call that was approved — by the
     * handler or by auto-approve. Unattended runs leave this false so
     * deletion and cleanup checks still apply.
     * @type {boolean}
     */
    this.callApproved = false;
    /**
     * Per-run context tools may consult for safety decisions — the agent
     * loop sets `{ goal }` at the start of each run so tools like
     * run_command can check what the user actually authorized.
     * @type {{goal?: string}|null}
     */
    this.runContext = null;
    /**
     * Alternate names resolved at call time (see {@link DEFAULT_TOOL_ALIASES}).
     * Never listed in `schemas()`.
     * @type {Map<string, ToolAlias>}
     */
    this.aliases = new Map(Object.entries(DEFAULT_TOOL_ALIASES));
  }

  /**
   * Add call-time aliases. An alias whose target is not registered is simply
   * never matched, so a full table can be installed up front.
   * @param {Record<string, ToolAlias>|Map<string, ToolAlias>} aliases
   */
  registerAliases(aliases) {
    const entries = aliases instanceof Map ? aliases.entries() : Object.entries(aliases ?? {});
    for (const [name, alias] of entries) {
      if (!name || !alias?.target) continue;
      this.aliases.set(name, { target: alias.target, args: alias.args });
    }
    return this;
  }

  /**
   * Resolve a call name to a registered tool, following aliases when the name
   * itself is not registered but its alias target is.
   * @param {string} name
   * @param {object} [args]
   * @returns {{tool: ToolDefinition, args: object, alias: string|null}|null}
   */
  resolve(name, args = {}) {
    const direct = this.tools.get(name);
    if (direct) return { tool: direct, args: args ?? {}, alias: null };
    const alias = this.aliases.get(name);
    if (!alias) return null;
    const target = this.tools.get(alias.target);
    if (!target) return null;
    return { tool: target, args: alias.args ? alias.args(args ?? {}) : args ?? {}, alias: name };
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

  /**
   * Approve gated tools without consulting the handler.
   * `all` covers every gated tool; a list names specific tools; `off`
   * clears the policy.
   * @param {"all"|"off"|boolean|string[]|null} policy
   */
  setAutoApprove(policy) {
    if (policy == null || policy === false || policy === "off") {
      this.autoApprove = null;
    } else if (policy === true || policy === "all") {
      this.autoApprove = "all";
    } else if (Array.isArray(policy)) {
      this.autoApprove = new Set(policy);
    } else {
      throw new Error(`auto-approve policy must be all, off, or a list of tool names.`);
    }
    return this;
  }

  /** @param {string} name */
  isAutoApproved(name) {
    if (this.autoApprove === "all") return true;
    if (this.autoApprove instanceof Set) return this.autoApprove.has(name);
    return false;
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

  /**
   * Register a tool, replacing any existing one with the same name. Used
   * when an embedded toolset supersedes a builtin (same name, richer tool).
   * @param {ToolDefinition} tool
   * @returns {boolean} True when an existing tool was replaced.
   */
  replace(tool) {
    const existed = this.tools.has(tool?.name);
    if (existed) this.tools.delete(tool.name);
    this.register(tool);
    return existed;
  }

  /** @param {string} name @returns {boolean} True when a tool was removed. */
  unregister(name) {
    return this.tools.delete(name);
  }

  has(name) {
    return this.tools.has(name);
  }

  /** @returns {string[]} Registered tool names in registration order. */
  names() {
    return [...this.tools.keys()];
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
   * @returns {Promise<{ok: boolean, result?: unknown, error?: string, resolvedName?: string}>}
   *   `resolvedName` is set when the call came in under an alias.
   */
  async execute(name, args) {
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

    const resolved = this.resolve(name, parsedArgs ?? {});
    if (!resolved) {
      const valid = [...this.tools.keys()];
      const similar = suggestSimilarTools(name, valid);
      const hint = similar.length ? ` Did you mean: ${similar.join(", ")}?` : "";
      return {
        ok: false,
        error: `Unknown tool '${name}'. Available tools: ${valid.join(", ") || "(none)"}.${hint}`,
      };
    }
    const { tool } = resolved;
    parsedArgs = resolved.args;
    const aliasNote = resolved.alias ? { resolvedName: tool.name } : {};

    let approvedCall = false;
    if (tool.requiresApproval) {
      if (this.isAutoApproved(tool.name)) {
        approvedCall = true;
      } else if (this.approvalHandler) {
        let approved;
        try {
          approved = await this.approvalHandler({ name: tool.name, args: parsedArgs ?? {} });
        } catch (err) {
          return { ok: false, error: `Approval check failed: ${err?.message ?? err}` };
        }
        if (!approved) {
          return {
            ok: false,
            error: `The user declined to allow '${name}'. Do not retry the same call; ask the user or find another way.`,
          };
        }
        approvedCall = true;
      }
    }

    this.callApproved = approvedCall;
    try {
      const result = await tool.execute(parsedArgs ?? {});
      return { ok: true, result, ...aliasNote };
    } catch (err) {
      return { ok: false, error: `Tool '${tool.name}' failed: ${err?.message ?? err}`, ...aliasNote };
    } finally {
      this.callApproved = false;
    }
  }
}

const AUTO_APPROVE_ON = new Set(["all", "on", "true", "yes", "*"]);
const AUTO_APPROVE_OFF = new Set(["off", "none", "false", "no"]);

/**
 * Parse a CLI or config auto-approve value.
 * `all` / `on` / `true` / `yes` / `*` approve every gated tool.
 * `off` / `none` / `false` / `no` approve none.
 * Anything else is a comma-separated tool list (`write_file,run_command`).
 *
 * @param {unknown} raw
 * @param {string} [label] Used in error text (`--auto-approve`, config key).
 * @returns {{ ok: true, policy: "all"|"off"|string[] } | { ok: false, error: string }}
 */
export function parseAutoApproveSpec(raw, label = "--auto-approve") {
  if (raw === true) return { ok: true, policy: "all" };
  if (raw === false) return { ok: true, policy: "off" };

  if (Array.isArray(raw)) {
    if (raw.length === 0) return { ok: true, policy: "off" };
    if (raw.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
      return { ok: false, error: `${label} list entries must be tool names.` };
    }
    return parseAutoApproveSpec(raw.map((entry) => entry.trim()).join(","), label);
  }

  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      ok: false,
      error: `${label} needs all, off, or a comma-separated tool list (e.g. write_file,run_command).`,
    };
  }

  const token = raw.trim();
  const keyword = token.toLowerCase();
  if (AUTO_APPROVE_ON.has(keyword)) return { ok: true, policy: "all" };
  if (AUTO_APPROVE_OFF.has(keyword)) return { ok: true, policy: "off" };

  const names = token.split(",").map((part) => part.trim()).filter(Boolean);
  const bad = names.filter((name) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(name));
  if (names.length === 0 || bad.length > 0) {
    return {
      ok: false,
      error:
        `${label} needs all, off, or a comma-separated tool list (e.g. write_file,run_command)` +
        (bad.length ? `, got '${bad.join(", ")}'` : "") +
        ".",
    };
  }
  return { ok: true, policy: names };
}
