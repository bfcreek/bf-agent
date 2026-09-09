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
import { EscalationController, resolveModelWithEscalation } from "./escalation.mjs";
import { formatCanonicalPrinciples } from "./memory-store.mjs";
import { buildProjectContext } from "./project-index.mjs";
import {
  ModelRoutingError,
  resolveModelAuto,
  assertToolCapable,
  assertVisionCapable,
} from "./model-routing.mjs";
import { OllamaClient } from "./ollama-client.mjs";
import { configureClientModel } from "./prompt-enhancements.mjs";
import { ToolRegistry } from "./tool-registry.mjs";
import { registerBuiltinTools } from "./tools/builtin.mjs";

export { AgentLoop, DEFAULT_SYSTEM_PROMPT } from "./agent-loop.mjs";

export {
  acceptanceFailureNudge,
  buildAcceptanceContract,
  buildHeuristicContract,
  CONTRACT_PROGRESS_CRITIQUE,
  CRITIQUE_USER_MESSAGE,
  formatAcceptanceContract,
  isVerifyOutstandingOnly,
  parseAcceptanceBlock,
  verifyAcceptanceContract,
} from "./acceptance.mjs";

export {
  ADJUST_PLAN_MESSAGE,
  createPlanState,
  findLastPlanText,
  formatCheckpoint,
  isPlanPrompt,
  markProgress,
  MAX_REMAINING_REPLANS,
  missingKey,
  parsePlanSteps,
  pathsInStepText,
  REPLAN_REMAINING_MESSAGE,
} from "./plan-state.mjs";

export {
  buildModelLadder,
  computeStruggleScore,
  DEFAULT_ESCALATION_THRESHOLD,
  EscalationController,
  resolveModelWithEscalation,
  suggestWeakestLocalModel,
} from "./escalation.mjs";

export {
  AUTO_CONSOLIDATE_EVERY,
  clearMemory,
  consolidateMemory,
  formatCanonicalPrinciples,
  formatMemoryHints,
  lessonRankScore,
  lessonWinRate,
  loadMemoryStore,
  maybeWriteLesson,
  memoryStats,
  memoryStorePath,
  rankLessons,
  recordLessonOutcomes,
  retrieveMemoryHints,
  seedMemoryFromRules,
  shouldWriteLesson,
} from "./memory-store.mjs";

export {
  describeFitBudget,
  detectVramBytes,
  resetHardwareProbe,
  resolveModelFitBudget,
  VRAM_FIT_FRACTION,
} from "./hardware.mjs";

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
  exportTaskHintSeedRules,
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
 * @param {number} [options.maxSteps]
 * @param {object|false} [options.compaction] Loop compaction settings; on by default.
 * @param {(step: object) => void} [options.onStep]
 * @param {(delta: string) => void} [options.onDelta] Live content tokens from the model.
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
 * @param {boolean} [options.replan] Mid-run replan + follow-up adjust (default true; off when planning is false).
 * @param {boolean} [options.taskHints] Task-type constraint hints (default true).
 * @param {boolean} [options.memory] Episodic memory retrieval (default true when embed available).
 * @param {boolean} [options.memoryReadonly] Read-only memory mode for evals.
 * @param {string} [options.embeddingModel]
 * @param {boolean} [options.acceptance] Acceptance contract gate (default true).
 * @param {boolean} [options.critique] Self-critique after planning (default true).
 * @param {import("./escalation.mjs").EscalationController|false} [options.escalation]
 * @param {boolean} [options.escalationCloud] Allow escalation onto paid cloud
 *   rungs. Off by default so escalation stays within installed local models.
 * @param {boolean} [options.cloudOnly] Restrict the escalation ladder to Ollama cloud models.
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
  onDelta,
  approvalHandler,
  tools,
  builtinTools = true,
  projectIndex = true,
  projectBootstrap = true,
  embeddingModel,
  systemPrompt,
  planning = true,
  replan = true,
  taskHints = true,
  memory = true,
  memoryReadonly = false,
  acceptance = true,
  critique = true,
  escalation = false,
  escalationCloud = false,
  cloudOnly = false,
  think,
  requireVision = false,
  client,
} = {}) {
  let resolvedModel = model;
  let modelLadder = [];
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
      const routed = await resolveModelWithEscalation({
        requested: resolvedModel,
        client: resolvedClient,
        escalationEnabled: escalation !== false && resolvedModel === "auto" && !cloudOnly,
        requireVision,
        cloudOnly,
      });
      resolvedModel = routed.model;
      modelLadder = routed.ladder ?? [];
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
  const canonical = memory && resolvedClient.embed ? await formatCanonicalPrinciples() : "";
  const basePrompt = systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const prompt =
    systemPrompt != null
      ? systemPrompt
      : await buildSystemPrompt({
          basePrompt: canonical ? `${basePrompt}\n\n${canonical}` : basePrompt,
          workspaceRoot,
          projectContext: await buildProjectContext({
            workspaceRoot,
            client: projectIndex ? resolvedClient : undefined,
            embeddingModel,
            index: projectIndex,
          }),
        });
  const escalationController =
    escalation instanceof EscalationController
      ? escalation
      : escalation !== false && modelLadder.length > 1
        ? new EscalationController({
            client: resolvedClient,
            ladder: modelLadder,
            allowCloud: escalationCloud === true || cloudOnly,
          })
        : false;
  const loop = new AgentLoop({
    client: resolvedClient,
    registry,
    systemPrompt: prompt,
    maxSteps,
    onStep,
    onDelta,
    compaction,
    planning,
    replan: planning !== false && replan !== false,
    taskHints,
    memory: memory && Boolean(resolvedClient.embed),
    memoryReadonly,
    embeddingModel,
    acceptance,
    critique,
    escalation: escalationController,
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
