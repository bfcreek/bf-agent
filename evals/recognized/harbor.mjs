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
  for (const candidate of ["harbor", "uvx"]) {
    if (commandExists(candidate === "uvx" ? "uvx" : "harbor")) {
      if (candidate === "uvx") return { bin: "uvx", argsPrefix: ["harbor"] };
      return { bin: "harbor", argsPrefix: [] };
    }
  }
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
  args.push(
    "--ak",
    `max_steps=${input.maxSteps ?? 80}`,
    // 0 = auto: the CLI sizes the window to the model and the Ollama host's
    // memory (passed in through buildHarborEnv).
    "--ak",
    `num_ctx=${typeof input.numCtx === "number" && input.numCtx > 0 ? input.numCtx : 0}`,
    "--ak",
    `command_timeout=${input.commandTimeoutSeconds ?? 120}`,
    "--ak",
    `max_command_timeout=${input.maxCommandTimeoutSeconds ?? 1800}`,
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
  env.PYTHONPATH = env.PYTHONPATH
    ? `${ADAPTER_DIR}${path.delimiter}${env.PYTHONPATH}`
    : ADAPTER_DIR;
  env.HALO_AGENT_REPO = input.repoRoot;
  env.HALO_AGENT_VERSION = input.agentVersion ?? "0.1.0";
  env.HALO_AGENT_MODEL = input.model;
  env.HALO_AGENT_BASE_URL = input.containerBaseUrl;
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
  const probe = process.platform === "win32" ? ["where.exe", [name]] : ["which", [name]];
  const result = spawnSync(probe[0], probe[1], { encoding: "utf8", windowsHide: true });
  return result.status === 0;
}

function quoteArg(value) {
  if (/[\s"]/.test(value)) return `"${String(value).replaceAll('"', '\\"')}"`;
  return String(value);
}

function spawnInherit(command, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const spawnSpec =
      process.platform === "win32"
        ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command, ...args] }
        : { command, args };
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
