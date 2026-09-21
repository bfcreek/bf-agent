/**
 * Bitfield Agent SDK entry point.
 *
 *   import { createAgent } from "@bitfieldcreek/bf-agent";
 *   const agent = await createAgent({ workspaceRoot: process.cwd() });
 *   const { text } = await agent.run("what does this project do?");
 *
 * The agent is Cursor-shaped: a short system prompt plus rules files, a tool
 * set the model uses to find its own context, and a thin loop that runs
 * until the model stops calling tools. Hooks (`beforeToolCall`,
 * `afterToolCall`, `stop`) are where callers add policy.
 */

import { AgentLoop, DEFAULT_SYSTEM_PROMPT } from "./agent-loop.mjs";
import { CheckpointStore } from "./checkpoints.mjs";
import { buildSystemPrompt } from "./context-builder.mjs";
import { formatMcpToolIndex } from "./mcp-client.mjs";
import {
  ModelRoutingError,
  resolveModelAuto,
  assertToolCapable,
  assertVisionCapable,
} from "./model-routing.mjs";
import { configureClientModel, modelPromptOverlay } from "./model-tuning.mjs";
import { OllamaClient } from "./ollama-client.mjs";
import { ensureProjectIndex } from "./project-index.mjs";
import { ToolRegistry } from "./tool-registry.mjs";
import { registerBuiltinTools } from "./tools/builtin.mjs";

export {
  AgentLoop,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_STOP_HOOK_LOOPS,
  DEFAULT_SYSTEM_PROMPT,
  isToolCallParseError,
  toolResultContent,
} from "./agent-loop.mjs";

export { CHECKPOINT_DIR, CheckpointStore } from "./checkpoints.mjs";

export {
  describeFitBudget,
  detectVramBytes,
  resetHardwareProbe,
  resolveModelFitBudget,
  VRAM_FIT_FRACTION,
} from "./hardware.mjs";

export {
  buildEnvironmentContext,
  buildGitSnapshot,
  buildSystemPrompt,
  listNestedAgentsFiles,
  listRules,
  loadAppliedInstructions,
  parseRuleFrontmatter,
  shouldAlwaysApplyRule,
} from "./context-builder.mjs";

export {
  chunkText,
  discoverIndexFiles,
  ensureProjectIndex,
  indexPath,
  loadIndex,
  searchProjectIndex,
  DEFAULT_EMBEDDING_MODEL,
} from "./project-index.mjs";

export {
  compactMessages,
  estimateTokens,
  extractOriginalInstruction,
  transcriptSize,
  DEFAULT_CONTEXT_FRACTION,
  DEFAULT_KEEP_RECENT,
  DEFAULT_MAX_CHARS,
} from "./compaction.mjs";

export { formatMcpToolIndex, McpClient, McpError, registerMcpTools } from "./mcp-client.mjs";

export {
  assertToolCapable,
  assertVisionCapable,
  detectCapabilities,
  detectToolCapable,
  detectVisionCapable,
  isCloudModel,
  isLikelyThinkingCapable,
  isLikelyToolCapable,
  isLikelyVisionCapable,
  listClassifiedModels,
  listClassifiedModelsDetected,
  MEMORY_FIT_FRACTION,
  messageHasImages,
  messagesHaveImages,
  MIN_EFFECTIVE_PARAMS_B,
  ModelRoutingError,
  parseParamsBillions,
  resolveModel,
  resolveModelAuto,
  resolveModelDetected,
  suggestModel,
} from "./model-routing.mjs";

export {
  configureClientModel,
  isGptOssModel,
  MAX_AUTO_NUM_CTX,
  minimalThinkSetting,
  modelPromptOverlay,
  resolveAutoNumCtx,
  resolveThinkSetting,
  sizeContextWindow,
} from "./model-tuning.mjs";

export {
  checkContextWindow,
  deriveMinimumContext,
  MIN_NUM_CTX,
  RECOMMENDED_NUM_CTX,
  RECOMMENDED_NUM_CTX_THINKING,
} from "./context-spec.mjs";

export {
  DEFAULT_NUM_CTX,
  DEFAULT_TEMPERATURE,
  DEFAULT_THINK,
  OllamaClient,
  OllamaClientError,
} from "./ollama-client.mjs";

export { createOpenAIServer } from "./openai-server.mjs";

export { changedFilesFromSteps, SessionStore } from "./session-store.mjs";

export { ToolRegistry } from "./tool-registry.mjs";

export { registerBuiltinTools, registerRuleTool } from "./tools/builtin.mjs";

export { registerProjectSearchTool } from "./tools/project-search.mjs";

export {
  nearbySnippet,
  normalizeWorkspaceRelativePath,
  registerFileTools,
  replaceFlexible,
  resolveWithinRoot,
} from "./tools/fs.mjs";

export { createOutputSpiller, MAX_TOOL_OUTPUT_CHARS, truncateMiddle, truncateOutput } from "./tools/output.mjs";

export { globToRegExp, registerSearchTools } from "./tools/search.mjs";

export { registerShellTools, adaptPowerShellCommand } from "./tools/shell.mjs";

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
 * @param {number} [options.maxSteps] Safety cap on model round-trips per turn.
 * @param {number} [options.wallClockMs] Wall-clock budget per run (0 = none).
 * @param {object|false} [options.compaction] Loop compaction settings; on by default.
 * @param {import("./agent-loop.mjs").AgentHooks} [options.hooks]
 * @param {(step: object) => void} [options.onStep]
 * @param {(delta: string) => void} [options.onDelta] Live content tokens from the model.
 * @param {(request: {name: string, args: object}) => Promise<boolean>|boolean} [options.approvalHandler]
 *   Gate write/shell tools. Without one, gated tools run unattended.
 * @param {Array<import("./tool-registry.mjs").ToolDefinition>} [options.tools]
 *   Extra tools registered alongside (or instead of) the builtins.
 * @param {boolean} [options.builtinTools] Set false for a custom-tools-only agent.
 * @param {boolean} [options.projectIndex] Build the local project index and
 *   register search_project (default true when an embed client is available).
 * @param {string} [options.embeddingModel] Embedding model for the project index.
 * @param {boolean} [options.checkpoints] Snapshot files before writes (default true).
 * @param {string} [options.systemPrompt] Full override; skips the context builder.
 * @param {boolean|string} [options.think] Ollama native thinking mode (default auto).
 * @param {boolean} [options.requireVision] Route to a vision-capable model.
 * @param {{chat: Function}} [options.client] Injectable client (tests, custom backends).
 */
export async function createAgent({
  model = "auto",
  baseUrl,
  numCtx,
  workspaceRoot = process.cwd(),
  maxSteps,
  wallClockMs,
  compaction = {},
  hooks,
  onStep,
  onDelta,
  approvalHandler,
  tools,
  builtinTools = true,
  projectIndex = true,
  embeddingModel,
  checkpoints = true,
  systemPrompt,
  think,
  requireVision = false,
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
      const routed = await resolveModelAuto({ requested: resolvedModel, client: resolvedClient, requireVision });
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
      if (requireVision) assertVisionCapable(resolvedModel);
    }
  }

  const useIndex = projectIndex && typeof resolvedClient.embed === "function";
  const checkpointStore = checkpoints ? new CheckpointStore({ workspaceRoot }) : undefined;
  const registry = new ToolRegistry();
  if (builtinTools) {
    registerBuiltinTools(registry, {
      workspaceRoot,
      searchClient: useIndex ? resolvedClient : undefined,
      embeddingModel,
      checkpoints: checkpointStore,
    });
  }
  for (const tool of tools ?? []) registry.register(tool);
  if (approvalHandler) registry.setApprovalHandler(approvalHandler);

  if (useIndex) {
    try {
      await ensureProjectIndex({ workspaceRoot, client: resolvedClient, embeddingModel });
    } catch {
      // Index is best-effort; search_project reports its own errors.
    }
  }

  const prompt =
    systemPrompt != null
      ? systemPrompt
      : await buildSystemPrompt({
          basePrompt: DEFAULT_SYSTEM_PROMPT,
          modelOverlay: modelPromptOverlay(resolvedClient.model),
          workspaceRoot,
          extraContext: formatMcpToolIndex(registry),
        });

  const loop = new AgentLoop({
    client: resolvedClient,
    registry,
    systemPrompt: prompt,
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...(wallClockMs !== undefined ? { wallClockMs } : {}),
    onStep,
    onDelta,
    compaction,
    hooks,
  });
  return {
    loop,
    registry,
    client: resolvedClient,
    checkpoints: checkpointStore,
    /** @type {(goal: string, options?: {history?: Array<object>, signal?: AbortSignal, images?: string[]}) => Promise<import("./agent-loop.mjs").AgentRunResult>} */
    run: (goal, options) => loop.run(goal, options),
    steer: (text) => loop.steer(text),
    queue: (text) => loop.queue(text),
  };
}
