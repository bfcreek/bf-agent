/**
 * Config + CLI for recognized (public) benchmarks — separate from the dev bench.
 */

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = path.join(__dirname, "config.json");

/**
 * @typedef {object} RecognizedConfig
 * @property {string} model
 * @property {string} baseUrl
 * @property {string} dataset
 * @property {number} nConcurrent
 * @property {number} nAttempts
 * @property {number} maxSteps
 * @property {number} numCtx
 * @property {number} commandTimeoutSeconds
 * @property {number} maxCommandTimeoutSeconds
 * @property {number} timeoutMultiplier
 * @property {string[]} includeTaskNames
 * @property {string[]} excludeTaskNames
 * @property {number|null} sample
 * @property {number|null} seed
 * @property {boolean} skipJudge
 * @property {string} judgeModel
 * @property {number} judgeTimeoutSeconds
 * @property {number} judgeRetries
 * @property {string|null} out
 * @property {boolean} verbose
 */

/** @returns {RecognizedConfig} */
export function defaultRecognizedConfig() {
  return {
    model: "auto",
    baseUrl: "http://127.0.0.1:11434",
    dataset: "2.1",
    nConcurrent: 1,
    nAttempts: 1,
    maxSteps: 80,
    numCtx: 16384,
    commandTimeoutSeconds: 120,
    maxCommandTimeoutSeconds: 1800,
    timeoutMultiplier: 1,
    includeTaskNames: [],
    excludeTaskNames: [],
    sample: null,
    seed: null,
    skipJudge: false,
    judgeModel: "auto",
    judgeTimeoutSeconds: 300,
    judgeRetries: 2,
    out: null,
    verbose: false,
  };
}

/**
 * @param {string[]} argv
 * @param {string} [cwd]
 */
export async function loadRecognizedOptions(argv, cwd = process.cwd()) {
  const resolved = await resolveConfigPath(argv, cwd);
  const fileConfig = resolved.path ? await loadConfigFile(resolved.path) : defaultRecognizedConfig();
  return {
    options: parseRecognizedArgs(argv, fileConfig),
    configPath: resolved.path,
  };
}

/**
 * @param {string[]} argv
 * @param {string} [cwd]
 */
export async function resolveConfigPath(argv, cwd = process.cwd()) {
  const index = argv.indexOf("--config");
  if (index >= 0) {
    const explicit = argv[index + 1];
    if (!explicit) throw new Error("--config requires a path.");
    return { path: path.resolve(cwd, explicit), explicit: true };
  }
  try {
    await access(DEFAULT_CONFIG_PATH);
    return { path: DEFAULT_CONFIG_PATH, explicit: false };
  } catch {
    return { path: null, explicit: false };
  }
}

/**
 * @param {string} configPath
 */
export async function loadConfigFile(configPath) {
  const base = defaultRecognizedConfig();
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  return { ...base, ...raw, includeTaskNames: raw.includeTaskNames ?? base.includeTaskNames, excludeTaskNames: raw.excludeTaskNames ?? base.excludeTaskNames };
}

/**
 * @param {string[]} argv
 * @param {RecognizedConfig} [fileConfig]
 */
export function parseRecognizedArgs(argv, fileConfig = defaultRecognizedConfig()) {
  /** @type {Record<string, unknown>} */
  const cli = {
    suite: null,
    dataset: null,
    model: null,
    baseUrl: null,
    nConcurrent: null,
    nAttempts: null,
    maxSteps: null,
    numCtx: null,
    commandTimeoutSeconds: null,
    maxCommandTimeoutSeconds: null,
    timeoutMultiplier: null,
    includeTaskNames: null,
    excludeTaskNames: null,
    sample: null,
    seed: null,
    skipJudge: null,
    judgeModel: null,
    judgeTimeoutSeconds: null,
    judgeRetries: null,
    out: null,
    fromJob: null,
    jobName: null,
    verbose: null,
    dryRun: false,
    list: false,
    check: false,
    help: false,
  };

  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => {
      const value = argv[++i];
      if (value == null) throw new Error(`${arg} requires a value.`);
      return value;
    };
    if (arg === "--help" || arg === "-h") cli.help = true;
    else if (arg === "--list") cli.list = true;
    else if (arg === "--check") cli.check = true;
    else if (arg === "--dry-run") cli.dryRun = true;
    else if (arg === "--verbose") cli.verbose = true;
    else if (arg === "--skip-judge") cli.skipJudge = true;
    else if (arg === "--config") i += 1;
    else if (arg === "--dataset") cli.dataset = take();
    else if (arg === "--model" || arg === "-m") cli.model = take();
    else if (arg === "--base-url") cli.baseUrl = take();
    else if (arg === "--n-concurrent" || arg === "--concurrent") cli.nConcurrent = Number.parseInt(take(), 10);
    else if (arg === "--attempts" || arg === "-k") cli.nAttempts = Number.parseInt(take(), 10);
    else if (arg === "--max-steps") cli.maxSteps = Number.parseInt(take(), 10);
    else if (arg === "--num-ctx") cli.numCtx = Number.parseInt(take(), 10);
    else if (arg === "--command-timeout") cli.commandTimeoutSeconds = Number.parseInt(take(), 10);
    else if (arg === "--max-command-timeout") cli.maxCommandTimeoutSeconds = Number.parseInt(take(), 10);
    else if (arg === "--timeout-multiplier") cli.timeoutMultiplier = Number.parseFloat(take());
    else if (arg === "--include" || arg === "--task" || arg === "-i") {
      const names = take()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      cli.includeTaskNames = [...(cli.includeTaskNames ?? []), ...names];
    } else if (arg === "--exclude" || arg === "-x") {
      const names = take()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      cli.excludeTaskNames = [...(cli.excludeTaskNames ?? []), ...names];
    } else if (arg === "--sample") cli.sample = Number.parseInt(take(), 10);
    else if (arg === "--seed") cli.seed = Number.parseInt(take(), 10);
    else if (arg === "--judge-model") cli.judgeModel = take();
    else if (arg === "--judge-timeout") cli.judgeTimeoutSeconds = Number.parseInt(take(), 10);
    else if (arg === "--judge-retries") cli.judgeRetries = Number.parseInt(take(), 10);
    else if (arg === "--out") cli.out = take();
    else if (arg === "--from-job") cli.fromJob = take();
    else if (arg === "--job-name") cli.jobName = take();
    else if (arg.startsWith("-")) {
      throw new Error(`Unknown option '${arg}'.`);
    } else {
      rest.push(arg);
    }
  }

  if (rest.length > 1) {
    throw new Error(`Unexpected extra arguments: ${rest.slice(1).join(", ")}. Pass one suite name.`);
  }

  return {
    suite: rest[0] ?? null,
    dataset: cli.dataset ?? fileConfig.dataset,
    model: cli.model ?? fileConfig.model,
    baseUrl: cli.baseUrl ?? fileConfig.baseUrl,
    nConcurrent: cli.nConcurrent ?? fileConfig.nConcurrent,
    nAttempts: cli.nAttempts ?? fileConfig.nAttempts,
    maxSteps: cli.maxSteps ?? fileConfig.maxSteps,
    numCtx: cli.numCtx ?? fileConfig.numCtx,
    commandTimeoutSeconds: cli.commandTimeoutSeconds ?? fileConfig.commandTimeoutSeconds,
    maxCommandTimeoutSeconds: cli.maxCommandTimeoutSeconds ?? fileConfig.maxCommandTimeoutSeconds,
    timeoutMultiplier: cli.timeoutMultiplier ?? fileConfig.timeoutMultiplier,
    includeTaskNames: cli.includeTaskNames ?? fileConfig.includeTaskNames,
    excludeTaskNames: cli.excludeTaskNames ?? fileConfig.excludeTaskNames,
    sample: cli.sample ?? fileConfig.sample ?? null,
    seed: cli.seed ?? fileConfig.seed ?? null,
    skipJudge: cli.skipJudge ?? fileConfig.skipJudge,
    judgeModel: cli.judgeModel ?? fileConfig.judgeModel,
    judgeTimeoutSeconds: cli.judgeTimeoutSeconds ?? fileConfig.judgeTimeoutSeconds,
    judgeRetries: cli.judgeRetries ?? fileConfig.judgeRetries,
    out: cli.out ?? fileConfig.out,
    fromJob: cli.fromJob,
    jobName: cli.jobName,
    verbose: cli.verbose ?? fileConfig.verbose,
    dryRun: cli.dryRun,
    list: cli.list,
    check: cli.check,
    help: cli.help,
  };
}
