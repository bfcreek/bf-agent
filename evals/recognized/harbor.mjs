/**
 * Locate Harbor and build `harbor run` argv for the halo-agent adapter.
 */

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "adapters");

/**
 * Rewrite loopback Ollama URLs so Docker containers can reach the host.
 * @param {string} baseUrl
 */
export function ollamaUrlForContainer(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  if (["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    url.hostname = "host.docker.internal";
  }
  return url.toString().replace(/\/$/, "");
}

/**
 * Harbor `--include-task-name` uses fnmatch against package ids like
 * `terminal-bench/build-pmars`. Bare folder names do not match.
 *
 * @param {string} name
 */
export function toHarborTaskFilter(name) {
  const raw = String(name ?? "").trim();
  if (!raw || raw.includes("/")) return raw;
  return `*/${raw}`;
}

/**
 * @returns {{bin: string, argsPrefix: string[]}|null}
 */
export function findHarbor() {
  if (process.env.HARBOR_BIN) {
    return { bin: process.env.HARBOR_BIN, argsPrefix: [] };
  }
  const harbor = resolveCommandPath("harbor");
  if (harbor) return { bin: harbor, argsPrefix: [] };
  const uvx = resolveCommandPath("uvx");
  if (uvx) return { bin: uvx, argsPrefix: ["harbor"] };
  return null;
}

/**
 * @param {object} input
 * @param {string} input.datasetId
 * @param {string} input.model
 * @param {string} input.jobsDir
 * @param {string} input.jobName
 * @param {string} input.repoRoot
 * @param {string} input.containerBaseUrl
 * @param {string} [input.provider] ollama | openai | anthropic
 * @param {number} [input.nConcurrent]
 * @param {number} [input.nAttempts]
 * @param {number} [input.maxSteps]
 * @param {number|"auto"} [input.numCtx] Explicit window, or auto (default).
 * @param {number} [input.commandTimeoutSeconds]
 * @param {number} [input.maxCommandTimeoutSeconds]
 * @param {number} [input.timeoutMultiplier]
 * @param {string[]} [input.includeTaskNames]
 * @param {string[]} [input.excludeTaskNames]
 * @param {string} [input.agentVersion]
 */
export function buildHarborArgs(input) {
  const provider = String(input.provider ?? "ollama").trim().toLowerCase() || "ollama";
  const args = [
    "run",
    "-d",
    input.datasetId,
    "-a",
    "halo_agent:HaloAgent",
    "-m",
    input.model,
    "--jobs-dir",
    input.jobsDir,
    "--job-name",
    input.jobName,
    "--n-concurrent",
    String(input.nConcurrent ?? 1),
    "-k",
    String(input.nAttempts ?? 1),
    "--timeout-multiplier",
    String(input.timeoutMultiplier ?? 1),
    "--artifact",
    "/app",
  ];
  for (const name of input.includeTaskNames ?? []) {
    args.push("--include-task-name", toHarborTaskFilter(name));
  }
  for (const name of input.excludeTaskNames ?? []) {
    args.push("--exclude-task-name", toHarborTaskFilter(name));
  }
  // Harbor parses `--ak key=value` with the value as a JSON/Python literal, so
  // bare integers arrive typed. (An older `key:int=value` spelling made the
  // suffix part of the key, and every kwarg silently fell back to the
  // adapter's default — num_ctx among them.)
  // Strings for provider must be JSON-quoted so Harbor does not treat them as names.
  args.push(
    "--ak",
    `max_steps=${input.maxSteps ?? 80}`,
    // 0 = auto: the CLI sizes the window to the model and the Ollama host's
    // memory (passed in through buildHarborEnv). Ignored for openai/anthropic.
    "--ak",
    `num_ctx=${typeof input.numCtx === "number" && input.numCtx > 0 ? input.numCtx : 0}`,
    "--ak",
    `command_timeout=${input.commandTimeoutSeconds ?? 120}`,
    "--ak",
    `max_command_timeout=${input.maxCommandTimeoutSeconds ?? 1800}`,
    "--ak",
    `provider=${JSON.stringify(provider)}`,
  );
  return args;
}

/**
 * Env for the Harbor process so the Python adapter can find this repo.
 * @param {object} input
 * @param {{totalMemBytes?: number, vramBytes?: number}} [input.hostMemory]
 *   This machine's memory, where Ollama runs. The adapter forwards it into
 *   the task container so the CLI's model routing and context sizing judge
 *   fit against the host rather than the container's own limits.
 */
export function buildHarborEnv(input) {
  const env = { ...process.env };
  const provider = String(input.provider ?? "ollama").trim().toLowerCase() || "ollama";
  env.PYTHONPATH = env.PYTHONPATH
    ? `${ADAPTER_DIR}${path.delimiter}${env.PYTHONPATH}`
    : ADAPTER_DIR;
  env.HALO_AGENT_REPO = input.repoRoot;
  env.HALO_AGENT_VERSION = input.agentVersion ?? "0.1.0";
  env.HALO_AGENT_MODEL = input.model;
  env.HALO_AGENT_PROVIDER = provider;
  if (input.containerBaseUrl) {
    env.HALO_AGENT_BASE_URL = input.containerBaseUrl;
  }
  // Peer API keys: prefer process env already present; adapter forwards into
  // the task container. Do not invent keys here.
  const mem = input.hostMemory ?? {};
  if (Number.isFinite(mem.totalMemBytes) && mem.totalMemBytes > 0) {
    env.HALO_HOST_TOTAL_MEM_BYTES = String(Math.round(mem.totalMemBytes));
  }
  if (Number.isFinite(mem.vramBytes) && mem.vramBytes >= 0) {
    env.HALO_HOST_VRAM_BYTES = String(Math.round(mem.vramBytes));
  }
  // The adapter derives the agent's wall-clock budget from the task's
  // [agent] timeout_sec; Harbor scales that by the multiplier, so must we.
  env.HALO_AGENT_TIMEOUT_MULTIPLIER = String(input.timeoutMultiplier ?? 1);
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  return env;
}

/**
 * Base URL the agent container should call for LLM traffic.
 * Ollama on the host needs host.docker.internal; OpenAI/Anthropic use the
 * public API (or an explicit custom base URL) and must not be rewritten.
 *
 * @param {string} baseUrl
 * @param {string} [provider]
 */
export function llmUrlForContainer(baseUrl, provider = "ollama") {
  const name = String(provider ?? "ollama").trim().toLowerCase();
  if (name === "openai" || name === "anthropic") {
    const raw = String(baseUrl ?? "").trim();
    // Default config still points at local Ollama — ignore that for cloud peers.
    if (!raw || /127\.0\.0\.1|localhost|::1|host\.docker\.internal/i.test(raw)) {
      return "";
    }
    return raw.replace(/\/$/, "");
  }
  return ollamaUrlForContainer(baseUrl);
}

/**
 * @param {string[]} args
 * @param {object} options
 */
export async function runHarborProcess({ harbor, args, env, cwd, dryRun }) {
  const argv = [...(harbor.argsPrefix ?? []), ...args];
  const printable = [harbor.bin, ...argv].map(quoteArg).join(" ");
  if (dryRun) {
    return { code: 0, dryRun: true, command: printable };
  }
  const code = await spawnInherit(harbor.bin, argv, { cwd, env });
  return { code, dryRun: false, command: printable };
}

export function commandExists(name) {
  return resolveCommandPath(name) != null;
}

/**
 * Absolute path to the first match of `name` on PATH, or null.
 * On Windows this prefers a real binary (`.exe`) over a shim when both appear.
 * @param {string} name
 * @returns {string|null}
 */
export function resolveCommandPath(name) {
  if (!name) return null;
  if (path.isAbsolute(name)) return name;
  const probe =
    process.platform === "win32"
      ? spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true })
      : spawnSync("which", [name], { encoding: "utf8" });
  if (probe.status !== 0) return null;
  const hits = String(probe.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (hits.length === 0) return null;
  if (process.platform === "win32") {
    const exe = hits.find((hit) => /\.(exe|com)$/i.test(hit));
    if (exe) return exe;
  }
  return hits[0];
}

/**
 * Windows can spawn `.exe` / `.com` directly. `.cmd` / `.bat` / `.ps1` still
 * need `cmd.exe`. Routing every Harbor call through `cmd.exe` has failed with
 * `spawn cmd.exe EACCES` in some Windows terminals, so prefer a direct spawn.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {{command: string, args: string[], shell?: boolean}}
 */
export function buildHarborSpawn(command, args) {
  if (process.platform !== "win32") return { command, args };
  const resolved = resolveCommandPath(command) ?? command;
  if (/\.(cmd|bat|ps1)$/i.test(resolved)) {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", resolved, ...args],
    };
  }
  return { command: resolved, args };
}

function quoteArg(value) {
  if (/[\s"]/.test(value)) return `"${String(value).replaceAll('"', '\\"')}"`;
  return String(value);
}

function spawnInherit(command, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const spawnSpec = buildHarborSpawn(command, args);
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd,
      env,
      stdio: "inherit",
      windowsHide: true,
      shell: false,
    });
    child.on("error", (err) => {
      if (err?.code === "EACCES") {
        reject(
          new Error(
            `Failed to start '${spawnSpec.command}' (EACCES). ` +
              `If this is cmd.exe, the Terminal-Bench launcher now prefers harbor.exe directly — ` +
              `set HARBOR_BIN to the full path of harbor.exe and retry.`,
            { cause: err },
          ),
        );
        return;
      }
      reject(err);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}
