/**
 * Core agent loop: send the conversation to the model, execute any tool
 * calls it makes, feed results back, and repeat until the model answers in
 * plain text or a stop condition trips.
 */

import { compactMessages } from "./compaction.mjs";

export const DEFAULT_SYSTEM_PROMPT = [
  "You are a capable local assistant with access to tools.",
  "Use tools when they help you complete the user's task; call them with",
  "valid arguments matching their schemas. When you have everything you",
  "need, reply to the user in plain text without further tool calls.",
].join(" ");

/**
 * @typedef {object} AgentStep
 * @property {number} index 1-based model round-trip number.
 * @property {"tool-calls"|"final"} kind What the model did this step.
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
   * @param {{maxChars?: number, keepRecent?: number}|false} [options.compaction]
   *   Summarize old turns when the transcript exceeds the budget. Off by default.
   */
  constructor({ client, registry, systemPrompt, maxSteps = 10, onStep, compaction = false } = {}) {
    if (!client?.chat) throw new Error("AgentLoop requires a client with chat().");
    if (!registry) throw new Error("AgentLoop requires a tool registry.");
    this.client = client;
    this.registry = registry;
    this.systemPrompt = systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxSteps = maxSteps;
    this.onStep = onStep;
    this.compaction = compaction;
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
    let messages =
      history && history.length > 0
        ? [...history]
        : [{ role: "system", content: this.systemPrompt }];
    messages.push({ role: "user", content: goal });

    const steps = [];
    const tools = this.registry.schemas();

    for (let index = 1; index <= this.maxSteps; index++) {
      if (signal?.aborted) {
        return { text: "", stopReason: "aborted", steps, messages };
      }

      if (this.compaction) {
        messages = await compactMessages({
          client: this.client,
          messages,
          ...this.compaction,
        });
      }

      const { message } = await this.client.chat({ messages, tools, signal });
      messages.push(normalizeAssistantMessage(message));

      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (toolCalls.length === 0) {
        const step = {
          index,
          kind: "final",
          content: textOf(message.content),
          toolCalls: [],
        };
        steps.push(step);
        this.onStep?.(step);
        return {
          text: step.content,
          stopReason: "completed",
          steps,
          messages,
        };
      }

      const executed = [];
      for (const call of toolCalls) {
        const name = call?.function?.name ?? "";
        const args = call?.function?.arguments ?? {};
        const outcome = await this.registry.execute(name, args);
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

    return { text: "", stopReason: "max-steps", steps, messages };
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
