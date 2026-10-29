/**
 * Stop-hook guard against fabricated secrets: the model ends a secret-
 * extraction task (CTF flag, password, key) by stating a value it never
 * actually recovered — it invented one from binary strings or format
 * fragments and wrote it to the answer file.
 *
 * The naive check ("did the value appear in any tool output?") is defeated by
 * the exact failure we see: the model writes its guess to results.txt, then
 * `cat`s it, so the fabricated value *does* appear in a tool result. The
 * distinction that holds is ordering — a real secret shows up in command
 * output or a file read *before* the model ever types it; a fabricated one
 * appears in tool output only after the model authored it (write_file content,
 * an `echo … > file`, etc.). A value the environment produced on its own is
 * supported; a value the model introduced and then read back is not.
 *
 * Same shape as the hollow-completion guard: compose it as a `stop` hook,
 * bounded by AgentLoop.maxStopHookLoops.
 */

/** Tasks whose deliverable is a recovered secret / credential. */
export const SECRET_GOAL =
  /\b(flag|secret|secrets|password|passwords|passphrase|credential|credentials|api[\s_-]?key|private[\s_-]?key|access[\s_-]?key|token|crack|cracked|cracking|decrypt|decrypted|recover|recovered|exfiltrat)\w*/i;

/**
 * CTF-style `WORD{...}` flag tokens (FLAG{...}, CTF{...}, KEY{...}, …). The
 * label is 2–32 word chars and the body is 1–256 chars with no braces or
 * newlines, so a grep regex like `FLAG\{[^}]+\}` in a command string never
 * matches as a literal flag.
 */
const BRACE_FLAG = /\b[A-Za-z][A-Za-z0-9_]{1,31}\{[^{}\n]{1,256}\}/g;

/**
 * A secret value the model labels in its answer, delimited so prose does not
 * read as a secret: `the password is \`8XD…W54\``, `secret: "hunter2"`.
 * Captures the quoted/backticked token (≥4 chars, no whitespace).
 */
const LABELED_SECRET =
  /\b(?:secret|password|passphrase|flag|key|token|credential)s?\b[^\n`"']{0,40}?[`"']([^\s`"'\n]{4,256})[`"']/i;

/**
 * Brace-flag tokens the answer asserts.
 * @param {string} text
 * @returns {string[]}
 */
export function claimedFlags(text) {
  const out = new Set();
  for (const match of String(text ?? "").matchAll(BRACE_FLAG)) out.add(match[0]);
  return [...out];
}

/**
 * A delimited secret value the answer labels, or null.
 * @param {string} text
 * @returns {string|null}
 */
export function claimedLabeledSecret(text) {
  const match = LABELED_SECRET.exec(String(text ?? ""));
  return match ? match[1] : null;
}

/** Text the model authored into a tool call (what it typed itself). */
function authoredTextOf(toolCall) {
  const parts = [];
  const args = toolCall?.args;
  if (args && typeof args === "object") {
    try {
      parts.push(JSON.stringify(args));
    } catch {
      // circular / unserializable args — skip, the command string usually covers it
    }
  }
  return parts.join("\n");
}

/** Text a tool produced (what the environment showed back). */
function resultTextOf(toolCall) {
  const result = toolCall?.result;
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result !== "object") return String(result);
  const parts = [];
  if (typeof result.stdout === "string") parts.push(result.stdout);
  if (typeof result.stderr === "string") parts.push(result.stderr);
  try {
    parts.push(JSON.stringify(result));
  } catch {
    // ignore unserializable structured results
  }
  return parts.join("\n");
}

/**
 * First step index where `value` was observed in tool output vs. first index
 * where the model authored it into a call. A value is supported only when the
 * environment showed it strictly before the model ever typed it.
 *
 * @param {Array<object>} steps
 * @param {string} value
 * @returns {{observed: number, authored: number}}
 */
export function secretEvidence(steps, value) {
  let observed = Infinity;
  let authored = Infinity;
  let index = 0;
  for (const step of steps ?? []) {
    if (step?.kind !== "tool-calls") {
      index += 1;
      continue;
    }
    for (const toolCall of step.toolCalls ?? []) {
      if (authored === Infinity && authoredTextOf(toolCall).includes(value)) authored = index;
      if (observed === Infinity && toolCall?.ok !== false && resultTextOf(toolCall).includes(value)) {
        observed = index;
      }
    }
    index += 1;
  }
  return { observed, authored };
}

/**
 * True when the run never produced `value` on its own before the model typed
 * it — i.e. the model invented it.
 * @param {Array<object>} steps
 * @param {string} value
 * @returns {boolean}
 */
export function isFabricated(steps, value) {
  const { observed, authored } = secretEvidence(steps, value);
  return observed === Infinity || observed >= authored;
}

/**
 * @param {"flag"|"secret"} kind
 * @param {string} value
 * @returns {string}
 */
function fabricationMessage(kind, value) {
  const noun = kind === "flag" ? "the flag" : "that secret";
  return (
    `You reported ${noun} ${JSON.stringify(value)}, but it never appeared in the output of any command you ran ` +
    "or any file you read before you wrote it yourself — so there is no evidence you actually recovered it. " +
    "Do not fabricate or guess a secret from strings, format placeholders, or hints. " +
    "Actually extract it: run the program and read its real output, crack or decrypt the artifact, or search the " +
    "files, and confirm the exact value appears in tool output before you claim it. " +
    "If you cannot recover it, say so plainly instead of inventing one."
  );
}

/**
 * @param {object} ctx
 * @param {string} [ctx.goal]
 * @param {string} [ctx.text]
 * @param {Array<object>} [ctx.steps]
 * @param {number} [ctx.loopCount]
 * @param {{ maxLoops?: number }} [options]
 * @returns {{ followupMessage?: string }}
 */
export function guardSecretFabrication({ goal, text, steps, loopCount } = {}, { maxLoops = 1 } = {}) {
  if ((loopCount ?? 0) >= maxLoops) return {};
  const answer = String(text ?? "");
  if (!answer.trim()) return {};

  // Brace-flags are goal-independent: a CTF-style token the model states but
  // never saw the environment produce is invented.
  for (const flag of claimedFlags(answer)) {
    if (isFabricated(steps, flag)) return { followupMessage: fabricationMessage("flag", flag) };
  }

  // Labeled secrets are checked only when the task is about recovering one, to
  // keep ordinary coding answers from tripping the guard.
  if (SECRET_GOAL.test(String(goal ?? ""))) {
    const secret = claimedLabeledSecret(answer);
    if (secret && isFabricated(steps, secret)) {
      return { followupMessage: fabricationMessage("secret", secret) };
    }
  }
  return {};
}

/**
 * Stop hook that challenges a fabricated secret. Compose with an inner hook:
 * the guard runs first, the inner hook runs when the guard passes.
 *
 * @param {object} [options]
 * @param {import("./agent-loop.mjs").AgentHooks["stop"]} [options.inner]
 * @param {number} [options.maxLoops]
 * @returns {import("./agent-loop.mjs").AgentHooks["stop"]}
 */
export function createSecretFabricationGuard({ inner, maxLoops = 1 } = {}) {
  return async (ctx) => {
    const decision = guardSecretFabrication(ctx, { maxLoops });
    if (decision?.followupMessage) return decision;
    if (typeof inner === "function") return inner(ctx);
    return {};
  };
}

/**
 * Attach the secret-fabrication stop hook when enabled.
 * @param {import("./agent-loop.mjs").AgentHooks} [hooks]
 * @param {boolean} [enabled]
 * @returns {import("./agent-loop.mjs").AgentHooks}
 */
export function withSecretFabricationGuard(hooks = {}, enabled = true) {
  if (!enabled) return { ...hooks };
  return {
    ...hooks,
    stop: createSecretFabricationGuard({ inner: hooks.stop }),
  };
}
