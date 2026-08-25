/**
 * Compaction: when the transcript grows past a character budget, summarize
 * the older turns with a model call and splice the summary in, keeping the
 * system message and the most recent turns verbatim. Best-effort — if the
 * summarization call fails, the transcript is left untouched.
 */

import { extractCompilerDiagnostics } from "./prompt-enhancements.mjs";

export const DEFAULT_MAX_CHARS = 24_000;
export const DEFAULT_KEEP_RECENT = 6;
/** Compact when the transcript is estimated past this share of the context window. */
export const DEFAULT_CONTEXT_FRACTION = 0.75;

const SUMMARIZER_PROMPT = [
  "You compress agent conversation history. Summarize the transcript into a",
  "compact brief the model can use to continue the task: the user's goal,",
  "key facts and file paths discovered, actions taken and their outcomes,",
  "and any unresolved steps. Prioritize task-checklist results — files",
  "created or edited, a short sketch of current file contents, which test",
  "assertions passed or failed, and verification commands with their exit",
  "codes (never drop a passing verify). Do not treat a passing build or",
  "existing command as completion when the user asked for new commands that",
  "are not yet implemented. Reduce incidental failed tool experiments to at",
  "most a one-line note. If a compile error was diagnosed with a known",
  "fix that was not applied, state that fix prominently so the next turn can",
  "apply it instead of exploring. Reply with only the summary.",
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

  const recap = formatVerificationRecap(middle);
  const recapBlock = recap ? `${recap}\n\n` : "";

  return [
    messages[0],
    {
      role: "user",
      content: `[Earlier conversation was compacted to save space. Summary:]\n${recapBlock}${summary}`,
    },
    ...messages.slice(start),
  ];
}

function parseToolCallArgs(call) {
  const raw = call?.function?.arguments ?? call?.arguments ?? call?.args ?? {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" ? raw : {};
}

function parseCommandFields(content) {
  const text = String(content ?? "");
  let code;
  let status;
  let stdout = "";
  let stderr = "";
  try {
    const parsed = JSON.parse(text);
    code = parsed.exitCode ?? parsed.exitCode;
    status = parsed.status;
    stdout = String(parsed.stdout ?? "");
    stderr = String(parsed.stderr ?? "");
  } catch {
    const codeMatch = text.match(/exitCode:\s*(-?\d+)/i);
    if (codeMatch) code = Number(codeMatch[1]);
    const statusMatch = text.match(/^status:\s*(.+)$/im);
    if (statusMatch) status = statusMatch[1].trim();
    const stdoutMatch = text.match(/^stdout:\n([\s\S]*?)(?=\n(?:stderr:|compilerErrors:|exitCode:)|$)/im);
    if (stdoutMatch) stdout = stdoutMatch[1];
    const stderrMatch = text.match(/^stderr:\n([\s\S]*?)(?=\n(?:stdout:|compilerErrors:|exitCode:|note:)|$)/im);
    if (stderrMatch) stderr = stderrMatch[1];
    const compilerMatch = text.match(/^compilerErrors:\n([\s\S]*?)(?=\n(?:stdout:|stderr:|exitCode:|note:)|$)/im);
    if (compilerMatch && !stderr) stderr = compilerMatch[1];
  }
  return { code, status, stdout, stderr };
}

function jsonField(content, key) {
  try {
    const parsed = JSON.parse(String(content ?? ""));
    if (parsed && parsed[key] != null) return String(parsed[key]);
  } catch {
    // not JSON
  }
  return "";
}

/**
 * Deterministic recap of command exit codes, assertion failures, and last
 * known file snapshots so compaction cannot drop a passing verification or
 * leave the model retrying a stale snippet like `return a - b`.
 * @param {Array<object>} messages
 * @returns {string}
 */
export function formatVerificationRecap(messages) {
  const commandLines = [];
  const assertionLines = [];
  const files = new Map();
  let pending = [];

  for (const m of messages ?? []) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      pending = m.tool_calls.map((c) => ({
        name: c.function?.name ?? c.name ?? "",
        args: parseToolCallArgs(c),
      }));
      continue;
    }
    if (m.role !== "tool") continue;
    const content = String(m.content ?? "");
    const call = pending.shift() ?? {};
    const name = m.tool_name ?? call.name ?? "tool";
    const filePath = String(call.args?.path ?? jsonField(content, "path") ?? "");

    if (name === "read_file" && filePath) {
      files.set(filePath, content.replace(/\s+/g, " ").trim().slice(0, 280));
    } else if (name === "edit_file" && filePath) {
      const oldS = String(call.args?.old_string ?? "").replace(/\s+/g, " ").slice(0, 80);
      const newS = String(call.args?.new_string ?? "").replace(/\s+/g, " ").slice(0, 80);
      files.set(filePath, `last edit: ${oldS} → ${newS}`);
    } else if (name === "write_file" && filePath) {
      files.set(filePath, "wrote file");
    }

    const { code, status, stdout, stderr } = parseCommandFields(content);
    if (code == null && !status) continue;
    const ok = Number(code) === 0 || /^success$/i.test(String(status ?? ""));
    commandLines.push(`- ${name}: ${ok ? "success" : "FAILED"} (exit ${code ?? "?"})`);
    if (!ok) {
      const combined = `${stdout ?? ""}\n${stderr ?? ""}`;
      const snippet = String(combined).trim().replace(/\s+/g, " ").slice(0, 240);
      if (snippet) commandLines.push(`  last output: ${snippet}`);
      const compiler = extractCompilerDiagnostics(combined);
      if (compiler) {
        for (const line of compiler.split("\n")) {
          commandLines.push(`  compiler: ${line.slice(0, 200)}`);
        }
      }
      for (const line of String(combined).split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        if (/^assert\b|AssertionError|FAIL:|FAILED\b/.test(t)) {
          assertionLines.push(`- ${t.slice(0, 160)}`);
        }
      }
    }
  }

  const uniqueAssertions = [...new Set(assertionLines)].slice(-8);
  const fileLines = [...files.entries()].map(([p, s]) => `- ${p}: ${s}`);
  const parts = [];
  if (commandLines.length) {
    parts.push(
      "Known verification results (do not re-run a command that already exited 0; still run any named smoke commands that are missing):",
      ...commandLines,
    );
  }
  if (uniqueAssertions.length) {
    parts.push(
      "Known assertion outcomes (do not retry stale patterns that already changed):",
      ...uniqueAssertions,
    );
  }
  if (fileLines.length) {
    parts.push("Last known file state (re-read before editing if unsure):", ...fileLines);
  }
  return parts.join("\n");
}

function renderMessage(m) {
  if (m.role === "assistant" && m.tool_calls) {
    const calls = JSON.stringify(m.tool_calls);
    return `assistant called tools: ${calls}${m.content ? `\nassistant: ${m.content}` : ""}`;
  }
  if (m.role === "tool") return `tool result (${m.tool_name ?? "?"}): ${m.content}`;
  return `${m.role}: ${m.content}`;
}
