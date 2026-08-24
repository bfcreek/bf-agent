/**
 * Load and merge bench configuration: bench.config.json + CLI overrides.
 */

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = path.join(__dirname, "bench.config.json");
export const CWD_CONFIG_NAME = "bench.config.json";
/**
 * @typedef {object} BenchConfig
 * @property {string[]} models
 * @property {string} baseUrl
 * @property {number} maxSteps
 * @property {number} timeoutSeconds
 * @property {string} judgeModel
 * @property {number} judgeTimeoutSeconds
 * @property {{enabled: boolean, stopBelowScore: number|null, maxTier: number|null}} progression
 * @property {import("./gates.mjs").defaultGatesConfig extends () => infer T ? T : never} gates
 * @property {boolean} enforceGates
 * @property {string|null} gatePreset
 * @property {boolean} skipJudge
 * @property {boolean} keepWorkspace
 * @property {boolean} verbose
 * @property {boolean} planning
 * @property {boolean} taskHints
 * @property {number} judgeRetries
 * @property {string|null} [scenario]
 * @property {string[]|null} [scenarios]
 * @property {string} checkpointPath
 * @property {{json: string|null, markdown: string|null, capability: string|null, public: string|null}} report
 */

import { defaultGatesConfig } from "./gates.mjs";
import { DEFAULT_CHECKPOINT_REL } from "./checkpoint.mjs";

/** @returns {BenchConfig} */
export function defaultConfig() {
  return {
    models: ["auto"],
    baseUrl: "http://127.0.0.1:11434",
    maxSteps: 15,
    timeoutSeconds: 240,
    judgeModel: "auto",
    judgeTimeoutSeconds: 300,
    progression: { enabled: true, stopBelowScore: 50, maxTier: 5 },
    gates: defaultGatesConfig(),
    enforceGates: false,
    gatePreset: null,
    skipJudge: false,
    keepWorkspace: false,
    verbose: false,
    planning: false,
    taskHints: true,
    judgeRetries: 2,
    scenario: null,
    scenarios: null,
    checkpointPath: DEFAULT_CHECKPOINT_REL,
    report: {
      json: "bench-latest.json",
      markdown: "bench-latest.md",
      capability: "bench-capability.json",
      public: "bench-public.json",
    },
  };
}

/**
 * Pick a config file path. Explicit --config wins; otherwise use the first
 * existing file from cwd/bench.config.json, then evals/bench.config.json.
 *
 * @param {string[]} argv
 * @param {string} [cwd]
 * @returns {Promise<{path: string|null, explicit: boolean}>}
 */
export async function resolveBenchConfigPath(argv, cwd = process.cwd()) {
  const configIndex = argv.indexOf("--config");
  if (configIndex >= 0) {
    const explicit = argv[configIndex + 1];
    if (!explicit) throw new Error("--config requires a path.");
    return { path: path.resolve(explicit), explicit: true };
  }

  const candidates = [path.join(cwd, CWD_CONFIG_NAME), DEFAULT_CONFIG_PATH];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return { path: candidate, explicit: false };
    } catch {
      // try next candidate
    }
  }

  return { path: null, explicit: false };
}

/**
 * @param {string} configPath
 * @returns {Promise<BenchConfig>}
 */
export async function loadBenchConfig(configPath) {
  const base = defaultConfig();
  try {
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    return mergeConfig(base, raw);
  } catch (err) {
    if (err.code === "ENOENT") return base;
    throw new Error(`Failed to load config ${configPath}: ${err.message}`);
  }
}

/**
 * Resolve config file (if any), merge with built-in defaults, then apply CLI.
 *
 * @param {string[]} argv
 * @param {string} [cwd]
 */
export async function loadBenchOptions(argv, cwd = process.cwd()) {
  const resolved = await resolveBenchConfigPath(argv, cwd);
  const fileConfig = resolved.path ? await loadBenchConfig(resolved.path) : defaultConfig();
  const options = parseCliArgs(argv, fileConfig);
  return { options, configPath: resolved.path, configExplicit: resolved.explicit };
}

/**
 * @param {BenchConfig} base
 * @param {Partial<BenchConfig>} patch
 */
function mergeConfig(base, patch) {
  return {
    ...base,
    ...patch,
    progression: { ...base.progression, ...patch.progression },
    gates: { ...base.gates, ...patch.gates },
    report: { ...base.report, ...patch.report },
  };
}

/**
 * @param {string[]} argv
 * @param {BenchConfig} [fileConfig]
 */
export function parseCliArgs(argv, fileConfig = defaultConfig()) {
  /** @type {Record<string, unknown>} */
  const cli = {
    configPath: null,
    models: null,
    baseUrl: null,
    maxSteps: null,
    timeoutSeconds: null,
    scenarioFilter: null,
    scenarioList: null,
    maxTier: null,
    minTier: null,
    progression: null,
    stopBelowScore: null,
    json: null,
    markdown: null,
    verbose: null,
    keepWorkspace: null,
    skipJudge: null,
    judgeOnly: null,
    judgeModel: null,
    judgeTimeoutSeconds: null,
    judgeRetries: null,
    planning: null,
    taskHints: null,
    enforceGates: null,
    gatePreset: null,
    capabilityJson: null,
    publicJson: null,
    checkpointPath: null,
    flat: false,
    noReport: false,
    resume: false,
    reset: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") {
      cli.configPath = argv[++i];
    } else if (arg === "--models" || arg === "--model") {
      cli.models = (argv[++i] ?? "").split(",").map((m) => m.trim()).filter(Boolean);
    } else if (arg === "--base-url") cli.baseUrl = argv[++i];
    else if (arg === "--max-steps") cli.maxSteps = Number.parseInt(argv[++i], 10);
    else if (arg === "--timeout") cli.timeoutSeconds = Number.parseInt(argv[++i], 10);
    else if (arg === "--scenario") {
      const name = argv[++i];
      if (!name) throw new Error("--scenario requires a name. Use --list-scenarios to see options.");
      cli.scenarioFilter = name;
    } else if (arg === "--scenarios") {
      const raw = argv[++i];
      if (!raw) throw new Error("--scenarios requires a comma-separated list of names.");
      cli.scenarioList = raw.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--list-scenarios") {
      // handled in dev-bench.mjs before loadBenchOptions
    } else if (arg === "--tier") cli.maxTier = Number.parseInt(argv[++i], 10);
    else if (arg === "--min-tier") cli.minTier = Number.parseInt(argv[++i], 10);
    else if (arg === "--progression") cli.progression = true;
    else if (arg === "--no-progression" || arg === "--flat") cli.flat = true;
    else if (arg === "--stop-below") cli.stopBelowScore = Number.parseInt(argv[++i], 10);
    else if (arg === "--json") cli.json = argv[++i];
    else if (arg === "--markdown") cli.markdown = argv[++i];
    else if (arg === "--no-report") cli.noReport = true;
    else if (arg === "--verbose") cli.verbose = true;
    else if (arg === "--keep-workspace") cli.keepWorkspace = true;
    else if (arg === "--skip-judge") cli.skipJudge = true;
    else if (arg === "--judge-only") cli.judgeOnly = argv[++i];
    else if (arg === "--judge-model") cli.judgeModel = argv[++i];
    else if (arg === "--judge-timeout") cli.judgeTimeoutSeconds = Number.parseInt(argv[++i], 10);
    else if (arg === "--judge-retries") cli.judgeRetries = Number.parseInt(argv[++i], 10);
    else if (arg === "--planning") cli.planning = true;
    else if (arg === "--no-planning") cli.planning = false;
    else if (arg === "--no-hints") cli.taskHints = false;
    else if (arg === "--enforce-gates") cli.enforceGates = true;
    else if (arg === "--gate") {
      const preset = argv[++i];
      if (!preset || !["built-in", "publish"].includes(preset)) {
        throw new Error("--gate requires 'built-in' or 'publish'.");
      }
      cli.gatePreset = preset;
      cli.enforceGates = true;
    } else if (arg === "--capability-json") cli.capabilityJson = argv[++i];
    else if (arg === "--public-json") cli.publicJson = argv[++i];
    else if (arg === "--checkpoint") cli.checkpointPath = argv[++i];
    else if (arg === "--resume") cli.resume = true;
    else if (arg === "--reset") cli.reset = true;
    else throw new Error(`Unknown option '${arg}'.`);
  }

  const progressionEnabled = cli.flat
    ? false
    : cli.progression ?? fileConfig.progression.enabled;

  return {
    configPath: cli.configPath ?? null,
    models: cli.models ?? fileConfig.models,
    baseUrl: cli.baseUrl ?? fileConfig.baseUrl,
    maxSteps: cli.maxSteps ?? fileConfig.maxSteps,
    timeoutSeconds: cli.timeoutSeconds ?? fileConfig.timeoutSeconds,
    scenarioFilter: cli.scenarioFilter ?? fileConfig.scenario ?? null,
    scenarioList: cli.scenarioList ?? fileConfig.scenarios,
    maxTier: cli.maxTier ?? fileConfig.progression.maxTier,
    minTier: cli.minTier ?? null,
    progression: progressionEnabled,
    stopBelowScore:
      cli.stopBelowScore ??
      (fileConfig.progression.stopBelowScore != null ? fileConfig.progression.stopBelowScore : null),
    json: cli.noReport ? null : cli.json ?? fileConfig.report.json,
    markdown: cli.noReport ? null : cli.markdown ?? fileConfig.report.markdown,
    verbose: cli.verbose ?? fileConfig.verbose,
    keepWorkspace: cli.keepWorkspace ?? fileConfig.keepWorkspace,
    skipJudge: cli.skipJudge ?? fileConfig.skipJudge,
    judgeOnly: cli.judgeOnly,
    judgeModel: cli.judgeModel ?? fileConfig.judgeModel,
    judgeTimeoutSeconds: cli.judgeTimeoutSeconds ?? fileConfig.judgeTimeoutSeconds,
    judgeRetries: cli.judgeRetries ?? fileConfig.judgeRetries,
    planning: cli.planning ?? fileConfig.planning,
    taskHints: cli.taskHints ?? fileConfig.taskHints,
    gates: fileConfig.gates,
    enforceGates: cli.enforceGates ?? fileConfig.enforceGates,
    gatePreset: cli.gatePreset ?? fileConfig.gatePreset,
    capabilityJson: cli.noReport ? null : cli.capabilityJson ?? fileConfig.report.capability,
    publicJson: cli.noReport ? null : cli.publicJson ?? fileConfig.report.public,
    checkpointPath: cli.checkpointPath ?? fileConfig.checkpointPath,
    resume: cli.resume,
    reset: cli.reset,
  };
}
