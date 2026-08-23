/**
 * Compaction: when the transcript grows past a character budget, summarize
 * the older turns with a model call and splice the summary in, keeping the
 * system message and the most recent turns verbatim. Best-effort — if the
 * summarization call fails, the transcript is left untouched.
 */

export const DEFAULT_MAX_CHARS = 24_000;
export const DEFAULT_KEEP_RECENT = 6;

const SUMMARIZER_PROMPT = [
  "You compress agent conversation history. Summarize the transcript into a",
  "compact brief the model can use to continue the task: the user's goal,",
  "key facts and file paths discovered, actions taken and their outcomes,",
  "and any unresolved steps. Reply with only the summary.",
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
 * @param {object} options
 * @param {{chat: Function}} options.client
 * @param {Array<object>} options.messages Transcript starting with a system message.
 * @param {number} [options.maxChars] Budget that triggers compaction.
 * @param {number} [options.keepRecent] Recent messages kept verbatim.
 * @returns {Promise<Array<object>>} The original array when nothing was
 *   compacted, otherwise a new compacted array.
 */
export async function compactMessages({
  client,
  messages,
  maxChars = DEFAULT_MAX_CHARS,
  keepRecent = DEFAULT_KEEP_RECENT,
}) {
  if (transcriptSize(messages) <= maxChars) return messages;

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
