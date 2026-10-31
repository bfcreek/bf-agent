/**
 * Stop-hook + mid-run checkpoint for named file deliverables.
 *
 * Terminal-Bench-style tasks name an output path (`/app/results.txt`,
 * `recovered_passwords.txt`, …). Models often recover the answer in chat or
 * `/tmp` and never write the required file — or they stop without reading it
 * back. This guard blocks "done" until those paths are written (and ideally
 * read), and the loop can inject a budget warning while tools still work.
 *
 * Path extraction is deliberately conservative: an `/app/….ext` mention is not
 * enough. Paths only count when the instruction frames them as outputs
 * (write/create/save … to/named/called). Command arguments and provided
 * inputs (`node extract.js /app/a.out`, `Start the /app/alpine.iso`,
 * "I have provided /app/demo_rgb.png") are ignored so a false-positive stop
 * hook cannot force the model to overwrite fixtures after a correct finish.
 */

import { changedFilesFromSteps } from "./session-store.mjs";

/** Absolute workspace paths commonly named in Harbor / Terminal-Bench goals. */
const ABS_PATH =
  /\/(?:app|home|workspace|tmp)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,12}/;

/** Relative filenames that look like deliberate script/data outputs. */
const REL_PATH =
  /[A-Za-z0-9._/-]+\.(?:txt|json|js|mjs|ts|py|sh|md|csv|out|log|flag|bin|dat)/;

/**
 * Output-framed constructions. Each capture group 1 is a deliverable path.
 * Windows are short and anchored on create/write verbs so command examples
 * buried later in the same sentence (`write extract.js that runs with
 * \`node … /app/a.out > out.json\``) do not pull in args or stdout redirects.
 */
const OUTPUT_PATTERNS = [
  // write/save it to PATH, produce PATH, …
  new RegExp(
    String.raw`\b(?:write|save|create|produce|put|store|dump|emit|place)\b[\s\S]{0,50}?\b(?:to|into|at)\s+[\`'"]?(${ABS_PATH.source}|${REL_PATH.source})\b`,
    "gi",
  ),
  // Create the file PATH / write a CSV file called PATH
  new RegExp(
    String.raw`\b(?:write|save|create|produce|implement)\b[\s\S]{0,40}?\b(?:file|script|program|module|csv|json|document)s?\b[\s\S]{0,40}?\b(?:called|named)?\s*[\`'"]?(${ABS_PATH.source}|${REL_PATH.source})\b`,
    "gi",
  ),
  // Create the file /app/foo.py (path immediately after "file")
  new RegExp(
    String.raw`\b(?:create|write|save|implement)\s+(?:the\s+)?file\s+[\`'"]?(${ABS_PATH.source}|${REL_PATH.source})\b`,
    "gi",
  ),
  // write a python script in /app named convert_masks.py
  new RegExp(
    String.raw`\b(?:write|create)\b[\s\S]{0,60}?\bnamed\s+[\`'"]?(${REL_PATH.source})\b`,
    "gi",
  ),
  // Write me a program extract.js
  new RegExp(
    String.raw`\b(?:write|create)\b[\s\S]{0,30}?\b(?:program|script|module)\s+[\`'"]?([A-Za-z0-9._-]+\.(?:js|mjs|ts|py|sh|rb|go))\b`,
    "gi",
  ),
  // save solution.txt / write results.txt (bare verb + short relative path)
  new RegExp(
    String.raw`\b(?:write|save|create|produce|dump|emit|place)\s+(?:(?:a|an|the|it|this|that)\s+)?[\`'"]?(${REL_PATH.source})\b`,
    "gi",
  ),
];

/** Paths that are inputs / noise, not graded deliverables. */
const IGNORE_PATH_RE =
  /(?:^|\/)(?:package\.json|package-lock\.json|tsconfig\.json|Cargo\.toml|go\.mod|requirements\.txt|Dockerfile|README\.md|\.git\/)/i;

/**
 * Model replies that the listed path is a provided input / already present —
 * do not re-steer into write_file theater.
 */
const INPUT_REFUSAL_RE =
  /\b(?:input|provided|existing|fixture|already\s+(?:exists?|present|there|written)|will\s+not\s+overwrite|won'?t\s+overwrite|do\s+not\s+overwrite|not\s+(?:a\s+)?(?:required\s+)?(?:output|deliverable)|leave\s+(?:it|them|the\s+file)\s+alone)\b/i;

/**
 * @param {string} goal
 * @returns {string[]} Unique deliverable paths (as written in the goal).
 */
export function extractDeliverablePaths(goal) {
  const text = String(goal ?? "");
  /** @type {string[]} */
  const found = [];

  for (const re of OUTPUT_PATTERNS) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      const p = match[1];
      if (!p || IGNORE_PATH_RE.test(p)) continue;
      if (/^(src|lib|test|tests|node_modules)\//i.test(p)) continue;
      // Use the path's own index, not the start of the verb phrase — otherwise
      // "Write … extract.js" looks like it has no output verb before the path.
      const pathIndex = (match.index ?? 0) + match[0].lastIndexOf(p);
      if (isCommandArgument(text, pathIndex, p)) continue;
      if (isProvidedInput(text, pathIndex, p)) continue;
      found.push(p);
    }
  }

  return dedupePathAliases(found);
}

/**
 * Prefer absolute forms; drop entries that are aliases of a kept path.
 * @param {string[]} paths
 * @returns {string[]}
 */
export function dedupePathAliases(paths) {
  const unique = [];
  for (const p of paths) {
    if (unique.some((u) => pathsMatch(u, p))) {
      // Prefer the longer / more absolute spelling already kept, unless the
      // new one is clearly more absolute.
      const idx = unique.findIndex((u) => pathsMatch(u, p));
      if (idx >= 0 && p.startsWith("/") && !unique[idx].startsWith("/")) {
        unique[idx] = p;
      }
      continue;
    }
    unique.push(p);
  }
  return unique;
}

/**
 * Path sits inside a shell/example command as an argument, not as the thing
 * being authored (e.g. `node extract.js /app/a.out > out.json`).
 * @param {string} text
 * @param {number} matchIndex
 * @param {string} path
 * @returns {boolean}
 */
export function isCommandArgument(text, matchIndex, path) {
  const start = matchIndex;
  const end = matchIndex + String(path).length;
  // Backtick / fenced command spanning the path.
  const before = text.slice(Math.max(0, start - 120), start);
  const after = text.slice(end, end + 40);
  const inBackticks =
    (before.lastIndexOf("`") > before.lastIndexOf("\n")) &&
    after.includes("`");
  if (inBackticks) {
    // Redirect targets inside the same command (`> out.json`) are still
    // program stdout, not agent write_file deliverables — treat the whole
    // backtick span as non-deliverable context.
    return true;
  }
  // Flag/positional arg: `-cdrom PATH`, `node extract.js PATH`, `python3 ./x.py`
  // Require a path-like token after the interpreter so "a python script named X"
  // is not treated as an invocation.
  if (
    /(?:^|[\s`'"(])(?:-[\w-]+|=)\s*$/.test(before) ||
    /(?:^|[\s`'"(])(?:node|nodejs|python3?|qemu[^\s]*|bash|sh|ruby|perl)\s+(?:[./]|\S+\.\w+)[^\n`]{0,60}$/i.test(
      before,
    )
  ) {
    return true;
  }
  // "when run with … PATH" / "run with PATH" describes invocation, not authorship.
  if (/\b(?:when\s+)?run(?:ning)?\s+with\b[\s\S]{0,60}$/i.test(before)) {
    return true;
  }
  return false;
}

const OUTPUT_VERB_RE =
  /\b(?:write|save|create|produce|implement|put|store|dump|emit|place)\b/i;

/**
 * Path is introduced as a provided/demo/existing input.
 * An output verb between the "provided" marker and the path starts a new
 * clause (`I have provided a.out. Write extract.js`) so that path is not
 * treated as an input.
 * @param {string} text
 * @param {number} matchIndex
 * @param {string} _path
 * @returns {boolean}
 */
export function isProvidedInput(text, matchIndex, _path) {
  const before = text.slice(Math.max(0, matchIndex - 160), matchIndex);

  const providedIdx = before.search(/\b(?:i\s+have\s+)?(?:provided|given)\b/i);
  if (providedIdx >= 0) {
    const afterProvided = before.slice(providedIdx);
    if (!OUTPUT_VERB_RE.test(afterProvided)) return true;
  }

  const demoIdx = before.search(
    /\b(?:demo|sample|example|input|existing)\s+(?:file|files|image|csv|binary|artifact|iso|slide)s?\b/i,
  );
  if (demoIdx >= 0 && !OUTPUT_VERB_RE.test(before.slice(demoIdx))) return true;

  if (/\bstart(?:ing)?\s+(?:the\s+)?$/i.test(before)) return true;
  if (/\b(?:boot|launch|mount|load)(?:ing)?\s+(?:the\s+)?$/i.test(before)) return true;
  return false;
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
 * True when the model is refusing to overwrite a path it treats as an input.
 * @param {string} [text]
 * @param {string[]} [missing]
 * @returns {boolean}
 */
export function claimsInputNotDeliverable(text, missing = []) {
  const body = String(text ?? "");
  if (!body.trim() || !INPUT_REFUSAL_RE.test(body)) return false;
  // If specific paths were named, require at least one to appear (or a clear
  // generic "those are inputs" with no conflicting "I'll write X" plan).
  if (missing.length === 0) return true;
  const mentionsPath = missing.some((p) => {
    const aliases = pathAliases(p);
    return aliases.some((a) => a && body.includes(a));
  });
  return mentionsPath || /\b(?:those|they|that\s+file|the\s+listed)\b/i.test(body);
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
    if (claimsInputNotDeliverable(text, missing)) return {};
    return {
      followupMessage:
        `You claimed to be done, but required output file(s) were never written: ${missing.map((p) => `\`${p}\``).join(", ")}. ` +
        "Write them now with write_file (partial/full guesses are fine — iterate). " +
        "Do not treat the chat final answer as the deliverable. " +
        "Only create paths the task asks you to author — do not overwrite provided inputs." +
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
