/**
 * Compaction: when the transcript grows past its budget, summarize the older
 * turns with a model call and splice the summary in, keeping the system
 * message and the most recent turns verbatim.
 *
 * Follows Cursor's summarization shape: the summary keeps the user's original
 * request verbatim and, when the caller provides a history file (a session
 * transcript on disk), points the model at it so details the summary dropped
 * can be recovered with read_file / grep_search instead of being lost.
 * Best-effort — if the summarization call fails, the transcript is untouched.
 */

import { minimalThinkSetting } from "./model-tuning.mjs";

export const DEFAULT_MAX_CHARS = 24_000;
export const DEFAULT_KEEP_RECENT = 6;
/** Compact when the transcript is estimated past this share of the context window. */
export const DEFAULT_CONTEXT_FRACTION = 0.75;
/**
 * Output cap for the summarizer call. Without it a thinking model can spend
 * the whole remaining context window reasoning about the summary, return an
 * empty content string, and leave the transcript uncompacted — silently, and
 * at full model-call cost, on every subsequent step.
 */
export const SUMMARY_MAX_TOKENS = 1_500;

const SUMMARIZER_PROMPT = [
  "You compress an agent's conversation history into a brief it can use to",
  "continue the task. Keep the user's request unchanged — never invent a new",
  "goal. Record as facts: files read, written, or edited (with paths and a",
  "short sketch of current contents), commands run with their exit codes and",
  "the important part of their output, decisions made, and what remains to be",
  "done. Reduce dead ends to one line each. Reply with only the summary.",
].join(" ");

/**
 * Tokenizer density, measured on gpt-oss and qwen3 tokenizers: code and
 * logs — which is what tool results are — run ~3 chars/token; prose ~5.
 * Text (prompts, user turns, answers) uses a 4 blend. See context-spec.mjs.
 */
export const CHARS_PER_TOKEN_CODE = 3;
export const CHARS_PER_TOKEN_TEXT = 4;

/** Rough size proxy — characters, since we have no tokenizer. */
export function transcriptSize(messages) {
  let size = 0;
  for (const m of messages) {
    size += messageChars(m);
  }
  return size;
}

function messageChars(m) {
  let size = 0;
  if (typeof m.content === "string") size += m.content.length;
  if (m.tool_calls) size += JSON.stringify(m.tool_calls).length;
  return size;
}

/**
 * Estimate the transcript's token count: the best of what Ollama actually
 * reported for the last round-trip (observedTokens) and a chars-per-token
 * heuristic that also covers content appended since. Tool results are
 * counted at code density — a chars/4 estimate undercounts a spilled build
 * log by a quarter, which is the output reserve eaten before compaction fires.
 *
 * @param {Array<object>} messages
 * @param {number} [observedTokens] `prompt_eval_count + eval_count` from the
 *   most recent Ollama response, when known.
 * @returns {number}
 */
export function estimateTokens(messages, observedTokens = 0) {
  let tokens = 0;
  for (const m of messages) {
    tokens += messageChars(m) / (m.role === "tool" ? CHARS_PER_TOKEN_CODE : CHARS_PER_TOKEN_TEXT);
  }
  return Math.max(observedTokens, Math.ceil(tokens));
}

/**
 * @param {object} options
 * @param {{chat: Function}} options.client
 * @param {Array<object>} options.messages Transcript starting with a system message.
 * @param {number} [options.maxChars] Character budget that triggers compaction
 *   when no token budget is set.
 * @param {number} [options.maxTokens] Token budget that triggers compaction;
 *   when set it replaces the character trigger (see estimateTokens).
 * @param {number} [options.observedTokens] Actual token usage reported by the
 *   model for the last round-trip; sharpens the token estimate.
 * @param {number} [options.keepRecent] Recent messages kept verbatim.
 * @param {string} [options.historyPath] Workspace-relative path of a file
 *   holding the full transcript; referenced in the summary so the model can
 *   look up dropped details.
 * @param {(info: {reason: string, error?: Error}) => void} [options.onFailure]
 *   Called when compaction was needed but the summarizer produced nothing
 *   usable; the transcript is returned unchanged in that case.
 * @returns {Promise<Array<object>>} The original array when nothing was
 *   compacted, otherwise a new compacted array.
 */
export async function compactMessages({
  client,
  messages,
  maxChars = DEFAULT_MAX_CHARS,
  maxTokens,
  observedTokens = 0,
  keepRecent = DEFAULT_KEEP_RECENT,
  historyPath,
  onFailure,
}) {
  const overBudget = maxTokens
    ? estimateTokens(messages, observedTokens) > maxTokens
    : transcriptSize(messages) > maxChars;
  if (!overBudget) return messages;

  // Never split a tool-call exchange: a role=tool message must keep the
  // assistant message that requested it, so widen the kept window backward.
  let start = Math.max(1, messages.length - keepRecent);
  while (start > 1 && messages[start].role === "tool") start--;

  const middle = messages.slice(1, start);
  if (middle.length === 0) return messages;

  let summary;
  try {
    // A summary needs no reasoning channel; cap output so the call cannot
    // run the context window dry (see SUMMARY_MAX_TOKENS).
    const { message } = await client.chat({
      messages: [
        { role: "system", content: SUMMARIZER_PROMPT },
        { role: "user", content: middle.map(renderMessage).join("\n") },
      ],
      think: minimalThinkSetting(client?.model),
      options: { num_predict: SUMMARY_MAX_TOKENS },
    });
    summary = typeof message.content === "string" ? message.content.trim() : "";
  } catch (error) {
    onFailure?.({ reason: "summarizer-error", error });
    return messages;
  }
  if (!summary) {
    onFailure?.({ reason: "empty-summary" });
    return messages;
  }

  const original = extractOriginalInstruction(messages);
  const parts = ["[Earlier conversation was compacted to save space. Summary:]"];
  if (original) {
    parts.push(`Original user instruction (verbatim — do not invent a new goal):\n${original}\n`);
  }
  parts.push(summary);
  if (historyPath) {
    parts.push(
      `\nThe full earlier transcript is saved at ${historyPath}. If a detail you need is missing from this summary, grep_search or read_file that file instead of guessing.`,
    );
  }

  return [messages[0], { role: "user", content: parts.join("\n") }, ...messages.slice(start)];
}

/**
 * First real user goal in the transcript, skipping compaction recaps.
 * @param {Array<object>} messages
 * @returns {string}
 */
export function extractOriginalInstruction(messages) {
  for (const m of messages ?? []) {
    if (m.role !== "user") continue;
    const text = String(m.content ?? "").trim();
    if (!text) continue;
    if (/^\[Earlier conversation was compacted/i.test(text)) continue;
    return text.slice(0, 8000);
  }
  return "";
}

function renderMessage(m) {
  if (m.role === "assistant" && m.tool_calls) {
    const calls = JSON.stringify(m.tool_calls);
    return `assistant called tools: ${calls}${m.content ? `\nassistant: ${m.content}` : ""}`;
  }
  if (m.role === "tool") return `tool result (${m.tool_name ?? "?"}): ${m.content}`;
  return `${m.role}: ${m.content}`;
}
