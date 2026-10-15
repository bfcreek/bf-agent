/**
 * Bitfield Ollama Agent SDK entry point.
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

import { AgentLoop, composeSystemPrompt, DEFAULT_STREAK_NUDGE_AFTER, DEFAULT_SYSTEM_PROMPT } from "./agent-loop.mjs";
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
import { createProviderClient, shouldRouteOllamaModel } from "./providers/factory.mjs";
import { ToolRegistry } from "./tool-registry.mjs";
import { registerBuiltinTools } from "./tools/builtin.mjs";
import { withHollowCompletionGuard } from "./hollow-completion-guard.mjs";
import { HALO_SCAN_CONTEXT_GUIDANCE, HALO_SCAN_STREAK_HINT, registerHaloScanTools } from "./tools/halo-scan.mjs";
import { ensureAgentDataDir } from "./workspace-data.mjs";

export {
  AgentLoop,
  BUILTIN_CONTEXT_GUIDANCE,
  composeSystemPrompt,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_STOP_HOOK_LOOPS,
  DEFAULT_STREAK_NUDGE_AFTER,
  DEFAULT_STREAK_NUDGE_HINT,
  DEFAULT_SYSTEM_PROMPT,
  isToolCallParseError,
  streakNudgePrompt,
  toolResultContent,
} from "./agent-loop.mjs";

export { CHECKPOINT_DIR, CheckpointStore } from "./checkpoints.mjs";

export {
  AGENT_DATA_DIR,
  AGENT_DATA_DIR_POSIX,
  AGENT_DATA_HIDDEN_NAMES,
  AGENT_DATA_SKIP_NAMES,
  LEGACY_AGENT_DATA_DIR,
  LEGACY_AGENT_DATA_DIRS,
  agentDataPath,
  agentDataRel,
  ensureAgentDataDir,
  migrateAgentDataDir,
} from "./workspace-data.mjs";

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

export {
  importPeerSdk,
  isProviderClientError,
  isTransientProviderError,
  KNOWN_PROVIDERS,
  normalizeProvider,
  ProviderClientError,
} from "./provider-client.mjs";

export {
  createProviderClient,
  providerUsesOllamaRouting,
  shouldRouteOllamaModel,
} from "./providers/factory.mjs";

export {
  COPILOT_SUPERVISOR_OVERLAY,
  createCompletionGuard,
  createDelegationTracker,
  registerDelegateCopilotTool,
} from "./providers/copilot-worker.mjs";

export {
  IMPLEMENTATION_GOAL,
  MUTATING_TOOL_NAMES,
  claimsQaOnly,
  createHollowCompletionGuard,
  guardHollowCompletion,
  hasMutatingToolUse,
  withHollowCompletionGuard,
} from "./hollow-completion-guard.mjs";

export { createOpenAIServer } from "./openai-server.mjs";

export { changedFilesFromSteps, SessionStore } from "./session-store.mjs";

export { DEFAULT_TOOL_ALIASES, ToolRegistry } from "./tool-registry.mjs";

export { registerBuiltinTools, registerRuleTool } from "./tools/builtin.mjs";

export {
  DEFAULT_HALO_SCAN_PROFILE,
  HALO_SCAN_CONTEXT_GUIDANCE,
  HALO_SCAN_PACKAGE,
  HALO_SCAN_PROMPT_OVERLAY,
  HALO_SCAN_STREAK_HINT,
  HALO_SCAN_SUPERSEDES,
  importHaloScan,
  registerHaloScanTools,
  wrapHaloScanTool,
} from "./tools/halo-scan.mjs";

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
 * @param {number} [options.maxPromptTokens] Cumulative prompt-token budget per
 *   run (0 = none). Exceeding it ends the run with a plain-text wrap-up and
 *   `stopReason: "token-budget"`.
 * @param {boolean|number} [options.streakNudge] After N consecutive calls to
 *   one read-only tool, steer the model to answer or switch tools. `true`
 *   uses {@link DEFAULT_STREAK_NUDGE_AFTER}; a number sets N; off by default.
 *   With Halo Scan embedded the nudge names its one-call tools.
 * @param {object|false} [options.compaction] Loop compaction settings; on by default.
 * @param {import("./agent-loop.mjs").AgentHooks} [options.hooks]
 * @param {(step: object) => void} [options.onStep]
 * @param {(delta: string) => void} [options.onDelta] Live content tokens from the model.
 * @param {(request: {name: string, args: object}) => Promise<boolean>|boolean} [options.approvalHandler]
 *   Gate write/shell tools. Without one, gated tools run unattended.
 * @param {Array<import("./tool-registry.mjs").ToolDefinition>} [options.tools]
 *   Extra tools registered alongside (or instead of) the builtins.
 * @param {boolean} [options.builtinTools] Set false for a custom-tools-only agent.
 * @param {boolean|{profile?: string, exclude?: string[]}} [options.haloScan]
 *   Embed Halo Scan's structured code tools natively when the optional
 *   `@bitfieldcreek/halo-scan` package (or a sibling checkout) is available
 *   (default true). Pass `{ profile: "base" | "full" | ... }` to choose the
 *   tool packs; false to keep the builtin file/search tools only.
 * @param {boolean} [options.projectIndex] Build the local project vector index
 *   and register search_project (default false; Halo Scan's structured tools
 *   cover project orientation without an embedding model).
 * @param {string} [options.embeddingModel] Embedding model for the project index.
 * @param {boolean} [options.checkpoints] Snapshot files before writes (default true).
 * @param {string} [options.systemPrompt] Full override; skips the context builder.
 * @param {boolean|string} [options.think] Ollama native thinking mode (default auto).
 * @param {boolean} [options.requireVision] Route to a vision-capable model.
 * @param {{chat: Function}} [options.client] Injectable client (tests, custom backends).
 * @param {string} [options.provider] ollama|openai|anthropic|copilot (default ollama).
 * @param {string} [options.apiKey] API key for openai/anthropic peers.
 * @param {string} [options.supervisorProvider] For provider=copilot.
 * @param {string} [options.supervisorModel] For provider=copilot.
 */
/**
 * Map the `streakNudge` option (boolean or count) onto AgentLoop options,
 * choosing the Halo Scan hint when its tools are the ones to switch to.
 * @param {boolean|number|undefined} streakNudge
 * @param {object|null} haloScanInfo
 */
export function resolveStreakNudgeOptions(streakNudge, haloScanInfo) {
  const after =
    streakNudge === true
      ? DEFAULT_STREAK_NUDGE_AFTER
      : Number.isFinite(streakNudge) && streakNudge > 0
        ? Math.floor(streakNudge)
        : 0;
  if (!after) return {};
  return {
    streakNudgeAfter: after,
    ...(haloScanInfo ? { streakNudgeHint: HALO_SCAN_STREAK_HINT } : {}),
  };
}

export async function createAgent({
  model = "auto",
  baseUrl,
  numCtx,
  workspaceRoot = process.cwd(),
  maxSteps,
  wallClockMs,
  maxPromptTokens,
  streakNudge = false,
  compaction = {},
  hooks,
  onStep,
  onDelta,
  approvalHandler,
  tools,
  builtinTools = true,
  haloScan = true,
  projectIndex = false,
  embeddingModel,
  checkpoints = true,
  /** Challenge "done" on create/implement goals when no mutating tools ran. Default on. */
  completionGuard = true,
  systemPrompt,
  think,
  requireVision = false,
  client,
  provider = "ollama",
  apiKey,
  supervisorProvider,
  supervisorModel,
} = {}) {
  let resolvedModel = model;
  /** @type {import("./providers/factory.mjs").ProviderSetup|null} */
  let providerSetup = null;
  let resolvedClient = client;

  if (!resolvedClient) {
    providerSetup = await createProviderClient({
      provider,
      model,
      baseUrl,
      apiKey,
      numCtx,
      think,
      supervisorProvider,
      supervisorModel,
    });
    resolvedClient = providerSetup.client;
    if (shouldRouteOllamaModel(providerSetup)) {
      const routeModel =
        providerSetup.kind === "nested" ? (supervisorModel ?? "auto") : resolvedModel;
      try {
        const routed = await resolveModelAuto({
          requested: routeModel,
          client: resolvedClient,
          requireVision,
        });
        resolvedModel = routed.model;
        resolvedClient.model = routed.model;
        await configureClientModel(resolvedClient, routed.model);
      } catch (err) {
        if (err instanceof ModelRoutingError) throw err;
        if (routeModel === "auto") {
          throw new ModelRoutingError(
            `Cannot reach Ollama to auto-select a model (${err?.message ?? err}). Start Ollama or pass an explicit model.`,
          );
        }
        assertToolCapable(routeModel);
        if (requireVision) assertVisionCapable(routeModel);
        resolvedModel = routeModel;
      }
    } else if (!model || model === "auto") {
      throw new ModelRoutingError(
        `Provider '${provider}' requires an explicit model (auto-routing is Ollama-only).`,
      );
    } else {
      resolvedModel = model;
      resolvedClient.model = model;
    }
  }

  await ensureAgentDataDir(workspaceRoot);

  const canEmbed = typeof resolvedClient.embed === "function";
  const useIndex = projectIndex && canEmbed;
  const checkpointStore = checkpoints ? new CheckpointStore({ workspaceRoot }) : undefined;
  const registry = new ToolRegistry();
  let haloScanInfo = null;
  if (builtinTools) {
    registerBuiltinTools(registry, {
      workspaceRoot,
      searchClient: canEmbed ? resolvedClient : undefined,
      projectIndex: useIndex,
      embeddingModel,
      checkpoints: checkpointStore,
    });
    if (haloScan) {
      const scanOptions = typeof haloScan === "object" ? haloScan : {};
      try {
        haloScanInfo = await registerHaloScanTools(registry, { workspaceRoot, ...scanOptions });
      } catch {
        // Halo Scan is optional; a broken install must not take the agent down.
        haloScanInfo = null;
      }
    }
  }
  for (const tool of tools ?? []) registry.register(tool);
  if (approvalHandler) registry.setApprovalHandler(approvalHandler);

  /** @type {import("./agent-loop.mjs").AgentHooks} */
  let resolvedHooks = withHollowCompletionGuard(hooks ?? {}, completionGuard !== false);
  let nestedOverlay = "";
  if (providerSetup?.kind === "nested" && typeof providerSetup.applyNested === "function") {
    const nested = providerSetup.applyNested({
      registry,
      hooks: resolvedHooks,
      workspaceRoot,
      onDelta,
      approvalHandler: async (request) => {
        if (typeof registry.approvalHandler === "function") {
          return registry.approvalHandler(request);
        }
        return true;
      },
    });
    resolvedHooks = nested.hooks ?? resolvedHooks;
    nestedOverlay = nested.systemOverlay ?? "";
  }

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
          basePrompt:
            (haloScanInfo ? composeSystemPrompt({ contextGuidance: HALO_SCAN_CONTEXT_GUIDANCE }) : DEFAULT_SYSTEM_PROMPT) +
            nestedOverlay,
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
    ...(maxPromptTokens !== undefined ? { maxPromptTokens } : {}),
    ...resolveStreakNudgeOptions(streakNudge, haloScanInfo),
    onStep,
    onDelta,
    compaction,
    hooks: resolvedHooks,
  });
  return {
    loop,
    registry,
    client: resolvedClient,
    provider: providerSetup?.provider ?? provider,
    checkpoints: checkpointStore,
    /** Embedded Halo Scan summary (`names`, `replaced`, `profile`), or null when not embedded. */
    haloScan: haloScanInfo,
    /** @type {(goal: string, options?: {history?: Array<object>, signal?: AbortSignal, images?: string[]}) => Promise<import("./agent-loop.mjs").AgentRunResult>} */
    run: (goal, options) => loop.run(goal, options),
    steer: (text) => loop.steer(text),
    queue: (text) => loop.queue(text),
  };
}
