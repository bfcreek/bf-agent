/**
 * Shell tool: run a command through the system shell, scoped to the
 * workspace. Guardrails: workspace-bound cwd, a hard timeout, capped output,
 * and a deletion gate. Safety wins over task instructions: deletion runs
 * only when the user explicitly named the target files in their request
 * (or approved the call at the ask-mode prompt); anything broader — "clean
 * up", wildcards, files the user said to keep — is refused so the agent
 * asks the user instead.
 */

import { spawn } from "node:child_process";

import { resolveWithinRoot, truncateMiddle } from "./fs.mjs";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;

/**
 * Command names (PowerShell and POSIX, incl. aliases) that delete files.
 * Compared against the first word of each shell segment, basename only.
 */
const DELETE_COMMAND_NAMES = new Set([
  "rm",
  "rmdir",
  "rd",
  "del",
  "erase",
  "unlink",
  "shred",
  "trash",
  "remove-item",
  "ri",
]);

/**
 * Best-effort detection of file-deletion commands. Splits the command line
 * into segments at shell separators (;, |, &&, ||, newlines, subshells,
 * script blocks) and checks the leading word of each. Catches `rm`/`del`/
 * `Remove-Item` variants, `git rm`/`git clean`, and `find ... -delete`; it
 * cannot catch every escape hatch (e.g. inline scripts), so the system
 * prompt carries the same rule for the model.
 *
 * @param {string} command
 * @returns {string|null} The offending segment, or null when none found.
 */
export function findDeleteCommand(command) {
  const segments = String(command ?? "").split(/(?:\|\||&&|[;|&\n(){}`]|\$\()/);
  for (const raw of segments) {
    const segment = raw.trim();
    if (!segment) continue;
    const base = commandBaseName(segment);
    if (!base) continue;
    if (DELETE_COMMAND_NAMES.has(base)) return segment;
    const words = segmentWords(segment);
    if (base === "git" && ["rm", "clean"].includes(words[1]?.toLowerCase())) return segment;
    if (base === "find" && /\s-delete(\s|$)/.test(segment)) return segment;
  }
  return null;
}

/** Words of a segment with a leading `sudo` stripped. */
function segmentWords(segment) {
  const words = segment.split(/\s+/);
  return words[0]?.toLowerCase() === "sudo" ? words.slice(1) : words;
}

/** Lowercase basename of a segment's command word, without a .exe suffix. */
function commandBaseName(segment) {
  return segmentWords(segment)[0]
    ?.toLowerCase()
    .replace(/^.*[\\/]/, "")
    .replace(/\.exe$/, "");
}

/**
 * File/directory arguments of a deletion segment: everything that is not a
 * flag (`-rf`, `-Force`, DOS switches like `/s`), with quotes and `./`
 * prefixes stripped. `git rm`/`git clean` skip the subcommand word;
 * `find … -delete` reports no targets because it deletes whatever a search
 * matches, which the user cannot have named.
 *
 * @param {string} segment
 * @returns {string[]}
 */
export function extractDeleteTargets(segment) {
  const words = segmentWords(segment);
  const base = commandBaseName(segment);
  if (base === "find") return [];
  let args = words.slice(1);
  if (base === "git") args = args.slice(1);

  const targets = [];
  for (const raw of args) {
    if (raw.startsWith("-")) continue;
    if (/^\/[a-z]{1,2}$/i.test(raw)) continue; // DOS switch (/s, /q, /f)
    const target = raw
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/^\.[\\/]/, "")
      .replace(/[\\/]+$/, "");
    if (target) targets.push(target);
  }
  return targets;
}

/** Targets like `.`, `*`, or `~` delete far more than any named file. */
function isTooBroadTarget(target) {
  return /^[.\\/*~]+$/.test(target);
}

/**
 * Language in the user's request that protects a file from deletion when it
 * appears in the same sentence as the file's name.
 */
const PROTECTIVE_PATTERN =
  /\b(?:not|never|don'?t|keep|preserve|except|leave|required|important|must\s+(?:stay|remain|survive))\b/i;

/**
 * How the user's request relates to one deletion target: did they name it,
 * and if so, did the same sentence tell us to keep it?
 *
 * @param {string} goal
 * @param {string} target
 * @returns {{mentioned: boolean, protected: boolean}}
 */
function analyzeMention(goal, target) {
  // Wildcards can't be matched literally; check the fixed part (`*.log` →
  // `.log`). An all-wildcard target has no fixed part to authorize.
  const fixed = target.replace(/[*?]+/g, "");
  if (!fixed || isTooBroadTarget(fixed)) return { mentioned: false, protected: false };

  const escaped = fixed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Boundaries: no word char or hyphen on either side, and no dot that is
  // part of a longer name (`x.txt` inside `x.txt.bak`) — but a sentence
  // period right after the name ("Delete junk.txt.") is fine.
  const mention = new RegExp(`(?<![\\w-]|\\w\\.)${escaped}(?!\\w|-|\\.\\w)`, "gi");

  let mentioned = false;
  for (const match of goal.matchAll(mention)) {
    mentioned = true;
    // Judge protective language only within the mention's sentence, so a
    // "keep everything else" in the next sentence does not shadow an
    // explicit "delete X" in this one.
    const before = goal.slice(0, match.index);
    const sentenceStart = Math.max(
      before.lastIndexOf(". "),
      before.lastIndexOf("! "),
      before.lastIndexOf("? "),
      before.lastIndexOf("; "),
      before.lastIndexOf("\n"),
    );
    const after = goal.slice(match.index + match[0].length);
    const afterEnd = after.search(/[.!?;]\s|\n|$/); // `$` ⇒ always ≥ 0
    const sentence = goal.slice(sentenceStart + 1, match.index + match[0].length + afterEnd);
    if (PROTECTIVE_PATTERN.test(sentence)) return { mentioned: true, protected: true };
  }
  return { mentioned, protected: false };
}

/**
 * Decide whether a command's deletions are authorized by the user's request.
 *
 * - `none`: the command deletes nothing.
 * - `authorized`: every deletion target is explicitly named in the goal,
 *   with no protective language around it.
 * - `protected`: a target is named in the goal with protective language
 *   ("do not delete", "keep", "required", …) — a direct contradiction.
 * - `unauthorized`: a target the user never named (or too broad to name,
 *   like `*` or a `find -delete` / piped delete) — ambiguity, ask first.
 *
 * @param {string} command Full command line.
 * @param {string} [goal] The user's request for this run.
 * @returns {{verdict: "none"|"authorized"|"protected"|"unauthorized", segment?: string, target?: string|null}}
 */
export function classifyDeleteCommand(command, goal) {
  const segment = findDeleteCommand(command);
  if (!segment) return { verdict: "none" };

  const goalText = String(goal ?? "");
  const targets = extractDeleteTargets(segment);
  if (targets.length === 0) return { verdict: "unauthorized", segment, target: null };

  let unnamed = null;
  for (const target of targets) {
    if (isTooBroadTarget(target)) return { verdict: "unauthorized", segment, target };
    const mention = analyzeMention(goalText, target);
    if (mention.protected) return { verdict: "protected", segment, target };
    if (!mention.mentioned && unnamed === null) unnamed = target;
  }
  if (unnamed !== null) return { verdict: "unauthorized", segment, target: unnamed };
  return { verdict: "authorized", segment };
}

// On Windows use PowerShell, not cmd.exe: models overwhelmingly write
// PowerShell or POSIX-flavored commands, and cmd.exe chokes on both.
const IS_WINDOWS = process.platform === "win32";
const SHELL_NAME = IS_WINDOWS ? "PowerShell" : "/bin/sh";

/**
 * @param {import("../tool-registry.mjs").ToolRegistry} registry
 * @param {object} options
 * @param {string} options.workspaceRoot Directory commands run in.
 */
export function registerShellTools(registry, { workspaceRoot }) {
  registry.register({
    name: "run_command",
    requiresApproval: true,
    description:
      `Run a command through the system shell (${SHELL_NAME}; use ${IS_WINDOWS ? "PowerShell" : "POSIX sh"} syntax) ` +
      "in the workspace directory and return its exit code, stdout, and stderr. " +
      `Commands are killed after the timeout (default ${DEFAULT_TIMEOUT_SECONDS}s).`,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to execute." },
        cwd: {
          type: "string",
          description: "Working directory relative to the workspace root. Defaults to the root.",
        },
        timeout_seconds: {
          type: "integer",
          description: `Kill the command after this many seconds (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}).`,
        },
      },
      required: ["command"],
    },
    async execute({ command, cwd, timeout_seconds }) {
      if (!command || !command.trim()) throw new Error("command must not be empty.");
      // Deletion gate for unattended runs (in ask mode, reaching execute
      // means the human already approved this exact call). Deletes the user
      // explicitly asked for go ahead; contradictions and ambiguity are
      // refused so the model asks the user instead.
      if (!registry.approvalHandler) {
        const { verdict, segment, target } = classifyDeleteCommand(
          command,
          registry.runContext?.goal,
        );
        if (verdict === "protected") {
          throw new Error(
            `This command ('${segment}') deletes '${target}', but the user's instructions say to ` +
              "keep that file. Do not delete it or work around this check. If you believe it " +
              "must be deleted anyway, stop and ask the user to confirm in your final answer.",
          );
        }
        if (verdict === "unauthorized") {
          throw new Error(
            `This command deletes files ('${segment}') that the user did not explicitly name for ` +
              `deletion${target ? ` (e.g. '${target}')` : ""}, which requires explicit user approval. ` +
              "Do not attempt to delete them another way. If the task requires deleting files, " +
              "stop and ask the user in your final answer to confirm exactly which files may be deleted.",
          );
        }
      }
      const dir = resolveWithinRoot(workspaceRoot, cwd);
      const timeoutMs =
        Math.min(Math.max(1, timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS) *
        1000;
      return runCommand(command, { cwd: dir, timeoutMs });
    },
  });

  return registry;
}

function runCommand(command, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = IS_WINDOWS
      ? // `exit $LASTEXITCODE` propagates the native command's exit code,
        // which powershell.exe otherwise reports as 0.
        spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            `${command}; exit $LASTEXITCODE`,
          ],
          { cwd, windowsHide: true },
        )
      : spawn(command, {
          cwd,
          shell: true,
          windowsHide: true,
          // POSIX: own process group so the timeout can kill the whole tree.
          detached: true,
        });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        timedOut,
        stdout: truncateMiddle(stdout),
        stderr: truncateMiddle(stderr),
      });
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`Failed to start command: ${err.message}`));
      }
    });
    child.on("close", (code) => settle(code));
    // After a kill, orphaned grandchildren can hold the stdio pipes open and
    // delay 'close' indefinitely — settle on 'exit' with whatever was captured.
    child.on("exit", (code) => {
      if (timedOut) settle(code);
    });
  });
}

/** Kill the command and any processes it spawned. */
function killTree(child) {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}
