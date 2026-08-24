/**
 * Compaction: when the transcript grows past a character budget, summarize
 * the older turns with a model call and splice the summary in, keeping the
 * system message and the most recent turns verbatim. Best-effort — if the
 * summarization call fails, the transcript is left untouched.
 */

export const DEFAULT_MAX_CHARS = 24_000;
export const DEFAULT_KEEP_RECENT = 6;
/** Compact when the transcript is estimated past this share of the context window. */
export const DEFAULT_CONTEXT_FRACTION = 0.75;

const SUMMARIZER_PROMPT = [
  "You compress agent conversation history. Summarize the transcript into a",
  "compact brief the model can use to continue the task: the user's goal,",
  "key facts and file paths discovered, actions taken and their outcomes,",
  "and any unresolved steps. Prioritize task-checklist results — files",
  "created or edited, assertions made, verification commands with their exit",
  "codes — over incidental failed tool experiments, which should be reduced",
  "to at most a one-line note. Reply with only the summary.",
].join(" ");

/** Rough size proxy — characters, since we have no tokenizer. */
export function transcriptSize(messages) {
  let size = 0;
  for (const m of messages) {
    if (typeof m.content === "string") size += m.content.length;
    if (m.tool_calls) size += JSON.stringify(m.tool_calls).length;
  }
  return size;
}

/**
 * Estimate the transcript's token count: the best of what Ollama actually
 * reported for the last round-trip (observedTokens) and a chars/4 heuristic
 * that also covers content appended since.
 *
 * @param {Array<object>} messages
 * @param {number} [observedTokens] `prompt_eval_count + eval_count` from the
 *   most recent Ollama response, when known.
 * @returns {number}
 */
export function estimateTokens(messages, observedTokens = 0) {
  return Math.max(observedTokens, Math.ceil(transcriptSize(messages) / 4));
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
    const { message } = await client.chat({
      messages: [
        { role: "system", content: SUMMARIZER_PROMPT },
        { role: "user", content: middle.map(renderMessage).join("\n") },
      ],
    });
    summary = typeof message.content === "string" ? message.content.trim() : "";
  } catch {
    return messages;
  }
  if (!summary) return messages;

  return [
    messages[0],
    {
      role: "user",
      content: `[Earlier conversation was compacted to save space. Summary:]\n${summary}`,
    },
    ...messages.slice(start),
  ];
}

function renderMessage(m) {
  if (m.role === "assistant" && m.tool_calls) {
    const calls = JSON.stringify(m.tool_calls);
    return `assistant called tools: ${calls}${m.content ? `\nassistant: ${m.content}` : ""}`;
  }
  if (m.role === "tool") return `tool result (${m.tool_name ?? "?"}): ${m.content}`;
  return `${m.role}: ${m.content}`;
}
