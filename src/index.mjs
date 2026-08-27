/**
 * halo-agent SDK: the public embedding API. Everything the CLI and server
 * are built from is exported here, plus `createAgent` — a one-call setup
 * for the common case.
 *
 * import { createAgent } from "@halosoftworks/halo-agent";
 * const agent = await createAgent({ model: "qwen3-coder:30b" });
 * const { text } = await agent.run("summarize src/agent-loop.mjs");
 */
import { AgentLoop, DEFAULT_SYSTEM_PROMPT } from "./agent-loop.mjs";
import { buildSystemPrompt } from "./context-builder.mjs";
import { buildProjectContext } from "./project-index.mjs";
import { ModelRoutingError, resolveModelAuto, assertToolCapable } from "./model-routing.mjs";
import { OllamaClient } from "./ollama-client.mjs";
import { configureClientModel } from "./prompt-enhancements.mjs";
import { ToolRegistry } from "./tool-registry.mjs";
import { registerBuiltinTools } from "./tools/builtin.mjs";

export { AgentLoop, DEFAULT_SYSTEM_PROMPT } from "./agent-loop.mjs";

export { buildEnvironmentContext, buildSystemPrompt } from "./context-builder.mjs";

export {
  buildProjectContext,
  chunkText,
  discoverIndexFiles,
  ensureProjectIndex,
  gatherFirstTurnProjectContext,
  indexPath,
  loadIndex,
  readProjectReadme,
  searchProjectIndex,
  DEFAULT_EMBEDDING_MODEL,
} from "./project-index.mjs";

export {
  compactMessages,
  estimateTokens,
  extractOriginalInstruction,
  formatVerificationRecap,
  transcriptSize,
  DEFAULT_CONTEXT_FRACTION,
  DEFAULT_KEEP_RECENT,
  DEFAULT_MAX_CHARS,
} from "./compaction.mjs";

export { McpClient, McpError, registerMcpTools } from "./mcp-client.mjs";

export {
  assertToolCapable,
  detectCapabilities,
  detectToolCapable,
  isCloudModel,
  isLikelyThinkingCapable,
  isLikelyToolCapable,
  listClassifiedModels,
  listClassifiedModelsDetected,
  MEMORY_FIT_FRACTION,
  MIN_EFFECTIVE_PARAMS_B,
  ModelRoutingError,
  parseParamsBillions,
  resolveModel,
  resolveModelAuto,
  resolveModelDetected,
  suggestModel,
} from "./model-routing.mjs";

export {
  DEFAULT_NUM_CTX,
  DEFAULT_TEMPERATURE,
  DEFAULT_THINK,
  OllamaClient,
  OllamaClientError,
} from "./ollama-client.mjs";

export {
  COMPLEX_GOAL_MIN_WORDS,
  PLANNING_USER_MESSAGE,
  completionVerifyNudge,
  configureClientModel,
  detectTaskHints,
  finalAnswerNudge,
  formatExplicitGoals,
  formatTaskConstraints,
  isComplexGoal,
  shouldPlanGoal,
  isGptOssModel,
  mutationBlockedUntilPretest,
  prematureFinalNudge,
  redundantVerifyBlock,
  repeatedEditMissNudge,
  verificationCompleteOutcome,
  blockedCommandOutcome,
  synthesizeFinalAnswer,
  resolveThinkSetting,
} from "./prompt-enhancements.mjs";

export { createOpenAIServer } from "./openai-server.mjs";

export { changedFilesFromSteps, SessionStore } from "./session-store.mjs";

export { ToolRegistry } from "./tool-registry.mjs";

export { registerBuiltinTools } from "./tools/builtin.mjs";

export { registerProjectSearchTool } from "./tools/project-search.mjs";

export {
  MAX_TOOL_OUTPUT_CHARS,
  nearbySnippet,
  normalizeWorkspaceRelativePath,
  registerFileTools,
  replaceFlexible,
  resolveWithinRoot,
  truncateMiddle,
  truncateOutput,
} from "./tools/fs.mjs";

export { globToRegExp, registerSearchTools } from "./tools/search.mjs";

export { registerShellTools } from "./tools/shell.mjs";

export {
  assertFetchableUrl,
  bodyToText,
  fetchUrlContent,
  htmlToText,
  lexicalScore,
  microRagPage,
  registerFetchUrlTool,
} from "./tools/fetch-url.mjs";

export {
  decodeHtmlEntities,
  formatWebSearchResults,
  parseDuckDuckGoHtml,
  registerWebSearchTool,
  searchDuckDuckGo,
  stripTags,
  unwrapDuckDuckGoUrl,
} from "./tools/web-search.mjs";

/**
 * One-call agent setup: Ollama client, builtin tools, context-built system
 * prompt, compaction — each overridable or removable.
 *
 * @param {object} [options]
 * @param {string} [options.model] Model name, or "auto" (default): the
 *   strongest installed model with thinking + tool support that fits in
 *   memory, falling back to an installed Ollama cloud model when no local
 *   model is strong enough.
 * @param {string} [options.baseUrl]
 * @param {number|null} [options.numCtx] Context window (tokens) sent to
 *   Ollama on every call; null uses Ollama's server default.
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
 * @param {boolean} [options.projectIndex] Build/search local project index (default true).
 * @param {string} [options.embeddingModel] Embedding model for project index.
 * @param {boolean} [options.projectBootstrap] First-turn README/RAG injection (default true).
 * @param {string} [options.systemPrompt] Full override; skips the context builder.
 * @param {boolean} [options.planning] Planning pre-pass on first turns (default true).
 * @param {boolean} [options.taskHints] Task-type constraint hints (default true).
 * @param {boolean|string} [options.think] Ollama native thinking mode (default auto).
 * @param {{chat: Function}} [options.client] Injectable client (tests, custom backends).
 */

export async function createAgent({
  model = "auto",
  baseUrl,
  numCtx,
  workspaceRoot = process.cwd(),
  maxSteps = 10,
  compaction = {},
  onStep,
  approvalHandler,
  tools,
  builtinTools = true,
  projectIndex = true,
  projectBootstrap = true,
  embeddingModel,
  systemPrompt,
  planning = true,
  taskHints = true,
  think,
  client,
} = {}) {
  let resolvedModel = model;
  const resolvedClient =
    client ??
    new OllamaClient({
      baseUrl,
      model: resolvedModel,
      ...(numCtx !== undefined ? { numCtx } : {}),
      ...(think !== undefined ? { think } : {}),
    });
  if (!client) {
    try {
      const routed = await resolveModelAuto({
        requested: resolvedModel,
        client: resolvedClient,
      });
      resolvedModel = routed.model;
      await configureClientModel(resolvedClient, routed.model);
    } catch (err) {
      if (err instanceof ModelRoutingError) throw err;
      // Ollama unreachable: an explicit, known-capable model may proceed
      // (the run will surface the connection error); auto cannot.
      if (resolvedModel === "auto") {
        throw new ModelRoutingError(
          `Cannot reach Ollama to auto-select a model (${err?.message ?? err}). Start Ollama or pass an explicit model.`,
        );
      }
      assertToolCapable(resolvedModel);
    }
  }
  const registry = new ToolRegistry();
  if (builtinTools) {
    registerBuiltinTools(registry, {
      workspaceRoot,
      searchClient: projectIndex ? resolvedClient : undefined,
      embeddingModel,
    });
  }
  for (const tool of tools ?? []) registry.register(tool);
  if (approvalHandler) registry.setApprovalHandler(approvalHandler);
  const prompt =
    systemPrompt ??
    (await buildSystemPrompt({
      basePrompt: DEFAULT_SYSTEM_PROMPT,
      workspaceRoot,
      projectContext: await buildProjectContext({
        workspaceRoot,
        client: projectIndex ? resolvedClient : undefined,
        embeddingModel,
        index: projectIndex,
      }),
    }));
  const loop = new AgentLoop({
    client: resolvedClient,
    registry,
    systemPrompt: prompt,
    maxSteps,
    onStep,
    compaction,
    planning,
    taskHints,
    projectBootstrap: projectBootstrap
      ? {
          workspaceRoot,
          client: projectIndex ? resolvedClient : undefined,
          embeddingModel,
        }
      : false,
  });
  return {
    loop,
    registry,
    client: resolvedClient,
    /** @type {(goal: string, options?: {history?: Array<object>, signal?: AbortSignal}) => Promise<import("./agent-loop.mjs").AgentRunResult>} */
    run: (goal, options) => loop.run(goal, options),
  };
}
