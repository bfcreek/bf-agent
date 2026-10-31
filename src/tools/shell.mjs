/**
 * Shell tool: run a command through the system shell, scoped to the
 * workspace. Guardrails: workspace-bound cwd, a hard timeout, output spilled
 * to a file when long, and a deletion gate. Safety wins over task
 * instructions: deletion runs only when the user explicitly named the target
 * files in their request (or approved the call — ask-mode prompt or
 * --auto-approve); anything broader — "clean up", wildcards, files the user
 * said to keep — is refused so the agent asks the user instead.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";

import { resolveWithinRoot } from "./fs.mjs";
import { analyzeFileMention, isTooBroadTarget } from "./mutation-safety.mjs";
import { createOutputSpiller } from "./output.mjs";

function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const DEFAULT_TIMEOUT_SECONDS = positiveIntEnv("HALO_COMMAND_TIMEOUT", 30);
const MAX_TIMEOUT_SECONDS = positiveIntEnv("HALO_MAX_COMMAND_TIMEOUT", 300);

/**
 * Wall-clock the run keeps for itself after the last command: a model turn to
 * read the result and answer, plus the session save.
 */
export const DEADLINE_COMMAND_RESERVE_MS = 45_000;
/** Below this much remaining budget a command cannot finish and be acted on. */
export const DEADLINE_MIN_COMMAND_MS = 8_000;
/**
 * Cap any one command to this share of the usable remaining budget. Without
 * it a single `timeout_seconds: 1800` OCR/ffmpeg blast (legal under Harbor's
 * raised HALO_MAX_COMMAND_TIMEOUT) can consume the whole trial and leave no
 * time to write the deliverable — seen on extract-moves-from-video.
 */
export const DEADLINE_MAX_COMMAND_FRACTION = 0.5;

/**
 * Fit a requested command timeout inside the run's remaining wall-clock budget.
 * The run owns the budget, not the command, so the timeout is clamped to what
 * is left after a reserve for the final turn, and never more than
 * {@link DEADLINE_MAX_COMMAND_FRACTION} of that usable window.
 *
 * @param {object} input
 * @param {number} input.requestedMs
 * @param {number|null|undefined} input.deadlineAt Epoch ms; falsy = no budget.
 * @param {number} [input.now]
 */
export function fitTimeoutToDeadline({ requestedMs, deadlineAt, now = Date.now() }) {
  if (!Number.isFinite(deadlineAt) || deadlineAt <= 0) {
    return { timeoutMs: requestedMs, clamped: false, remainingMs: null };
  }
  const remainingMs = Math.max(0, deadlineAt - now);
  const usable = remainingMs - DEADLINE_COMMAND_RESERVE_MS;
  if (usable < DEADLINE_MIN_COMMAND_MS) {
    return { exhausted: true, remainingMs };
  }
  const fractionCap = Math.max(
    DEADLINE_MIN_COMMAND_MS,
    Math.floor(usable * DEADLINE_MAX_COMMAND_FRACTION),
  );
  const allowed = Math.min(usable, fractionCap);
  if (requestedMs <= allowed) return { timeoutMs: requestedMs, clamped: false, remainingMs };
  return { timeoutMs: allowed, clamped: true, remainingMs };
}

/**
 * Interpreters and shells that open an interactive REPL when launched with
 * no script or inline code. The tool runs commands with no TTY input, so a
 * REPL can never receive input — it just hangs until the timeout.
 */
const REPL_COMMAND_NAMES = new Set([
  "node", "deno", "bun", "python", "python3", "py", "ipython", "irb", "pry", "ghci",
  "lua", "php", "powershell", "pwsh", "cmd", "bash", "sh", "zsh", "fish",
]);

/** Flags that request an interactive session — never useful here. */
const INTERACTIVE_ONLY_FLAGS = new Set(["-i", "--interactive"]);

/**
 * Detect command segments that would start an interactive REPL or shell.
 * @param {string} command
 * @returns {string|null} The offending segment, or null when none found.
 */
export function findInteractiveCommand(command) {
  // Heredoc bodies are stdin data, not commands: `python3 - <<'PY' ... PY`
  // must not have its body lines (or its terminator, e.g. `PY` → `py`)
  // read as command segments.
  const text = stripHeredocBodies(String(command ?? ""));
  const parts = text.split(/(\|\||&&|[;|&\n(){}`]|\$\()/);
  for (let i = 0; i < parts.length; i += 2) {
    const segment = parts[i].trim();
    if (!segment) continue;
    const base = commandBaseName(segment);
    if (!base || !REPL_COMMAND_NAMES.has(base)) continue;
    // An interpreter on the receiving end of a pipe reads the pipe, not a TTY.
    if (parts[i - 1] === "|") continue;
    const args = segmentWords(segment).slice(1);
    if (args.length === 0 || args.every((a) => INTERACTIVE_ONLY_FLAGS.has(a.toLowerCase()))) {
      return segment;
    }
  }
  return null;
}

/**
 * Replace `<<TAG ... TAG` heredoc bodies with a placeholder so shell-segment
 * scanners do not treat script lines as commands. The redirection itself is
 * kept so the interpreter segment still shows it has stdin.
 */
export function stripHeredocBodies(command) {
  return command.replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g,
    "<<$2 HEREDOC$3",
  );
}

/**
 * Command names (PowerShell and POSIX, incl. aliases) that delete files.
 * Compared against the first word of each shell segment, basename only.
 */
const DELETE_COMMAND_NAMES = new Set(["rm", "rmdir", "rd", "del", "erase", "unlink", "shred", "trash", "remove-item", "ri"]);

/**
 * Best-effort detection of file-deletion commands. Splits the command line
 * into segments at shell separators and checks the leading word of each.
 * Catches `rm`/`del`/`Remove-Item` variants, `git rm`/`git clean`, and
 * `find ... -delete`; it cannot catch every escape hatch (inline scripts),
 * so the system prompt carries the same rule for the model.
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

/** PowerShell common parameters that take a value (not a file path). */
const PS_PARAMS_WITH_VALUE = new Set(["-erroraction", "-ea", "-warningaction", "-wa", "-informationaction", "-ia"]);

/** Bare PowerShell action names that are not deletion targets. */
const PS_ACTION_VALUES = new Set(["silentlycontinue", "continue", "stop", "inquire", "ignore", "suspend", "break"]);

/**
 * File/directory arguments of a deletion segment: everything that is not a
 * flag, with quotes and `./` prefixes stripped. `find … -delete` reports no
 * targets because it deletes whatever a search matches.
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
 * - `protected`: a target is named in the goal with protective language.
 * - `unauthorized`: a target the user never named (or too broad to name).
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
// On POSIX prefer bash over /bin/sh: models write bash (process substitution,
// [[ ]], arrays), and on Debian-family images /bin/sh is dash, which rejects
// those with "Syntax error: "(" unexpected" — a wasted step every time.
const IS_WINDOWS = process.platform === "win32";
const POSIX_SHELL = IS_WINDOWS ? null : pickPosixShell();
const SHELL_NAME = IS_WINDOWS ? "PowerShell" : POSIX_SHELL;

function pickPosixShell() {
  for (const candidate of ["/bin/bash", "/usr/bin/bash"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "/bin/sh";
}

/**
 * Adapt bash-style && chains to PowerShell ; separators on Windows.
 * @param {string} command
 * @param {{ platform?: string }} [options]
 * @returns {{command: string, adapted: boolean, note?: string}}
 */
export function adaptPowerShellCommand(command, { platform = process.platform } = {}) {
  const text = String(command ?? "");
  if (platform !== "win32") return { command: text, adapted: false };
  if (!/\s&&\s/.test(text)) return { command: text, adapted: false };
  return { command: text.replace(/\s&&\s/g, "; "), adapted: true, note: "Adapted && to ; for PowerShell." };
}

/**
 * @param {import("../tool-registry.mjs").ToolRegistry} registry
 * @param {object} options
 * @param {string} options.workspaceRoot Directory commands run in.
 */
export function registerShellTools(registry, { workspaceRoot }) {
  const spill = createOutputSpiller({ workspaceRoot });

  registry.register({
    name: "run_command",
    requiresApproval: true,
    description:
      `Run a command through the system shell (${SHELL_NAME}; use ${IS_WINDOWS ? "PowerShell" : POSIX_SHELL.endsWith("bash") ? "bash" : "POSIX sh"} syntax) ` +
      "in the workspace directory and return its status, exit code, stdout, and stderr. " +
      "Commands run with no input, so never launch a bare interpreter or shell (node, python, bash) " +
      "without a script or inline code. " +
      `Commands are killed after the timeout (default ${DEFAULT_TIMEOUT_SECONDS}s). ` +
      "For servers that must keep running, start them in the background " +
      "(`nohup cmd >server.log 2>&1 &` on POSIX, or Start-Process on Windows) and check them with a short command. " +
      "Long output is saved to a file and returned as head + tail + path.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to execute." },
        cwd: { type: "string", description: "Working directory relative to the workspace root. Defaults to the root." },
        timeout_seconds: {
          type: "integer",
          description: `Kill the command after this many seconds (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}).`,
        },
      },
      required: ["command"],
    },
    async execute({ command, cwd, timeout_seconds }) {
      if (!command || !String(command).trim()) throw new Error("command must not be empty.");
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
      const { command: shellCommand, adapted, note: adaptNote } = adaptPowerShellCommand(command);
      // Deletion gate for unattended runs. An approved call (ask-mode yes,
      // or --auto-approve) skips it — the user already allowed this call.
      if (!registry.callApproved) {
        const { verdict, segment, target } = classifyDeleteCommand(command, registry.runContext?.goal);
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
              "Do not retry rm/del/Remove-Item or work around this check. Prefer leaving temporary " +
              "files in place, overwriting with the next write (e.g. aria2c --allow-overwrite=true, " +
              "cp/mv onto the path), or writing to a new name. If the task truly requires deleting " +
              "those paths, stop and ask the user in your final answer to confirm the exact targets.",
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
      const requestedMs =
        Math.min(Math.max(1, timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS) * 1000;
      const fit = fitTimeoutToDeadline({ requestedMs, deadlineAt: registry.runContext?.deadlineAt });
      if (fit.exhausted) {
        throw new Error(
          `Only ${Math.round(fit.remainingMs / 1000)}s of this run's wall-clock budget remain — ` +
            "there is no time for another command to finish and be acted on. Give your final answer now.",
        );
      }
      const clampNote = fit.clamped
        ? `timeout_seconds was clamped from ${Math.round(requestedMs / 1000)}s to ${Math.round(fit.timeoutMs / 1000)}s: ` +
          `only ${Math.round(fit.remainingMs / 1000)}s of the run's wall-clock budget remain.`
        : null;
      const result = await runCommand(shellCommand, { cwd: dir, timeoutMs: fit.timeoutMs });
      result.stdout = await spill(result.stdout, "stdout");
      result.stderr = await spill(result.stderr, "stderr");
      const notes = [adapted ? adaptNote : null, clampNote].filter(Boolean);
      if (notes.length) result.note = notes.join(" ");
      return result;
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
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `${command}; exit $LASTEXITCODE`],
          { cwd, windowsHide: true },
        )
      : spawn(command, {
          cwd,
          shell: POSIX_SHELL,
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
        ? `TIMED OUT after ${Math.round(timeoutMs / 1000)}s and was killed`
        : code === 0
          ? "success"
          : `FAILED with exit code ${code}`;
      resolve({ status, exitCode: code, timedOut, stdout, stderr });
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
