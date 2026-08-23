/**
 * Shell tool: run a command through the system shell, scoped to the
 * workspace. No approval gate yet (roadmap item 8) — the guardrails here are
 * the workspace-bound cwd, a hard timeout, and capped output.
 */

import { spawn } from "node:child_process";

import { resolveWithinRoot, truncateMiddle } from "./fs.mjs";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;

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
