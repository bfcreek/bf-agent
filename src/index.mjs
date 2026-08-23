/**
 * halo-agent SDK: the public embedding API. Everything the CLI and server
 * are built from is exported here, plus `createAgent` — a one-call setup
 * for the common case.
 *
 * import { createAgent } from "halo-agent";
 * const agent = await createAgent({ model: "qwen3-coder:30b" });
 * const { text } = await agent.run("summarize src/agent-loop.mjs");
 */

import { AgentLoop, DEFAULT_SYSTEM_PROMPT } from "./agent-loop.mjs";
import { buildSystemPrompt } from "./context-builder.mjs";
import { OllamaClient } from "./ollama-client.mjs";
import { ToolRegistry } from "./tool-registry.mjs";
import { registerBuiltinTools } from "./tools/builtin.mjs";

export { AgentLoop, DEFAULT_SYSTEM_PROMPT } from "./agent-loop.mjs";
export { buildEnvironmentContext, buildSystemPrompt } from "./context-builder.mjs";
export {
  compactMessages,
  transcriptSize,
  DEFAULT_KEEP_RECENT,
  DEFAULT_MAX_CHARS,
} from "./compaction.mjs";
export { McpClient, McpError, registerMcpTools } from "./mcp-client.mjs";
export { isLikelyToolCapable, resolveModel } from "./model-routing.mjs";
export { OllamaClient, OllamaClientError } from "./ollama-client.mjs";
export { createOpenAIServer } from "./openai-server.mjs";
export { changedFilesFromSteps, SessionStore } from "./session-store.mjs";
export { ToolRegistry } from "./tool-registry.mjs";
export { registerBuiltinTools } from "./tools/builtin.mjs";
export {
  MAX_TOOL_OUTPUT_CHARS,
  registerFileTools,
  resolveWithinRoot,
  truncateMiddle,
  truncateOutput,
} from "./tools/fs.mjs";
export { registerShellTools } from "./tools/shell.mjs";

/**
 * One-call agent setup: Ollama client, builtin tools, context-built system
 * prompt, compaction — each overridable or removable.
 *
 * @param {object} [options]
 * @param {string} [options.model]
 * @param {string} [options.baseUrl]
 * @param {string} [options.workspaceRoot] Root for file/shell tools and the
 *   workspace snapshot in the system prompt.
 * @param {number} [options.maxSteps]
 * @param {object|false} [options.compaction] Loop compaction settings; on by default.
 * @param {(step: object) => void} [options.onStep]
 * @param {(request: {name: string, args: object}) => Promise<boolean>|boolean} [options.approvalHandler]
 *   Gate write/shell tools. Without one, gated tools run unattended.
 * @param {Array<import("./tool-registry.mjs").ToolDefinition>} [options.tools]
 *   Extra tools registered alongside (or instead of) the builtins.
 * @param {boolean} [options.builtinTools] Set false for a custom-tools-only agent.
 * @param {string} [options.systemPrompt] Full override; skips the context builder.
 * @param {{chat: Function}} [options.client] Injectable client (tests, custom backends).
 */
export async function createAgent({
  model = "llama3.2",
  baseUrl,
  workspaceRoot = process.cwd(),
  maxSteps = 10,
  compaction = {},
  onStep,
  approvalHandler,
  tools,
  builtinTools = true,
  systemPrompt,
  client,
} = {}) {
  const resolvedClient = client ?? new OllamaClient({ baseUrl, model });
  const registry = new ToolRegistry();
  if (builtinTools) registerBuiltinTools(registry, { workspaceRoot });
  for (const tool of tools ?? []) registry.register(tool);
  if (approvalHandler) registry.setApprovalHandler(approvalHandler);

  const prompt =
    systemPrompt ??
    (await buildSystemPrompt({ basePrompt: DEFAULT_SYSTEM_PROMPT, workspaceRoot }));

  const loop = new AgentLoop({
    client: resolvedClient,
    registry,
    systemPrompt: prompt,
    maxSteps,
    onStep,
    compaction,
  });

  return {
    loop,
    registry,
    client: resolvedClient,
    /** @type {(goal: string, options?: {history?: Array<object>, signal?: AbortSignal}) => Promise<import("./agent-loop.mjs").AgentRunResult>} */
    run: (goal, options) => loop.run(goal, options),
  };
}
