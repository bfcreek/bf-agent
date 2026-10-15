/**
 * Stop-hook guard against hollow completions: the model claims "done" on an
 * implementation goal without ever calling a mutating tool.
 *
 * Same idea as Copilot's createCompletionGuard, for the plain LLM path
 * (Ollama / OpenAI / Anthropic). Bounded by AgentLoop.maxStopHookLoops.
 */

/** Goals that normally need workspace changes or shell work. */
export const IMPLEMENTATION_GOAL =
  /\b(fix|implement|add|edit|refactor|create|write|delete|update|rename|migrate|build|patch)\b/i;

/** Approval-gated builtins that change the workspace or run shell. */
export const MUTATING_TOOL_NAMES = new Set(["write_file", "edit_file", "run_command"]);

/**
 * @param {Array<{kind?: string, toolCalls?: Array<{name?: string, ok?: boolean}>}>} [steps]
 * @returns {boolean}
 */
export function hasMutatingToolUse(steps) {
  for (const step of steps ?? []) {
    if (step?.kind !== "tool-calls") continue;
    for (const tc of step.toolCalls ?? []) {
      const name = tc?.name ?? tc?.function?.name ?? "";
      if (MUTATING_TOOL_NAMES.has(name) && tc?.ok !== false) return true;
    }
  }
  return false;
}

/**
 * Explicit escape hatch when the model clarifies the goal was Q&A only.
 * @param {string} text
 * @returns {boolean}
 */
export function claimsQaOnly(text) {
  return /\b(q\s*&\s*a|question(?:s)? only|no workspace changes|read[- ]only|truly q&a)\b/i.test(
    String(text ?? ""),
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
export function guardHollowCompletion({ goal, text, steps, loopCount } = {}, { maxLoops = 2 } = {}) {
  if ((loopCount ?? 0) >= maxLoops) return {};
  if (!IMPLEMENTATION_GOAL.test(String(goal ?? ""))) return {};
  if (hasMutatingToolUse(steps)) return {};
  if (claimsQaOnly(text)) return {};

  return {
    followupMessage:
      "This looks like implementation work, but no mutating tools (write_file, edit_file, or run_command) ran. " +
      "Use those tools to make the changes, then verify before declaring done. " +
      "Do not ask the user to restate the task or to choose a file — the request above is the task. " +
      "If the goal is truly Q&A with no workspace changes, say so explicitly and answer." +
      (text ? `\n\nYour previous claim was:\n${String(text).slice(0, 800)}` : ""),
  };
}

/**
 * Default stop hook that challenges hollow "done" on create/implement goals.
 * Compose with a user hook: run guard first, then user hook if guard passes.
 *
 * @param {object} [options]
 * @param {import("./agent-loop.mjs").AgentHooks["stop"]} [options.inner]
 * @param {number} [options.maxLoops]
 * @returns {import("./agent-loop.mjs").AgentHooks["stop"]}
 */
export function createHollowCompletionGuard({ inner, maxLoops = 2 } = {}) {
  return async (ctx) => {
    const decision = guardHollowCompletion(ctx, { maxLoops });
    if (decision?.followupMessage) return decision;
    if (typeof inner === "function") return inner(ctx);
    return {};
  };
}

/**
 * Attach the hollow-completion stop hook when enabled.
 * @param {import("./agent-loop.mjs").AgentHooks} [hooks]
 * @param {boolean} [enabled]
 * @returns {import("./agent-loop.mjs").AgentHooks}
 */
export function withHollowCompletionGuard(hooks = {}, enabled = true) {
  if (!enabled) return { ...hooks };
  return {
    ...hooks,
    stop: createHollowCompletionGuard({ inner: hooks.stop }),
  };
}
