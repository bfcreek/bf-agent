/**
 * Stop-hook + mid-run checkpoint for named file deliverables.
 *
 * Terminal-Bench-style tasks name an output path (`/app/results.txt`,
 * `recovered_passwords.txt`, …). Models often recover the answer in chat or
 * `/tmp` and never write the required file — or they stop without reading it
 * back. This guard blocks "done" until those paths are written (and ideally
 * read), and the loop can inject a budget warning while tools still work.
 */

import { changedFilesFromSteps } from "./session-store.mjs";

/**
 * Absolute workspace paths commonly named in Harbor / Terminal-Bench goals.
 * Also catches relative filenames that look like deliberate outputs
 * (`results.txt`, `solution.txt`) when the goal says write/save/create them.
 */
const ABS_DELIVERABLE =
  /(?:^|[\s`'"(])(\/(?:app|home|workspace|tmp)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,12})/g;

const REL_DELIVERABLE_VERB =
  /\b(?:write|save|create|produce|output|put|store|dump|emit|place)\b[\s\S]{0,80}?\b([A-Za-z0-9._/-]+\.(?:txt|json|py|sh|md|csv|out|log|flag|bin|dat))\b/gi;

const REL_DELIVERABLE_TO =
  /\b(?:to|into|at|as)\s+[`'"]?([A-Za-z0-9._/-]+\.(?:txt|json|py|sh|md|csv|out|log|flag))\b/gi;

/** Paths that are inputs / noise, not graded deliverables. */
const IGNORE_PATH_RE =
  /(?:^|\/)(?:package\.json|package-lock\.json|tsconfig\.json|Cargo\.toml|go\.mod|requirements\.txt|Dockerfile|README\.md|\.git\/)/i;

/**
 * @param {string} goal
 * @returns {string[]} Unique deliverable paths (as written in the goal).
 */
export function extractDeliverablePaths(goal) {
  const text = String(goal ?? "");
  const found = new Set();

  for (const match of text.matchAll(ABS_DELIVERABLE)) {
    const p = match[1];
    if (p && !IGNORE_PATH_RE.test(p)) found.add(p);
  }

  for (const re of [REL_DELIVERABLE_VERB, REL_DELIVERABLE_TO]) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      const p = match[1];
      if (!p || IGNORE_PATH_RE.test(p)) continue;
      // Prefer absolute forms already captured; skip bare src/lib noise.
      if (/^(src|lib|test|tests|node_modules)\//i.test(p)) continue;
      found.add(p);
    }
  }

  return [...found];
}

/**
 * Normalize path forms so `/app/foo.txt`, `app/foo.txt`, and `foo.txt` match.
 * @param {string} p
 * @returns {string[]}
 */
export function pathAliases(p) {
  const raw = String(p ?? "").replace(/\\/g, "/").replace(/\/+/g, "/");
  const out = new Set([raw]);
  const base = raw.split("/").pop();
  if (base) out.add(base);
  const noLead = raw.replace(/^\.\//, "");
  out.add(noLead);
  if (noLead.startsWith("app/")) out.add(noLead.slice("app/".length));
  if (noLead.startsWith("/app/")) {
    out.add(noLead.slice(1));
    out.add(noLead.slice("/app/".length));
  }
  return [...out];
}

/**
 * @param {string} candidate
 * @param {string} required
 * @returns {boolean}
 */
export function pathsMatch(candidate, required) {
  const a = pathAliases(candidate);
  const b = new Set(pathAliases(required));
  return a.some((x) => b.has(x));
}

/**
 * Paths the agent authored via write_file / edit_file / shell redirect / tee.
 * @param {Array<object>} [steps]
 * @returns {string[]}
 */
export function writtenPathsFromSteps(steps) {
  const files = new Set(changedFilesFromSteps(steps));
  for (const step of steps ?? []) {
    if (step?.kind !== "tool-calls") continue;
    for (const call of step.toolCalls ?? []) {
      if (call?.ok === false) continue;
      const name = call?.name ?? "";
      if (name === "run_command") {
        const cmd = String(call?.args?.command ?? "");
        for (const p of shellRedirectTargets(cmd)) files.add(p);
      }
    }
  }
  return [...files];
}

/**
 * @param {string} command
 * @returns {string[]}
 */
export function shellRedirectTargets(command) {
  const out = [];
  const cmd = String(command ?? "");
  // `> path`, `>> path` (not `2>` alone / `>&`)
  for (const match of cmd.matchAll(/(?:^|[\s;|&])(?:\d*)>>?\s*(?:'([^']+)'|"([^"]+)"|(\S+))/g)) {
    const p = match[1] || match[2] || match[3];
    if (p && !/^&/.test(p) && p !== "/dev/null") out.push(p);
  }
  for (const match of cmd.matchAll(/\btee(?:\s+-a)?\s+(?:'([^']+)'|"([^"]+)"|(\S+))/g)) {
    const p = match[1] || match[2] || match[3];
    if (p) out.push(p);
  }
  return out;
}

/**
 * @param {Array<object>} [steps]
 * @param {string} required
 * @returns {boolean}
 */
export function wasWritten(steps, required) {
  return writtenPathsFromSteps(steps).some((p) => pathsMatch(p, required));
}

/**
 * Whether the agent read the deliverable back (read_file or cat/type/head).
 * @param {Array<object>} [steps]
 * @param {string} required
 * @returns {boolean}
 */
export function wasReadBack(steps, required) {
  for (const step of steps ?? []) {
    if (step?.kind !== "tool-calls") continue;
    for (const call of step.toolCalls ?? []) {
      if (call?.ok === false) continue;
      const name = call?.name ?? "";
      if (name === "read_file") {
        const p = call?.args?.path ?? call?.result?.path;
        if (p && pathsMatch(String(p), required)) return true;
      }
      if (name === "run_command") {
        const cmd = String(call?.args?.command ?? "");
        if (/\b(?:cat|type|head|tail|less|more|nl|bat)\b/i.test(cmd)) {
          for (const alias of pathAliases(required)) {
            if (cmd.includes(alias)) return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * @param {string} [goal]
 * @param {Array<object>} [steps]
 * @returns {{required: string[], missing: string[], unread: string[]}}
 */
export function deliverableStatus(goal, steps) {
  const required = extractDeliverablePaths(goal);
  const missing = required.filter((p) => !wasWritten(steps, p));
  const unread = required.filter((p) => wasWritten(steps, p) && !wasReadBack(steps, p));
  return { required, missing, unread };
}

/**
 * Mid-run budget warning while tools still work.
 * @param {object} input
 * @param {string} [input.goal]
 * @param {Array<object>} [input.steps]
 * @param {number} [input.remainingSteps]
 * @param {number} [input.remainingMs]
 * @returns {string|null}
 */
export function deliverableCheckpointMessage({ goal, steps, remainingSteps, remainingMs } = {}) {
  const { required, missing } = deliverableStatus(goal, steps);
  if (required.length === 0 || missing.length === 0) return null;

  const parts = [
    `Required output file(s) still missing: ${missing.map((p) => `\`${p}\``).join(", ")}.`,
    "Stop exploring and write the best candidate you have to that path now with write_file (or a shell redirect).",
    "A chat answer is not the deliverable — only the file counts. After writing, read it back once, then finish.",
  ];
  if (Number.isFinite(remainingSteps) && remainingSteps >= 0) {
    parts.push(`About ${remainingSteps} step(s) remain.`);
  }
  if (Number.isFinite(remainingMs) && remainingMs >= 0 && remainingMs < 600_000) {
    parts.push(`About ${Math.max(1, Math.round(remainingMs / 1000))}s of wall-clock remain.`);
  }
  return parts.join(" ");
}

/**
 * @param {object} ctx
 * @param {string} [ctx.goal]
 * @param {string} [ctx.text]
 * @param {Array<object>} [ctx.steps]
 * @param {number} [ctx.loopCount]
 * @param {{ maxLoops?: number, requireReadBack?: boolean }} [options]
 * @returns {{ followupMessage?: string }}
 */
export function guardMissingDeliverable(
  { goal, text, steps, loopCount } = {},
  { maxLoops = 2, requireReadBack = true } = {},
) {
  if ((loopCount ?? 0) >= maxLoops) return {};
  const { required, missing, unread } = deliverableStatus(goal, steps);
  if (required.length === 0) return {};

  if (missing.length > 0) {
    return {
      followupMessage:
        `You claimed to be done, but required output file(s) were never written: ${missing.map((p) => `\`${p}\``).join(", ")}. ` +
        "Write them now with write_file (partial/full guesses are fine — iterate). " +
        "Do not treat the chat final answer as the deliverable." +
        (text ? `\n\nYour previous claim was:\n${String(text).slice(0, 600)}` : ""),
    };
  }

  if (requireReadBack && unread.length > 0) {
    return {
      followupMessage:
        `Required output file(s) exist but were not read back in this run: ${unread.map((p) => `\`${p}\``).join(", ")}. ` +
        "Read each with read_file (or cat), confirm contents look right, then reply in plain text with no more tools.",
    };
  }

  return {};
}

/**
 * @param {object} [options]
 * @param {import("./agent-loop.mjs").AgentHooks["stop"]} [options.inner]
 * @param {number} [options.maxLoops]
 * @param {boolean} [options.requireReadBack]
 * @returns {import("./agent-loop.mjs").AgentHooks["stop"]}
 */
export function createDeliverableGuard({ inner, maxLoops = 2, requireReadBack = true } = {}) {
  return async (ctx) => {
    const decision = guardMissingDeliverable(ctx, { maxLoops, requireReadBack });
    if (decision?.followupMessage) return decision;
    if (typeof inner === "function") return inner(ctx);
    return {};
  };
}

/**
 * @param {import("./agent-loop.mjs").AgentHooks} [hooks]
 * @param {boolean} [enabled]
 * @returns {import("./agent-loop.mjs").AgentHooks}
 */
export function withDeliverableGuard(hooks = {}, enabled = true) {
  if (!enabled) return { ...hooks };
  return {
    ...hooks,
    stop: createDeliverableGuard({ inner: hooks.stop }),
  };
}
