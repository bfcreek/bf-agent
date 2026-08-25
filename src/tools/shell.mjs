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
import { access } from "node:fs/promises";

import { looksVacuousCliStdout } from "../prompt-enhancements.mjs";
import { goalAllowsPosixShell, resolveWithinRoot, truncateMiddle } from "./fs.mjs";
import { analyzeFileMention, isTooBroadTarget } from "./mutation-safety.mjs";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;

/**
 * Interpreters and shells that open an interactive REPL when launched with
 * no script or inline code. The tool runs commands with no TTY input, so a
 * REPL can never receive input — it just hangs until the timeout.
 */
const REPL_COMMAND_NAMES = new Set([
  "node",
  "deno",
  "bun",
  "python",
  "python3",
  "py",
  "ipython",
  "irb",
  "pry",
  "ghci",
  "lua",
  "php",
  "powershell",
  "pwsh",
  "cmd",
  "bash",
  "sh",
  "zsh",
  "fish",
]);

/** Flags that request an interactive session — never useful here. */
const INTERACTIVE_ONLY_FLAGS = new Set(["-i", "--interactive"]);

/**
 * Block bash/.sh invocations on Windows unless the user asked for POSIX shell.
 * Models otherwise write and run bash even when run_command is PowerShell.
 *
 * @param {string} command
 * @param {string} [goal]
 * @param {{ platform?: string }} [options]
 * @returns {string|null}
 */
export function windowsBashCommandIssue(command, goal, { platform = process.platform } = {}) {
  if (platform !== "win32") return null;
  if (goalAllowsPosixShell(goal)) return null;
  const text = String(command ?? "");
  const usesBash =
    /(?:^|[;|&\n]\s*)(?:bash|sh)(?:\s|$)/.test(text) ||
    /(?:^|[;|&\n\s])[\w./\\-]+\.(?:sh|bash)(?:\s|$|"|')/.test(text);
  if (!usesBash) return null;
  return (
    "This is Windows PowerShell. Do not run bash/.sh unless the user asked for bash. " +
    "Write a .ps1 script or use PowerShell syntax (chain with ';'), then retry."
  );
}

/**
 * Detect command segments that would start an interactive REPL or shell:
 * a bare interpreter (`node`, `python`, `bash`, …) with no script path,
 * no inline code, and no other arguments (or only interactive flags).
 * Such commands hang until the timeout, wasting an entire tool step.
 *
 * @param {string} command
 * @returns {string|null} The offending segment, or null when none found.
 */
export function findInteractiveCommand(command) {
  const segments = String(command ?? "").split(/(?:\|\||&&|[;|&\n(){}`]|\$\()/);
  for (const raw of segments) {
    const segment = raw.trim();
    if (!segment) continue;
    const base = commandBaseName(segment);
    if (!base || !REPL_COMMAND_NAMES.has(base)) continue;
    const args = segmentWords(segment).slice(1);
    if (args.length === 0 || args.every((a) => INTERACTIVE_ONLY_FLAGS.has(a.toLowerCase()))) {
      return segment;
    }
  }
  return null;
}

/**
 * CLIs that should print to stdout. Exit 0 with empty stdout usually means a
 * broken Windows entry-point guard (URL.pathname / new URL(process.argv[1])).
 *
 * @param {string} command
 * @param {number|null} exitCode
 * @param {string} stdout
 * @returns {string|null}
 */
export function cliEmptyStdoutNote(command, exitCode, stdout) {
  if (exitCode !== 0) return null;
  const text = String(command ?? "");
  if (/\b(test\.mjs|test\.py|npm\s+test|node\s+--test|dotnet\s+test|pytest)\b/i.test(text)) {
    return null;
  }
  if (
    !(/\b(node|nodejs|python3?|py)\s+\S+\.(mjs|js|cjs|py)\b/i.test(text) || /\bdotnet\s+run\b/i.test(text))
  ) {
    return null;
  }
  const out = String(stdout ?? "").trim();
  if (!out) {
    return (
      "Exited 0 with empty stdout. If this CLI should print, the entry-point guard is likely wrong on Windows: " +
      "use import.meta.url === pathToFileURL(process.argv[1]).href (not new URL(process.argv[1])), " +
      "and resolve sibling files with fileURLToPath(new URL('./file', import.meta.url))."
    );
  }
  if (out === "[]") {
    return (
      "Exited 0 but stdout is an empty JSON array []. If the input has records, property names likely did not bind. " +
      "In C# deserialize with JsonSerializerOptions { PropertyNameCaseInsensitive = true } and serialize with JsonNamingPolicy.CamelCase. " +
      "Read the JSON file and compare stdout to expected records before claiming success."
    );
  }
  if (looksVacuousCliStdout(out, text)) {
    return (
      "Exited 0 but stdout looks empty of catalog records (qty=0 and no SKUs). " +
      "JSON property names likely did not bind — deserialize with PropertyNameCaseInsensitive = true, " +
      "then re-run the same command and confirm SKUs appear before finishing."
    );
  }
  return null;
}

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
/** PowerShell common parameters that take a value (not a file path). */
const PS_PARAMS_WITH_VALUE = new Set([
  "-erroraction",
  "-ea",
  "-warningaction",
  "-wa",
  "-informationaction",
  "-ia",
]);

/** Bare PowerShell action names that are not deletion targets. */
const PS_ACTION_VALUES = new Set([
  "silentlycontinue",
  "continue",
  "stop",
  "inquire",
  "ignore",
  "suspend",
  "break",
]);

export function extractDeleteTargets(segment) {
  const words = segmentWords(segment);
  const base = commandBaseName(segment);
  if (base === "find") return [];
  let args = words.slice(1);
  if (base === "git") args = args.slice(1);

  const targets = [];
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (raw.startsWith("-")) {
      if (PS_PARAMS_WITH_VALUE.has(raw.toLowerCase())) i += 1;
      continue;
    }
    if (/^\/[a-z]{1,2}$/i.test(raw)) continue; // DOS switch (/s, /q, /f)
    const target = raw
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/^\.[\\/]/, "")
      .replace(/[\\/]+$/, "");
    if (!target) continue;
    if (PS_ACTION_VALUES.has(target.toLowerCase())) continue;
    targets.push(target);
  }
  return targets;
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
    const mention = analyzeFileMention(goalText, target);
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
      "in the workspace directory and return its status ('success' or 'FAILED with exit code N'), " +
      "exit code, stdout, and stderr. Commands run with no input, so never launch a bare " +
      "interpreter or shell (node, python, bash) without a script or inline code. " +
      (IS_WINDOWS
        ? "On Windows do not invoke bash or .sh unless the user asked for bash; write and run .ps1 instead. "
        : "") +
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
      // A REPL can never succeed here (no TTY input), so this gate applies
      // even when a human approved the call — it saves a guaranteed timeout.
      const interactive = findInteractiveCommand(command);
      if (interactive) {
        throw new Error(
          `'${interactive}' starts an interactive REPL/shell, which hangs until the timeout ` +
            "because commands run with no input. Run a script file instead (e.g. node script.mjs, " +
            'python script.py) or pass inline code (e.g. node -e "...", python -c "...").',
        );
      }
      const posixShell = windowsBashCommandIssue(command, registry.runContext?.goal);
      if (posixShell) throw new Error(posixShell);
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
      let dir = workspaceRoot;
      if (cwd) {
        dir = resolveWithinRoot(workspaceRoot, cwd);
        try {
          await access(dir);
        } catch {
          dir = workspaceRoot;
        }
      }
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
      // `status` leads the result so a failure cannot be mistaken for
      // success just because the tool call itself succeeded (ok: true).
      const status = timedOut
        ? `TIMED OUT after ${Math.round(timeoutMs / 1000)}s and was killed — treat this as a failure; do not re-run the same command unchanged`
        : code === 0
          ? "success"
          : `FAILED with exit code ${code}`;
      const note = timedOut ? null : cliEmptyStdoutNote(command, code, stdout);
      resolve({
        status,
        exitCode: code,
        timedOut,
        stdout: truncateMiddle(stdout),
        stderr: truncateMiddle(stderr),
        ...(note ? { note } : {}),
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
