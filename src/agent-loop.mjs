/**
 * Core agent loop: send the conversation to the model, execute any tool
 * calls it makes, feed results back, and repeat until the model answers in
 * plain text or a stop condition trips.
 */

import { compactMessages, DEFAULT_CONTEXT_FRACTION } from "./compaction.mjs";
import { gatherFirstTurnProjectContext } from "./project-index.mjs";
import {
  detectTaskHints,
  finalAnswerNudge,
  formatTaskConstraints,
  isComplexGoal,
  mutationBlockedUntilPretest,
  PLANNING_USER_MESSAGE,
} from "./prompt-enhancements.mjs";

/**
 * Sent as a final user message when the loop runs out of steps, so the run
 * still ends with a useful answer instead of empty text.
 */
const WRAP_UP_PROMPT = [
  "You have used all available tool steps for this task.",
  "Answer the user now in plain text using what you have learned.",
  "If the task is not finished, say clearly what was done and what remains.",
  "Do not call any more tools.",
].join(" ");

/** Consecutive identical tool-call steps allowed before execution is refused. */
const MAX_REPEATED_STEPS = 2;

/**
 * How many times to recover when Ollama rejects a malformed tool call
 * (`error parsing tool call`). gpt-oss and similar models sometimes leak
 * reasoning into the tool-call channel; a nudge + retry usually clears it.
 */
const MAX_TOOL_CALL_PARSE_RECOVERIES = 2;

const TOOL_CALL_PARSE_NUDGE = [
  "Your previous response was rejected: it mixed free-form text into the",
  "tool-call channel (Ollama could not parse the tool call).",
  "Call tools using the native tool-calling format only — function name plus",
  "JSON arguments matching the schema. Put reasoning in thinking, not inside",
  "the tool call. Retry the tool call now.",
].join(" ");

/**
 * Written for small local models, which need procedural guidance, not just
 * permission to use tools: each rule below maps to a known failure mode
 * (guessing instead of reading, re-reading files instead of searching,
 * blind edits, repeating failed calls, never finishing).
 */
export const DEFAULT_SYSTEM_PROMPT = [
  "You are a capable local assistant that completes tasks using tools.",
  "Call tools with valid arguments matching their schemas.",
  "",
  "Rules:",
  "- Ground answers in facts from tools; never guess. For questions about this",
  "  project, use the README and auto-retrieved passages from the first turn,",
  "  then read_file, grep_search, or search_project for more detail.",
  "- For current events, upstream docs, release notes, or anything outside",
  "  this workspace, use web_search, then fetch_url on promising links.",
  "  Pass a query to fetch_url so micro-RAG returns relevant passages instead",
  "  of the whole page.",
  "- To find where something is defined or used, use grep_search or find_files",
  "  instead of reading files one at a time.",
  "- Read a file before editing it. Before your first edit, also read any",
  "  existing tests or callers that define the expected interface (flag names,",
  "  function signatures, output format) so your first attempt matches them.",
  "  Use edit_file for changes to existing files; use write_file only for new",
  "  files or full rewrites. Prefer the smallest exact replacement (one key or",
  "  one line, e.g. '\"debug\": false' -> '\"debug\": true') over rewriting the file.",
  "- After changing files, verify the result: re-read the changed part, or run",
  "  the project's tests or build with run_command when the task calls for it.",
  "  Once the required verification command exits 0 with the expected output,",
  "  stop and give your final answer — do not run more exploratory commands.",
  "- When the task mentions failing tests, your first tool step must be",
  "  run_command with that test command; do not edit until you have seen the",
  "  failure exit code and output. After the last edit, run the tests again.",
  "- Before claiming success, run every command the task names (e.g. node",
  "  test.mjs, python test.py, or `dotnet run`) with run_command.",
  "  Only claim pass/success when the exit code is 0. run_command results",
  "  start with a status field: FAILED or TIMED OUT means the command did not",
  "  succeed even though the tool call returned — read stderr, do not assume",
  "  success.",
  "- Never launch a bare interpreter or shell (node, python, bash, ...) with",
  "  no script or inline code: commands run with no input, so a REPL hangs",
  "  until the timeout. A timed-out command is a failure — change the command",
  "  instead of repeating it, and do not spend your final answer explaining",
  "  shell behavior.",
  "- Files ending in .mjs are ES modules: use import/export, never require or",
  "  module.exports.",
  "- When a .mjs file is both a CLI entry and importable, guard top-level CLI",
  "  code with import.meta.url === pathToFileURL(process.argv[1]).href (or keep",
  "  lib and bin separate) so importing from tests does not call process.exit.",
  "  Prefer tests that spawn the CLI (or assert stdout) over importing a CLI",
  "  module that exits on load.",
  "- When a task says a server listens on a port, the entry module must call",
  "  listen when executed directly (same import.meta.url main check), not only",
  "  export a start helper for tests.",
  "- When renaming or fixing a misspelled identifier, update every declaration,",
  "  export, and reference in one edit_file call (set replace_all when the old",
  "  string is the typo alone). Then verify once.",
  "- When extracting a shared module, write the shared file first, then update",
  "  importers, then run tests. When a sample/fixture file is named, read it",
  "  before writing the implementation.",
  "- In your final answer, mention only files you actually created or edited;",
  "  do not claim you added tests or docs you did not write. If tests were",
  "  already present and left unchanged, say so.",
  "- Deleting files is destructive. Delete a file only when the user",
  "  explicitly named it for deletion, and never delete a file the user asked",
  "  to keep. If the task implies deleting files the user did not name (e.g.",
  "  'clean up'), do not delete anything — finish and ask the user to confirm",
  "  exactly which files may be removed.",
  "- If a tool call fails, read the error and change your approach. Never",
  "  repeat a call that just failed with the same arguments.",
  "- When the user asks for only a path, number, or other single value, reply",
  "  with that value alone unless they asked for more.",
  "- When creating or fixing tests, run them with run_command before finishing",
  "  and report whether they passed in your final answer.",
  "- Keep going until the task is done, then reply to the user in plain text",
  "  with no tool calls. State what you did and what, if anything, remains.",
].join("\n");

/**
 * @typedef {object} AgentStep
 * @property {number} index 1-based model round-trip number.
 * @property {"tool-calls"|"final"|"plan"} kind What the model did this step.
 * @property {string} content Assistant text for this step (may be empty).
 * @property {Array<{name: string, args: object, ok: boolean, result?: unknown, error?: string}>} toolCalls
 */

/**
 * @typedef {object} AgentRunResult
 * @property {string} text Final assistant answer ("" if the loop was cut off).
 * @property {"completed"|"max-steps"|"aborted"} stopReason
 * @property {AgentStep[]} steps
 * @property {Array<object>} messages Full transcript, replayable into another run.
 */

export class AgentLoop {
  /**
   * @param {object} options
   * @param {{chat: Function}} options.client Ollama client (or any object with
   *   a compatible `chat({messages, tools, signal})`).
   * @param {import("./tool-registry.mjs").ToolRegistry} options.registry
   * @param {string} [options.systemPrompt]
   * @param {number} [options.maxSteps] Max model round-trips per run.
   * @param {(step: AgentStep) => void} [options.onStep] Observer for tracing.
   * @param {{maxChars?: number, maxTokens?: number, keepRecent?: number}|false} [options.compaction]
   *   Summarize old turns when the transcript exceeds the budget. Off by
   *   default. When the client exposes `numCtx` (OllamaClient does), the
   *   token budget defaults to a fraction of it and the trigger uses actual
   *   token counts reported by the model.
   * @param {object|false} [options.projectBootstrap]
   *   On the first turn of a conversation, force README + goal-specific RAG into
   *   the user message before the model is called. `{ workspaceRoot, client?,
   *   embeddingModel?, onProgress? }`.
   * @param {(info: {readme: boolean, ragHits: number}) => void} [options.onBootstrap]
   * @param {boolean} [options.planning] Pre-pass plan on complex first turns (default true).
   * @param {boolean} [options.taskHints] Append task-type constraints to the user message (default true).
   * @param {(info: {plan: string, hints: Array<{id: string, constraint: string}>}) => void} [options.onPlan]
   */
  constructor({
    client,
    registry,
    systemPrompt,
    maxSteps = 10,
    onStep,
    compaction = false,
    projectBootstrap = false,
    onBootstrap,
    planning = true,
    taskHints = true,
    onPlan,
  } = {}) {
    if (!client?.chat) throw new Error("AgentLoop requires a client with chat().");
    if (!registry) throw new Error("AgentLoop requires a tool registry.");
    this.client = client;
    this.registry = registry;
    this.systemPrompt = systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxSteps = maxSteps;
    this.onStep = onStep;
    this.compaction = compaction;
    this.projectBootstrap = projectBootstrap;
    this.onBootstrap = onBootstrap;
    this.planning = planning;
    this.taskHints = taskHints;
    this.onPlan = onPlan;
  }

  /**
   * Run one goal to completion.
   *
   * @param {string} goal User task.
   * @param {object} [options]
   * @param {Array<object>} [options.history] Prior transcript (from a previous
   *   run's `messages`) to continue a session. Must already include a system
   *   message if it is non-empty.
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<AgentRunResult>}
   */
  async run(goal, { history, signal } = {}) {
    // Give tools the user's own words for safety decisions (e.g. the shell
    // tool only deletes files the goal explicitly names).
    this.registry.setRunContext?.({ goal });
    let messages =
      history && history.length > 0
        ? [...history]
        : [{ role: "system", content: this.systemPrompt }];
    let userContent = goal;
    const hints = this.taskHints ? detectTaskHints(goal) : [];
    const taskFocus = formatTaskConstraints(hints);
    if (taskFocus) userContent = `${taskFocus}\n\n${userContent}`;

    messages.push({ role: "user", content: userContent });

    if (this.projectBootstrap && isFreshTurn(history)) {
      const bootstrap = await gatherFirstTurnProjectContext({
        workspaceRoot: this.projectBootstrap.workspaceRoot,
        goal,
        client: this.projectBootstrap.client,
        embeddingModel: this.projectBootstrap.embeddingModel,
        signal,
        onProgress: this.projectBootstrap.onProgress,
      });
      userContent = `${userContent}\n\n${bootstrap.text}`;
      this.onBootstrap?.({ readme: bootstrap.readme, ragHits: bootstrap.ragHits });
    }

    messages[messages.length - 1].content = userContent;

    const steps = [];
    const freshTurn = isFreshTurn(history);

    if (this.planning && freshTurn && isComplexGoal(goal) && !signal?.aborted) {
      try {
        const planMessages = [
          ...messages,
          { role: "user", content: PLANNING_USER_MESSAGE },
        ];
        const { message } = await chatWithRetry(this.client, {
          messages: planMessages,
          signal,
        });
        const plan = textOf(message.content).trim();
        if (plan) {
          messages.push({ role: "user", content: PLANNING_USER_MESSAGE });
          messages.push({ role: "assistant", content: plan });
          const planStep = { index: 0, kind: "plan", content: plan, toolCalls: [] };
          steps.push(planStep);
          this.onStep?.(planStep);
          this.onPlan?.({ plan, hints });
        }
      } catch {
        // Planning is best-effort — proceed without it.
      }
    }

    const tools = this.registry.schemas();
    // Actual context usage (prompt + completion tokens) from the last model
    // response — a far better compaction trigger than counting characters.
    let observedTokens = 0;
    // Small models get stuck repeating one tool call verbatim; track
    // consecutive identical steps so we can break the cycle.
    let repeatedKey = "";
    let repeatedCount = 0;
    let toolNudgeCount = 0;

    for (let index = 1; index <= this.maxSteps; index++) {
      if (signal?.aborted) {
        return { text: "", stopReason: "aborted", steps, messages };
      }

      if (this.compaction) {
        const compacted = await compactMessages({
          client: this.client,
          messages,
          maxTokens: defaultTokenBudget(this.client),
          ...this.compaction,
          observedTokens,
        });
        if (compacted !== messages) observedTokens = 0;
        messages = compacted;
      }

      const { message, raw } = await chatWithParseRecovery(this.client, {
        messages,
        tools,
        signal,
      });
      const usedTokens = (raw?.prompt_eval_count ?? 0) + (raw?.eval_count ?? 0);
      if (usedTokens > 0) observedTokens = usedTokens;
      messages.push(normalizeAssistantMessage(message));

      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (toolCalls.length === 0) {
        const answerText = textOf(message.content);
        const nudge = finalAnswerNudge({
          goal,
          answerText,
          steps,
          nudgeCount: toolNudgeCount,
        });
        if (nudge) {
          toolNudgeCount += 1;
          messages.push({ role: "user", content: nudge });
          continue;
        }
        const step = {
          index,
          kind: "final",
          content: answerText,
          toolCalls: [],
        };
        steps.push(step);
        this.onStep?.(step);
        return {
          text: answerText,
          stopReason: "completed",
          steps,
          messages,
        };
      }

      const stepKey = JSON.stringify(
        toolCalls.map((c) => [c?.function?.name, c?.function?.arguments]),
      );
      repeatedCount = stepKey === repeatedKey ? repeatedCount + 1 : 0;
      repeatedKey = stepKey;
      const refuseRepeat = repeatedCount >= MAX_REPEATED_STEPS;

      const executed = [];
      for (const call of toolCalls) {
        const name = call?.function?.name ?? "";
        const args = call?.function?.arguments ?? {};
        const pretestBlock = refuseRepeat
          ? null
          : mutationBlockedUntilPretest({ goal, toolName: name, steps });
        const outcome = refuseRepeat
          ? {
              ok: false,
              error:
                `You have made this exact tool call ${repeatedCount + 1} times in a row; ` +
                "it was not executed again. Do something different: change the arguments, " +
                "use another tool, or give your final answer now.",
            }
          : pretestBlock
            ? { ok: false, error: pretestBlock }
            : await this.registry.execute(name, args);
        executed.push({ name, args, ...outcome });
        messages.push({
          role: "tool",
          tool_name: name,
          content: toolResultContent(outcome),
        });
      }

      const step = {
        index,
        kind: "tool-calls",
        content: textOf(message.content),
        toolCalls: executed,
      };
      steps.push(step);
      this.onStep?.(step);
    }

    // Out of steps: ask for a plain-text wrap-up (no tools offered) so the
    // caller gets a best-effort answer instead of empty text. Best-effort —
    // any failure here must not mask the max-steps outcome.
    let text = "";
    if (!signal?.aborted) {
      try {
        const wrapUp = [...messages, { role: "user", content: WRAP_UP_PROMPT }];
        const { message } = await chatWithRetry(this.client, { messages: wrapUp, signal });
        text = textOf(message.content).trim();
        if (text) {
          messages.push({ role: "user", content: WRAP_UP_PROMPT });
          messages.push({ role: "assistant", content: text });
          const step = { index: this.maxSteps + 1, kind: "final", content: text, toolCalls: [] };
          steps.push(step);
          this.onStep?.(step);
        }
      } catch {
        // keep text = ""
      }
    }
    return { text: text ?? "", stopReason: "max-steps", steps, messages };
  }
}

/** Ollama 500 when the model contaminates the tool-call channel with prose. */
export function isToolCallParseError(err) {
  return (
    err?.name === "OllamaClientError" &&
    typeof err.status === "number" &&
    err.status >= 500 &&
    /error parsing tool call/i.test(String(err.message ?? ""))
  );
}

/**
 * One retry on transient client failures (network unreachable, 5xx). A
 * single mid-task hiccup should not kill a run that already did real work.
 * Tool-call parse failures are not transient — {@link chatWithParseRecovery}
 * handles those with a model nudge.
 */
async function chatWithRetry(client, request) {
  try {
    return await client.chat(request);
  } catch (err) {
    if (err?.name === "AbortError" || request.signal?.aborted) throw err;
    if (err?.name !== "OllamaClientError") throw err;
    if (typeof err.status === "number" && err.status < 500) throw err;
    if (isToolCallParseError(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (request.signal?.aborted) throw err;
    return client.chat(request);
  }
}

/**
 * When Ollama rejects a malformed tool call, nudge the model and retry
 * instead of aborting the whole agent run.
 *
 * @param {object} client
 * @param {object} request
 * @param {Array<object>} request.messages Mutated in place when recovering.
 * @param {Array<object>} [request.tools]
 * @param {AbortSignal} [request.signal]
 */
async function chatWithParseRecovery(client, request) {
  const { messages, tools, signal } = request;
  let recoveries = 0;
  while (true) {
    try {
      return await chatWithRetry(client, { messages, tools, signal });
    } catch (err) {
      if (signal?.aborted || err?.name === "AbortError") throw err;
      if (!isToolCallParseError(err) || recoveries >= MAX_TOOL_CALL_PARSE_RECOVERIES) {
        throw err;
      }
      recoveries += 1;
      messages.push({ role: "user", content: TOOL_CALL_PARSE_NUDGE });
    }
  }
}

/**
 * Keep only the fields Ollama understands when the assistant message is
 * echoed back on the next round-trip.
 */
function normalizeAssistantMessage(message) {
  const normalized = { role: "assistant", content: textOf(message.content) };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    normalized.tool_calls = message.tool_calls;
  }
  return normalized;
}

function textOf(content) {
  return typeof content === "string" ? content : "";
}

/** Tool results go back to the model as a string (JSON for structured data). */
function toolResultContent(outcome) {
  if (!outcome.ok) return `ERROR: ${outcome.error}`;
  const { result } = outcome;
  if (result === undefined || result === null) return "(no output)";
  return typeof result === "string" ? result : JSON.stringify(result);
}

/**
 * Token budget derived from the client's context window, when it exposes one
 * (OllamaClient does). Undefined keeps compaction on the character trigger.
 */
function defaultTokenBudget(client) {
  const numCtx = client?.numCtx;
  if (!Number.isFinite(numCtx) || numCtx <= 0) return undefined;
  return Math.floor(numCtx * DEFAULT_CONTEXT_FRACTION);
}

/** First turn of a conversation — no prior user/assistant/tool messages in history. */
function isFreshTurn(history) {
  if (!history?.length) return true;
  return !history.some((m) => m.role === "user" || m.role === "assistant" || m.role === "tool");
}
