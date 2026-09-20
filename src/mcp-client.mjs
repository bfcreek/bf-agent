/**
 * Minimal MCP (Model Context Protocol) client over stdio: newline-delimited
 * JSON-RPC 2.0 to a spawned server process. Covers the tool surface —
 * initialize, tools/list, tools/call — which is all the agent needs to use
 * external tools without forking the runtime.
 */

import { spawn } from "node:child_process";

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT_MS = 15_000;

export class McpError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = "McpError";
    this.code = code ?? null;
  }
}

export class McpClient {
  /**
   * Spawn an MCP server and complete the initialize handshake.
   *
   * @param {object} options
   * @param {string} options.command Executable or full command line (runs
   *   through the system shell, so `npx some-server` works everywhere).
   * @param {string[]} [options.args]
   * @param {object} [options.env] Extra environment variables.
   * @param {number} [options.timeoutMs] Per-request timeout.
   * @param {(line: string) => void} [options.onStderr] Server log lines.
   */
  static async connect({ command, args = [], env, timeoutMs = DEFAULT_TIMEOUT_MS, onStderr }) {
    const child = spawn(command, args, {
      shell: true,
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new McpClient(child, { timeoutMs, onStderr });
    const result = await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "bitfield-agent", version: "0.1.0" },
    });
    client.serverInfo = result?.serverInfo ?? null;
    client.notify("notifications/initialized", {});
    return client;
  }

  /** @param {import("node:child_process").ChildProcess} child */
  constructor(child, { timeoutMs = DEFAULT_TIMEOUT_MS, onStderr } = {}) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
    this.pending = new Map();
    this.closed = false;
    this.serverInfo = null;

    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.#handleLine(line);
      }
    });

    if (onStderr) {
      let errBuffer = "";
      child.stderr.on("data", (chunk) => {
        errBuffer += chunk;
        let newline;
        while ((newline = errBuffer.indexOf("\n")) !== -1) {
          onStderr(errBuffer.slice(0, newline).trimEnd());
          errBuffer = errBuffer.slice(newline + 1);
        }
      });
    } else {
      child.stderr.resume();
    }

    child.on("close", () => {
      this.closed = true;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new McpError("MCP server exited before responding."));
      }
      this.pending.clear();
    });
    child.on("error", (err) => {
      this.closed = true;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new McpError(`MCP server failed to start: ${err.message}`));
      }
      this.pending.clear();
    });
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // not JSON-RPC; some servers leak logs to stdout
    }

    if (message.id !== undefined && message.method) {
      // Server-to-client request. Answer pings; refuse anything else.
      if (message.method === "ping") {
        this.#write({ jsonrpc: "2.0", id: message.id, result: {} });
      } else {
        this.#write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Bitfield Agent does not handle '${message.method}'.` },
        });
      }
      return;
    }

    if (message.id === undefined) return; // notification — nothing to do in v1

    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(
        new McpError(message.error.message ?? "MCP request failed.", { code: message.error.code }),
      );
    } else {
      entry.resolve(message.result);
    }
  }

  #write(payload) {
    if (this.closed) throw new McpError("MCP connection is closed.");
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`MCP request '${method}' timed out after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  /** @returns {Promise<Array<{name: string, description?: string, inputSchema?: object}>>} */
  async listTools() {
    const result = await this.request("tools/list", {});
    return result?.tools ?? [];
  }

  /**
   * Call one MCP tool. Text content is flattened to a string; a result
   * flagged `isError` throws so the registry reports it to the model.
   */
  async callTool(name, args) {
    const result = await this.request("tools/call", { name, arguments: args ?? {} });
    const text = (result?.content ?? [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    if (result?.isError) throw new McpError(text || `MCP tool '${name}' reported an error.`);
    return text;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    const exited = new Promise((resolve) => this.child.once("close", resolve));
    const timer = setTimeout(() => this.child.kill(), 2000);
    await exited;
    clearTimeout(timer);
  }
}

/**
 * Bridge an MCP server's tools into the registry.
 *
 * Two modes, following Cursor's dynamic MCP loading:
 *
 * - `lazy` (default): the model sees only tool names and one-line descriptions
 *   (via {@link formatMcpToolIndex} in the system prompt) plus two generic
 *   tools, `describe_tool` and `call_mcp_tool`. It fetches a schema only when
 *   it decides to use that tool, so large servers do not flood every request
 *   with schemas.
 * - `inline` (`lazy: false`): each MCP tool is registered as its own
 *   function `mcp_<name>` with its full schema in every request.
 *
 * @param {import("./tool-registry.mjs").ToolRegistry} registry
 * @param {McpClient} client
 * @param {object} [options]
 * @param {string} [options.prefix] Inline-mode name prefix.
 * @param {boolean} [options.lazy]
 * @returns {Promise<string[]>} Tool names made available (registered names in
 *   inline mode, catalog names in lazy mode).
 */
export async function registerMcpTools(registry, client, { prefix = "mcp_", lazy = true } = {}) {
  const tools = await client.listTools();
  const serverName = client.serverInfo?.name ?? "mcp";

  if (!lazy) {
    const registered = [];
    for (const tool of tools) {
      const name = `${prefix}${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
      registry.register({
        name,
        description: tool.description ?? `MCP tool '${tool.name}'.`,
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
        execute: (args) => client.callTool(tool.name, args),
      });
      registered.push(name);
    }
    return registered;
  }

  if (!registry.mcpCatalog) registry.mcpCatalog = new Map();
  const names = [];
  for (const tool of tools) {
    const name = `${serverName}/${tool.name}`;
    registry.mcpCatalog.set(name, { server: serverName, client, tool });
    names.push(name);
  }
  ensureMcpBridgeTools(registry);
  return names;
}

function ensureMcpBridgeTools(registry) {
  if (!registry.has("describe_tool")) {
    registry.register({
      name: "describe_tool",
      description:
        "Get the full description and JSON argument schema of an MCP tool listed under 'MCP tools' in your instructions. Call this before call_mcp_tool for a tool you have not used yet.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Tool name as listed, e.g. 'server/tool'." },
        },
        required: ["name"],
      },
      execute({ name }) {
        const entry = lookupMcpTool(registry, name);
        return {
          name,
          description: entry.tool.description ?? "",
          parameters: entry.tool.inputSchema ?? { type: "object", properties: {} },
        };
      },
    });
  }
  if (!registry.has("call_mcp_tool")) {
    registry.register({
      name: "call_mcp_tool",
      description:
        "Call an MCP tool listed under 'MCP tools' in your instructions, with arguments matching the schema from describe_tool.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Tool name as listed, e.g. 'server/tool'." },
          arguments: { type: "object", description: "Arguments object for the tool." },
        },
        required: ["name"],
      },
      execute({ name, arguments: args }) {
        const entry = lookupMcpTool(registry, name);
        return entry.client.callTool(entry.tool.name, args ?? {});
      },
    });
  }
}

function lookupMcpTool(registry, name) {
  const catalog = registry.mcpCatalog ?? new Map();
  const key = String(name ?? "").trim();
  let entry = catalog.get(key);
  if (!entry) {
    // Accept the bare tool name when it is unambiguous.
    const matches = [...catalog.entries()].filter(([full]) => full.endsWith(`/${key}`));
    if (matches.length === 1) entry = matches[0][1];
  }
  if (!entry) {
    const known = [...catalog.keys()];
    throw new Error(`Unknown MCP tool '${name}'. Known tools: ${known.join(", ") || "(none)"}.`);
  }
  return entry;
}

/**
 * System-prompt block listing lazily registered MCP tools by name and short
 * description. Empty string when there are none.
 *
 * @param {import("./tool-registry.mjs").ToolRegistry} registry
 * @returns {string}
 */
export function formatMcpToolIndex(registry) {
  const catalog = registry?.mcpCatalog;
  if (!catalog || catalog.size === 0) return "";
  const lines = ["## MCP tools (describe_tool for the schema, call_mcp_tool to invoke)"];
  for (const [name, { tool }] of catalog) {
    const desc = String(tool.description ?? "").split(/\r?\n/)[0].trim().slice(0, 120);
    lines.push(`- ${name}${desc ? `: ${desc}` : ""}`);
  }
  return lines.join("\n");
}
