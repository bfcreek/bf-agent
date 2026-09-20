/**
 * Agent loop. Modeled on Cursor's harness: instructions + tools + model, and
 * a thin orchestrator around them.
 *
 *   messages = [system, user]
 *   repeat:
 *     response = model(messages, tools)
 *     if no tool calls -> the turn is over (a stop hook may ask for more)
 *     execute the tool calls, append results
 *     deliver any steering message the user sent meanwhile
 *
 * Verification, planning, and "keep going until X" are the model's job and
 * the caller's hooks — not loop internals. The loop only owns transport
 * robustness (retries, tool-call parse recovery), context compaction, the
 * step / wall-clock safety caps, and the steer / queue channels.
 */

import { compactMessages, DEFAULT_CONTEXT_FRACTION } from "./compaction.mjs";

/**
 * Core instructions. Short on purpose: task knowledge belongs in rules files
 * (`AGENTS.md`, `.cursor/rules`) and in what the model discovers with tools,
 * not in the system prompt. Model-family quirks are appended separately by
 * `modelPromptOverlay`.
 */
export const DEFAULT_SYSTEM_PROMPT = [
  "You are a coding agent working in the user's workspace. You complete tasks by",
  "calling tools, reading their results, and continuing until the task is done.",
  "",
  "How to work:",
  "- Gather context yourself. Use grep_search and find_files to locate code,",
  "  read_file to read it, list_dir to orient. Do not guess at file contents",
  "  or APIs when a tool can show you.",
  "- Read a file before editing it. Prefer edit_file for changes to existing",
  "  files; use write_file for new files or full rewrites.",
  "- Verify your work: run the project's tests, build, or the command the user",
  "  named, and read the output. Fix what fails.",
  "- If a tool call fails, read the error and change your approach instead of",
  "  repeating the same call.",
  "- Keep going until the task is complete, then reply to the user in plain",
  "  text with no tool calls. If you cannot finish, say what was done and what",
  "  remains.",
  "",
  "Communication:",
  "- Answer the user's actual question first, then give supporting detail.",
  "- Write for a reader who did not see your tool calls; the final message must",
  "  stand alone. Mention only files you actually created or changed.",
  "- When citing code, name the file path and quote only the relevant lines.",
  "",
  "Scope and safety:",
  "- Change only what the task requires. Match existing style and conventions.",
  "  Do not add docs, refactors, or extra files unless asked.",
  "- Only run git commit or git push when the user asked for it. Never rewrite",
  "  published history, skip hooks, or change git config unless asked.",
  "- Deleting files is destructive: delete only files the user explicitly named.",
  "  If a task implies deleting something unnamed, stop and ask.",
  "- Refuse requests whose intent is malware, exploits, or other harm.",
].join("\n");

/** Safety cap on model round-trips per turn. Cursor has no cap; ours is generous. */
export const DEFAULT_MAX_STEPS = 100;

/** How many times a `stop` hook may re-enter the loop for one turn. */
export const DEFAULT_MAX_STOP_HOOK_LOOPS = 5;

/** Empty assistant turns (no text, no tool calls) re-asked before giving up. */
const MAX_EMPTY_RETRIES = 2;
export const EMPTY_RETRY_PROMPT =
  "Your last message was empty. Reply to the user in plain text, or call a tool.";

/**
 * Wall-clock budget policy (only when `wallClockMs` is set): stop the loop a
 * little before the deadline so the wrap-up and session save happen instead
 * of an external kill mid-turn.
 */
export const WALL_CLOCK_RESERVE_RATIO = 0.05;
export const WALL_CLOCK_RESERVE_MIN_MS = 15_000;
export const WALL_CLOCK_RESERVE_MAX_MS = 60_000;
export const WRAP_UP_TURN_MARGIN = 1.2;

/** Sent when the step or time budget runs out, so the run still ends with an answer. */
const WRAP_UP_PROMPT = [
  "The budget for this task is exhausted. Do not call any more tools.",
  "Reply to the user in plain text: what you did, what you found, and what",
  "remains if the task is not finished.",
].join(" ");

/**
 * How many times to recover when Ollama rejects a malformed tool call
 * (`error parsing tool call`). Some models leak prose into the tool-call
 * channel; a short correction and retry usually clears it.
 */
const MAX_TOOL_CALL_PARSE_RECOVERIES = 2;
const TOOL_CALL_PARSE_NUDGE = [
  "Your previous response could not be parsed as a tool call.",
  "Call tools using native tool calling only: a function name plus a JSON",
  "arguments object matching the schema, with no prose in the call.",
  "Retry now.",
].join(" ");

/**
 * @typedef {object} AgentStep
 * @property {number} index 1-based model round-trip number within the turn.
 * @property {"tool-calls"|"final"|"steer"|"tool-parse-error"|"failed"} kind
 * @property {string} content Assistant (or injected user) text for this step.
 * @property {Array<{name: string, args: object, ok: boolean, result?: unknown, error?: string, durationMs?: number}>} toolCalls
 * @property {number} [durationMs] Wall time of the model call that produced this step.
 * @property {number} [promptTokens] Prompt tokens reported by the model for this call.
 * @property {number} [completionTokens] Completion tokens reported by the model for this call.
 */

/**
 * @typedef {object} AgentRunResult
 * @property {string} text Final assistant answer ("" if the loop was cut off).
 * @property {"completed"|"max-steps"|"aborted"|"failed"} stopReason
 * @property {AgentStep[]} steps
 * @property {Array<object>} messages Full transcript, replayable into another run.
 * @property {number} elapsedMs
 * @property {number} compactions How many times the transcript was compacted.
 * @property {boolean} [wallClockExhausted]
 * @property {string} [error] Why a "failed" run stopped.
 */

/**
 * @typedef {object} AgentHooks
 * @property {(info: {name: string, args: object, step: number, goal: string}) => Promise<void|{block?: string}>|void|{block?: string}} [beforeToolCall]
 *   Runs before each tool executes. Return `{ block: reason }` to refuse the
 *   call; the reason goes back to the model as the tool result.
 * @property {(info: {name: string, args: object, outcome: object, step: number, goal: string}) => Promise<void|{note?: string}>|void|{note?: string}} [afterToolCall]
 *   Runs after each tool executes. Return `{ note }` to append text to the
 *   tool result the model sees.
 * @property {(info: {goal: string, text: string, steps: AgentStep[], messages: Array<object>, loopCount: number}) => Promise<void|{followupMessage?: string}>|void|{followupMessage?: string}} [stop]
 *   Runs when the model ends its turn. Return `{ followupMessage }` to send
 *   another user message and keep the turn going (bounded by
 *   `maxStopHookLoops`) — the Cursor `stop` hook pattern.
 */

export class AgentLoop {
  /**
   * @param {object} options
   * @param {{chat: Function, chatStream?: Function}} options.client Ollama client
   *   (or any object with a compatible `chat({messages, tools, signal})`).
   * @param {import("./tool-registry.mjs").ToolRegistry} options.registry
   * @param {string} [options.systemPrompt]
   * @param {number} [options.maxSteps] Safety cap on model round-trips per turn.
   * @param {(step: AgentStep) => void} [options.onStep] Observer for tracing.
   * @param {(delta: string) => void} [options.onDelta] Live content tokens.
   * @param {{maxChars?: number, maxTokens?: number, keepRecent?: number, historyPath?: string}|false} [options.compaction]
   *   Summarize old turns when the transcript exceeds the budget. Off by
   *   default. `historyPath` is a workspace-relative file holding the full
   *   transcript (a session file); the summary points the model at it so
   *   details the summary dropped can be recovered with tools.
   * @param {AgentHooks} [options.hooks]
   * @param {number} [options.maxStopHookLoops]
   * @param {number} [options.wallClockMs] Wall-clock budget for one run (0 = none).
   * @param {() => number} [options.now] Clock for the wall-clock budget (tests).
   */
  constructor({
    client,
    registry,
    systemPrompt,
    maxSteps = DEFAULT_MAX_STEPS,
    onStep,
    onDelta,
    compaction = false,
    hooks = {},
    maxStopHookLoops = DEFAULT_MAX_STOP_HOOK_LOOPS,
    wallClockMs = 0,
    now = Date.now,
  } = {}) {
    if (!client?.chat) throw new Error("AgentLoop requires a client with chat().");
    if (!registry) throw new Error("AgentLoop requires a tool registry.");
    this.client = client;
    this.registry = registry;
    this.systemPrompt = systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxSteps = maxSteps;
    this.onStep = onStep;
    this.onDelta = onDelta;
    this.compaction = compaction;
    this.hooks = hooks ?? {};
    this.maxStopHookLoops = maxStopHookLoops;
    this.wallClockMs = Number.isFinite(wallClockMs) && wallClockMs > 0 ? wallClockMs : 0;
    this.now = typeof now === "function" ? now : Date.now;
    /** @type {string[]} Messages delivered at the next tool boundary. */
    this._steering = [];
    /** @type {string[]} Messages run as new turns after the current one ends. */
    this._queue = [];
  }

  /**
   * Steer the running turn: the text is appended as a user message right
   * after the next batch of tool results, so in-flight work is not cut off.
   * @param {string} text
   */
  steer(text) {
    const t = String(text ?? "").trim();
    if (t) this._steering.push(t);
    return this;
  }

  /**
   * Queue a follow-up: it runs as a new user turn after the current turn
   * finishes, inside the same `run()` call, with full conversation context.
   * @param {string} text
   */
  queue(text) {
    const t = String(text ?? "").trim();
    if (t) this._queue.push(t);
    return this;
  }

  /**
   * Run one goal to completion (plus any queued follow-ups).
   *
   * @param {string} goal User task.
   * @param {object} [options]
   * @param {Array<object>} [options.history] Prior transcript (from a previous
   *   run's `messages`) to continue a session. Must already include a system
   *   message if it is non-empty.
   * @param {string[]} [options.images] Ollama-format base64 images for the
   *   new user turn.
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<AgentRunResult>}
   */
  async run(goal, { history, signal, images } = {}) {
    const wallStarted = this.now();
    const deadlineAt = this.wallClockMs > 0 ? wallStarted + this.wallClockMs : null;
    const deadlineReserveMs =
      deadlineAt === null
        ? 0
        : Math.min(
            WALL_CLOCK_RESERVE_MAX_MS,
            Math.max(WALL_CLOCK_RESERVE_MIN_MS, this.wallClockMs * WALL_CLOCK_RESERVE_RATIO),
          );
    const turnDurations = [];
    const meanTurnMs = () =>
      turnDurations.length ? turnDurations.reduce((a, b) => a + b, 0) / turnDurations.length : 0;
    const timedTurn = async (fn) => {
      const t0 = this.now();
      try {
        return await fn();
      } finally {
        turnDurations.push(Math.max(0, this.now() - t0));
      }
    };
    const remainingMs = () => (deadlineAt === null ? Infinity : deadlineAt - this.now());
    const outOfTime = () =>
      deadlineAt !== null && remainingMs() <= Math.max(deadlineReserveMs, meanTurnMs());
    const elapsed = () => this.now() - wallStarted;

    // Tools get the user's own words for safety decisions (the shell tool
    // only deletes files the goal names) and the deadline so command
    // timeouts cannot outlive the run.
    this.registry.setRunContext?.({ goal, deadlineAt });

    let messages =
      history && history.length > 0
        ? [...history]
        : [{ role: "system", content: this.systemPrompt }];
    const userMessage = { role: "user", content: goal };
    if (Array.isArray(images) && images.length > 0) userMessage.images = images;
    messages.push(userMessage);

    const tools = this.registry.schemas();
    /** @type {AgentStep[]} */
    const steps = [];
    const record = (step) => {
      steps.push(step);
      this.onStep?.(step);
      return step;
    };
    const finish = (result) => ({ ...result, steps, messages, elapsedMs: elapsed(), compactions });

    let observedTokens = 0;
    let stepIndex = 0;
    let stopHookLoops = 0;
    let emptyRetries = 0;
    let compactions = 0;
    let currentGoal = goal;
    let wallClockExhausted = false;

    while (true) {
      if (signal?.aborted) return finish({ text: "", stopReason: "aborted" });
      if (stepIndex >= this.maxSteps) break;
      if (outOfTime()) {
        wallClockExhausted = true;
        break;
      }

      if (this.compaction) {
        const { historyPath, ...compactionOptions } = this.compaction;
        const compacted = await compactMessages({
          client: this.client,
          messages,
          maxTokens: defaultTokenBudget(this.client),
          historyPath,
          ...compactionOptions,
          observedTokens,
        });
        if (compacted !== messages) {
          observedTokens = 0;
          compactions += 1;
        }
        messages = compacted;
      }

      const index = stepIndex + 1;
      let chatResult;
      try {
        chatResult = await timedTurn(() =>
          chatWithParseRecovery(
            this.client,
            { messages, tools, signal, onDelta: this.onDelta },
            {
              onParseError: ({ recovery, error }) =>
                record({
                  index,
                  kind: "tool-parse-error",
                  content: String(error?.message ?? "error parsing tool call"),
                  toolCalls: [],
                  recoveries: recovery,
                }),
            },
          ),
        );
      } catch (err) {
        if (signal?.aborted || err?.name === "AbortError") throw err;
        // Startup failures (no work done yet) propagate so callers can map
        // them to exit codes. Mid-run failures end as a failed run with the
        // steps preserved for the session log.
        if (err?.name !== "OllamaClientError" || !steps.some((s) => s.kind === "tool-calls")) {
          throw err;
        }
        const error = `model call failed: ${String(err.message ?? err).slice(0, 300)}`;
        record({ index, kind: "failed", content: error, toolCalls: [] });
        return finish({ text: "", stopReason: "failed", error });
      }

      const { message, raw } = chatResult;
      const usedTokens = (raw?.prompt_eval_count ?? 0) + (raw?.eval_count ?? 0);
      if (usedTokens > 0) observedTokens = usedTokens;
      // Per-step telemetry for efficiency analysis: how long the model took
      // and how much context it was carrying.
      const turnMeta = {
        durationMs: Math.round(turnDurations.at(-1) ?? 0),
        ...(typeof raw?.prompt_eval_count === "number" ? { promptTokens: raw.prompt_eval_count } : {}),
        ...(typeof raw?.eval_count === "number" ? { completionTokens: raw.eval_count } : {}),
      };
      messages.push(normalizeAssistantMessage(message));
      stepIndex += 1;

      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

      if (toolCalls.length === 0) {
        const text = textOf(message.content).trim();
        if (!text) {
          emptyRetries += 1;
          if (emptyRetries <= MAX_EMPTY_RETRIES) {
            messages.push({ role: "user", content: EMPTY_RETRY_PROMPT });
            continue;
          }
        }
        emptyRetries = 0;

        // The model ended its turn. A stop hook may keep it going.
        if (this.hooks.stop && stopHookLoops < this.maxStopHookLoops) {
          const decision = await this.hooks.stop({
            goal: currentGoal,
            text,
            steps,
            messages,
            loopCount: stopHookLoops,
          });
          const followup = String(decision?.followupMessage ?? "").trim();
          if (followup) {
            stopHookLoops += 1;
            record({ index, kind: "final", content: text, toolCalls: [], continued: true, ...turnMeta });
            messages.push({ role: "user", content: followup });
            continue;
          }
        }

        record({ index, kind: "final", content: text, toolCalls: [], ...turnMeta });

        // Queued follow-ups run as fresh turns with full context.
        if (this._queue.length > 0) {
          currentGoal = this._queue.shift();
          this.registry.setRunContext?.({ goal: currentGoal, deadlineAt });
          messages.push({ role: "user", content: currentGoal });
          stepIndex = 0;
          stopHookLoops = 0;
          continue;
        }

        return finish({ text, stopReason: "completed" });
      }

      const executed = [];
      for (const call of toolCalls) {
        const name = call?.function?.name ?? "";
        const args = call?.function?.arguments ?? {};
        let outcome;
        const before = this.hooks.beforeToolCall
          ? await this.hooks.beforeToolCall({ name, args, step: index, goal: currentGoal })
          : null;
        const toolStarted = this.now();
        if (before?.block) {
          outcome = { ok: false, error: String(before.block) };
        } else {
          outcome = await this.registry.execute(name, args);
          const after = this.hooks.afterToolCall
            ? await this.hooks.afterToolCall({ name, args, outcome, step: index, goal: currentGoal })
            : null;
          if (after?.note) outcome = { ...outcome, note: String(after.note) };
        }
        executed.push({ name, args, ...outcome, durationMs: Math.max(0, Math.round(this.now() - toolStarted)) });
        messages.push({ role: "tool", tool_name: name, content: toolResultContent(outcome) });
      }
      record({ index, kind: "tool-calls", content: textOf(message.content), toolCalls: executed, ...turnMeta });

      // Steering lands at the tool boundary, after results, so in-flight
      // work is preserved and the model sees the results and the redirect
      // together.
      while (this._steering.length > 0) {
        const text = this._steering.shift();
        messages.push({ role: "user", content: text });
        record({ index, kind: "steer", content: text, toolCalls: [] });
      }
    }

    // Out of steps or time: ask for a plain-text wrap-up (no tools offered)
    // when a turn still fits; otherwise return what we have.
    let text = "";
    const wrapUpFits = deadlineAt === null || remainingMs() > meanTurnMs() * WRAP_UP_TURN_MARGIN;
    if (!signal?.aborted && wrapUpFits) {
      try {
        const wrapUp = [...messages, { role: "user", content: WRAP_UP_PROMPT }];
        const wrapStarted = this.now();
        const { message } = await chatWithRetry(this.client, { messages: wrapUp, signal });
        text = textOf(message.content).trim();
        if (text) {
          messages.push({ role: "user", content: WRAP_UP_PROMPT });
          messages.push({ role: "assistant", content: text });
          record({
            index: stepIndex + 1,
            kind: "final",
            content: text,
            toolCalls: [],
            wrapUp: true,
            durationMs: Math.max(0, Math.round(this.now() - wrapStarted)),
          });
        }
      } catch {
        // keep text = ""
      }
    }
    return finish({
      text,
      stopReason: "max-steps",
      ...(wallClockExhausted ? { wallClockExhausted: true } : {}),
    });
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
 * Retry transient client failures (network unreachable, 5xx) with backoff.
 * Tool-call parse failures are not transient — {@link chatWithParseRecovery}
 * handles those with a model correction. 4xx is not retried.
 */
const TRANSIENT_RETRY_DELAYS_MS = [500, 1500, 4000, 8000];

async function chatWithRetry(client, request) {
  // Prefer streaming when the client supports it so onDelta receives live
  // tokens; stubs without chatStream keep using chat().
  const invoke =
    typeof client.chatStream === "function"
      ? (req) => client.chatStream(req)
      : (req) => client.chat(req);
  let lastErr;
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await invoke(request);
    } catch (err) {
      lastErr = err;
      if (err?.name === "AbortError" || request.signal?.aborted) throw err;
      if (err?.name !== "OllamaClientError") throw err;
      if (typeof err.status === "number" && err.status < 500) throw err;
      if (isToolCallParseError(err)) throw err;
      if (attempt >= TRANSIENT_RETRY_DELAYS_MS.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAYS_MS[attempt]));
      if (request.signal?.aborted) throw err;
    }
  }
  throw lastErr;
}

/**
 * When Ollama rejects a malformed tool call, correct the model and retry
 * instead of aborting the run. `request.messages` is mutated in place.
 *
 * @param {object} client
 * @param {{messages: Array<object>, tools?: Array<object>, signal?: AbortSignal, onDelta?: Function}} request
 * @param {{ onParseError?: (info: { recovery: number, error: Error }) => void }} [hooks]
 */
async function chatWithParseRecovery(client, request, hooks = {}) {
  const { messages, tools, signal, onDelta } = request;
  let recoveries = 0;
  while (true) {
    try {
      return await chatWithRetry(client, { messages, tools, signal, onDelta });
    } catch (err) {
      if (signal?.aborted || err?.name === "AbortError") throw err;
      if (!isToolCallParseError(err) || recoveries >= MAX_TOOL_CALL_PARSE_RECOVERIES) throw err;
      recoveries += 1;
      hooks.onParseError?.({ recovery: recoveries, error: err });
      messages.push({ role: "user", content: TOOL_CALL_PARSE_NUDGE });
    }
  }
}

/** Keep only the fields Ollama understands when the assistant message is echoed back. */
function normalizeAssistantMessage(message) {
  const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  const normalized = { role: "assistant", content: hasTools ? "" : textOf(message.content) };
  if (hasTools) normalized.tool_calls = message.tool_calls;
  if (message.thinking) normalized.thinking = message.thinking;
  return normalized;
}

function textOf(content) {
  return typeof content === "string" ? content : "";
}

/**
 * Tool results go back to the model as text. Command results get a readable
 * status header so a failure cannot be mistaken for success just because the
 * tool call itself returned; everything else is passed through (JSON for
 * structured data).
 */
export function toolResultContent(outcome) {
  if (!outcome.ok) return `ERROR: ${outcome.error}`;
  const { result, note } = outcome;
  let body;
  if (result === undefined || result === null) body = "(no output)";
  else if (typeof result === "string") body = result;
  else if (typeof result === "object" && (result.exitCode !== undefined || result.status !== undefined)) {
    body = formatCommandResult(result);
  } else body = JSON.stringify(result);
  return note ? `${body}\n[note: ${note}]` : body;
}

function formatCommandResult(result) {
  const code = result.exitCode;
  const failed = (code != null && Number(code) !== 0) || result.timedOut === true;
  const lines = [
    `status: ${result.status ?? (failed ? `FAILED with exit code ${code}` : "success")}`,
    `exitCode: ${code ?? ""}`,
  ];
  if (result.timedOut) lines.push("timedOut: true");
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  lines.push(`stdout:\n${stdout.length ? stdout : "(empty)"}`);
  if (stderr.length || failed) lines.push(`stderr:\n${stderr.length ? stderr : "(empty)"}`);
  if (result.note) lines.push(`note: ${result.note}`);
  return lines.join("\n");
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
