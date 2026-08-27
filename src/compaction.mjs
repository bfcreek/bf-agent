/**
 * Compaction: when the transcript grows past a character budget, summarize
 * the older turns with a model call and splice the summary in, keeping the
 * system message and the most recent turns verbatim. Best-effort — if the
 * summarization call fails, the transcript is left untouched.
 */

import { extractCompilerDiagnostics, isArtifactOnlyGoal, isMlPyTorchGoal, looksVacuousArchiveExtract, missingRequiredVerification } from "./prompt-enhancements.mjs";

export const DEFAULT_MAX_CHARS = 24_000;
export const DEFAULT_KEEP_RECENT = 6;
/** Compact when the transcript is estimated past this share of the context window. */
export const DEFAULT_CONTEXT_FRACTION = 0.75;

/** Cap on assistant thinking/prose before git setup on merge/repo tasks. */
export const MAX_SPECULATIVE_REASONING_CHARS = 1200;

const GIT_SETUP_CMD = /\bgit\s+(init|clone|fetch|checkout|switch|merge|pull|rebase)\b/i;
const GIT_SETUP_GOAL =
  /\b(git\s+(init|clone|merge|fetch|checkout)|merge conflict|two branches|unmerged)\b/i;

const SUMMARIZER_PROMPT = [
  "You compress agent conversation history. Summarize the transcript into a",
  "compact brief the model can use to continue the task. Keep the user's",
  "original instruction unchanged — never invent a new goal. Record actions",
  "already taken as hard facts the model must not deny: files written or",
  "edited, commands that exited 0, and their paths. Prioritize task-checklist",
  "results — files created or edited, a short sketch of current file contents,",
  "which test assertions passed or failed, and verification commands with their",
  "exit codes (never drop a passing verify). Prefer act-on-instruction order:",
  "repo/branches/merge first, then implement/verify. Drop speculative reasoning",
  "about examples or puzzles until git setup is done. Do not treat a passing build,",
  "an existing results.json, or an existing command as completion when values",
  "still need domain checks or the user asked for new work that is not yet",
  "implemented. Reduce incidental failed tool experiments to at most a",
  "one-line note. If a compile error was diagnosed with a known fix that was",
  "not applied, state that fix prominently so the next turn can apply it",
  "instead of exploring. For john/*2john encrypted archives, preserve the workflow:",
  "7z2john.pl → build john if needed → john --wordlist=… — do not replace it with doc grep noise.",
  "Reply with only the summary.",
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
const REPETITIVE_PHRASE_MIN_REPEATS = 5;
const REPETITIVE_PHRASE_MIN_LEN = 12;

/**
 * Detect degenerate loops where the same phrase is repeated many times in
 * assistant thinking/prose and collapse it with a forced-replan note.
 *
 * @param {Array<object>} messages
 * @param {{ minRepeats?: number, minPhraseLen?: number }} [options]
 * @returns {Array<object>}
 */
export function collapseRepetitiveThinking(
  messages,
  { minRepeats = REPETITIVE_PHRASE_MIN_REPEATS, minPhraseLen = REPETITIVE_PHRASE_MIN_LEN } = {},
) {
  const replanNote =
    "\n[repetitive thinking collapsed — stop looping on the same phrase; " +
    "state one concrete next action or pivot (e.g. write a generator script and run_command it)]";
  let changed = false;
  const out = (messages ?? []).map((m) => {
    if (m.role !== "assistant") return m;
    const next = { ...m };
    const text = typeof next.thinking === "string" ? next.thinking : "";
    if (!text || next.tool_calls) return m;
    const collapsed = collapseRepeatedPhrase(text, minRepeats, minPhraseLen);
    if (collapsed !== text) {
      next.thinking = collapsed + replanNote;
      changed = true;
      return next;
    }
    return m;
  });
  return changed ? out : messages;
}

/**
 * @param {string} text
 * @param {number} minRepeats
 * @param {number} minPhraseLen
 * @returns {string}
 */
export function collapseRepeatedPhrase(text, minRepeats, minPhraseLen) {
  const body = String(text ?? "");
  if (body.length < minPhraseLen * minRepeats) return body;

  const sentences = body.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length >= minRepeats) {
    const first = sentences[0];
    if (first.length >= minPhraseLen && sentences.every((s) => s === first)) {
      return `${first} …`;
    }
  }

  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length >= minRepeats) {
    const first = lines[0];
    if (first.length >= minPhraseLen && /\s/.test(first)) {
      const same = lines.filter((l) => l === first);
      if (same.length >= minRepeats) return `${first} …`;
    }
  }

  const maxPhrase = Math.min(120, Math.floor(body.length / minRepeats));
  for (let len = maxPhrase; len >= minPhraseLen; len--) {
    for (let i = 0; i <= body.length - len * minRepeats; i++) {
      const phrase = body.slice(i, i + len);
      if (!phrase.trim() || !/\s/.test(phrase)) continue;
      if (new Set(phrase.replace(/\s/g, "")).size <= 2) continue;
      let count = 1;
      let pos = i + len;
      while (pos + len <= body.length && body.slice(pos, pos + len) === phrase) {
        count++;
        pos += len;
      }
      if (count >= minRepeats) {
        return body.slice(0, i) + phrase.trim() + " …";
      }
    }
  }
  return body;
}

export async function compactMessages({
  client,
  messages,
  maxChars = DEFAULT_MAX_CHARS,
  maxTokens,
  observedTokens = 0,
  keepRecent = DEFAULT_KEEP_RECENT,
}) {
  messages = capSpeculativeReasoning(messages);
  messages = collapseRepetitiveThinking(messages);
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

  const original = extractOriginalInstruction(messages);
  const goalBlock = original
    ? `Original user instruction (verbatim — do not invent a new goal):\n${original}\n\n`
    : "";
  const recap = formatVerificationRecap(middle);
  const recapBlock = recap ? `${recap}\n\n` : "";

  return [
    messages[0],
    {
      role: "user",
      content: `[Earlier conversation was compacted to save space. Summary:]\n${goalBlock}${recapBlock}${summary}`,
    },
    ...messages.slice(start),
  ];
}

/**
 * First real user goal in the transcript, skipping compaction recaps and nudges.
 * @param {Array<object>} messages
 * @returns {string}
 */
export function extractOriginalInstruction(messages) {
  for (const m of messages ?? []) {
    if (m.role !== "user") continue;
    const text = String(m.content ?? "").trim();
    if (!text) continue;
    if (/^\[Earlier conversation was compacted/i.test(text)) continue;
    if (/^Before using any tools, write a short numbered plan/i.test(text)) continue;
    if (
      /^(You replied without calling|Your answer was empty|Do not finish yet|Verification already|That edit_file|This task requires|You have made this exact|You are on your last)/i.test(
        text,
      )
    ) {
      continue;
    }
    const stripped = text.replace(/^## Task focus\n(?:- .+\n)+\n?/i, "").trim();
    return stripped.slice(0, 8000);
  }
  return "";
}

/**
 * True when a git repo/branch/merge command has already been issued.
 * @param {Array<object>} messages
 */
export function gitSetupStarted(messages) {
  for (const m of messages ?? []) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) {
        const args = parseToolCallArgs(c);
        const cmd = String(args.command ?? args.cmd ?? "");
        if (GIT_SETUP_CMD.test(cmd)) return true;
      }
    }
    if (m.role === "tool" && GIT_SETUP_CMD.test(String(m.content ?? ""))) return true;
  }
  return false;
}

export function isGitSetupGoal(text) {
  return GIT_SETUP_GOAL.test(String(text ?? ""));
}

/**
 * Truncate long speculative assistant thinking/prose until git setup exists.
 * No-op (same array reference) when the goal is not git/merge or setup already started.
 *
 * @param {Array<object>} messages
 * @param {{maxChars?: number}} [options]
 * @returns {Array<object>}
 */
export function capSpeculativeReasoning(messages, { maxChars = MAX_SPECULATIVE_REASONING_CHARS } = {}) {
  const original = extractOriginalInstruction(messages);
  if (!isGitSetupGoal(original)) return messages;
  if (gitSetupStarted(messages)) return messages;

  const note =
    "\n[speculative reasoning truncated — complete git/repo/branch/merge setup first, then implement/verify]";
  let changed = false;
  const out = (messages ?? []).map((m) => {
    if (m.role !== "assistant") return m;
    const next = { ...m };
    if (typeof next.thinking === "string" && next.thinking.length > maxChars) {
      next.thinking = next.thinking.slice(0, maxChars) + note;
      changed = true;
    }
    if (!next.tool_calls && typeof next.content === "string" && next.content.length > maxChars) {
      next.content = next.content.slice(0, maxChars) + note;
      changed = true;
    }
    return next;
  });
  return changed ? out : messages;
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
  const commandOutputs = [];
  const assertionLines = [];
  const passwordAttempts = [];
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
    if (name === "run_command") {
      const cmdText = String(call.args?.command ?? call.args?.cmd ?? "");
      const passMatch = cmdText.match(/\b-p(\S+)/);
      if (passMatch) passwordAttempts.push(passMatch[1].slice(0, 24));
    }
    if (code == null && !status) continue;
    const ok = Number(code) === 0 || /^success$/i.test(String(status ?? ""));
    const blocked = /^blocked$/i.test(String(status ?? ""));
    const cmdText = String(call.args?.command ?? call.args?.cmd ?? "");
    const vacuousArchive = ok && looksVacuousArchiveExtract(stdout, cmdText);
    commandLines.push(
      `- ${name}: ${blocked ? "blocked" : vacuousArchive ? "exit 0 but no files extracted" : ok ? "success" : "FAILED"} (exit ${code ?? "?"})`,
    );
    commandOutputs.push({
      name,
      status: blocked ? "blocked" : ok ? "success" : "FAILED",
      code,
      stdout,
      stderr,
    });
    if (!ok && !blocked) {
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
  const failedOutputs = commandOutputs.filter((o) => o.status === "FAILED");
  const parts = [];
  if (failedOutputs.length) {
    parts.push(
      "Recent command failures (tool ok:true still means shell failed — read stderr before retrying):",
      ...failedOutputs.slice(-4).map((o) => {
        const err = String(o.stderr ?? o.stdout ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
        return `- exit ${o.code ?? "?"}: ${err || "(no output captured)"}`;
      }),
    );
  }
  if (commandLines.length) {
    const original = extractOriginalInstruction(messages);
    const wroteArtifact =
      isArtifactOnlyGoal(original) && fileLines.some((line) => /: wrote file/.test(line));
    parts.push(
      wroteArtifact
        ? "Artifact deliverable written — re-read the output file to confirm format; no test runner is required unless named in the instruction:"
        : "Known verification results (do not re-run a command that already exited 0; still run any named smoke commands that are missing):",
      ...commandLines,
    );
  }
  const recentOutputs = commandOutputs.slice(-3);
  if (recentOutputs.length) {
    const MAX_OUT = 2000;
    parts.push("Last command outputs (verbatim; blocked means the command was not executed):");
    for (const out of recentOutputs) {
      parts.push(`- ${out.name} [${out.status} exit ${out.code ?? "n/a"}]`);
      const stdout = String(out.stdout ?? "").slice(0, MAX_OUT);
      const stderr = String(out.stderr ?? "").slice(0, MAX_OUT);
      parts.push(`  stdout:\n${stdout.length ? stdout : "(empty)"}`);
      if (stderr) parts.push(`  stderr:\n${stderr}`);
    }
  }
  if (uniqueAssertions.length) {
    parts.push(
      "Known assertion outcomes (do not retry stale patterns that already changed):",
      ...uniqueAssertions,
    );
  }
  if (passwordAttempts.length) {
    parts.push(
      "Passwords already tried (7z -p…):",
      ...passwordAttempts.slice(-8).map((p) => `- ${p}`),
    );
  }
  if (fileLines.length) {
    parts.push(
      "Last known file state (re-read before editing if unsure). An existing output file is not verification-complete until values pass domain/plausibility checks:",
      ...fileLines,
    );
    const wrotePy = fileLines.some((line) => /\.py:/i.test(line));
    const goal = extractOriginalInstruction(messages);
    if (wrotePy && isMlPyTorchGoal(goal)) {
      parts.push(
        "PyTorch deliverable on disk — read_file it before finishing. Do not ask the user for a signature already implemented in the file; run pytest on /tests if not run yet.",
      );
    }
  }

  let emptySearchStreak = 0;
  let maxEmptySearchStreak = 0;
  for (const m of messages ?? []) {
    if (m.role !== "tool") continue;
    const name = String(m.tool_name ?? "");
    const content = String(m.content ?? "");
    const empty =
      (name === "web_search" || name === "grep_search" || name === "find_files") &&
      (/^0 web result|\bno matches\b|\bno files matching\b|\bempty results\b/i.test(content) ||
        /No web results/i.test(content));
    if (empty) {
      emptySearchStreak += 1;
      maxEmptySearchStreak = Math.max(maxEmptySearchStreak, emptySearchStreak);
    } else if (name === "web_search" || name === "grep_search" || name === "find_files") {
      emptySearchStreak = 0;
    }
  }
  if (maxEmptySearchStreak >= 3) {
    parts.push(
      "Reminder: many consecutive searches returned empty. There is likely no hidden verifier in /app — " +
        "use the local cost_model / metrics / installed packages instead of hunting for more search hits.",
    );
  }

  const unmet = formatUnmetGoalsChecklist(messages);
  if (unmet) parts.push(unmet);

  return parts.join("\n");
}

/**
 * Reconstruct tool outcomes from messages for goal tracking during compaction.
 * @param {Array<object>} messages
 * @returns {Array<object>}
 */
function callsFromCompactionMessages(messages) {
  const calls = [];
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
    const call = pending.shift() ?? {};
    const name = m.tool_name ?? call.name ?? "";
    const content = String(m.content ?? "");
    if (name === "run_command") {
      const { code, status } = parseCommandFields(content);
      calls.push({
        name: "run_command",
        ok: true,
        args: call.args,
        result: { exitCode: code, status },
      });
    } else if (name === "write_file" || name === "edit_file") {
      calls.push({
        name,
        ok: !/^ERROR:/i.test(content),
        args: call.args,
        result: { path: String(call.args?.path ?? jsonField(content, "path") ?? "") },
      });
    }
  }
  return calls;
}

/**
 * Checklist of still-unmet instruction goals for compaction summaries.
 * @param {Array<object>} messages
 * @returns {string}
 */
export function formatUnmetGoalsChecklist(messages) {
  const goal = extractOriginalInstruction(messages);
  if (!goal) return "";
  const missing = missingRequiredVerification(goal, callsFromCompactionMessages(messages));
  if (!missing.length) return "";
  return [
    "Unmet goals checklist (do not forget near step limits):",
    ...missing.slice(0, 8).map((item) => `- ${item}`),
  ].join("\n");
}

function renderMessage(m) {
  if (m.role === "assistant" && m.tool_calls) {
    const calls = JSON.stringify(m.tool_calls);
    return `assistant called tools: ${calls}${m.content ? `\nassistant: ${m.content}` : ""}`;
  }
  if (m.role === "tool") return `tool result (${m.tool_name ?? "?"}): ${m.content}`;
  return `${m.role}: ${m.content}`;
}
