#!/usr/bin/env node
/**
 * On-demand recognized (public) benchmarks — separate from `npm run bench`.
 *
 *   node evals/recognized/run.mjs --list
 *   node evals/recognized/run.mjs --check
 *   node evals/recognized/run.mjs terminal-bench
 *   node evals/recognized/run.mjs tb --dataset 2.1 --include openssl-selfsigned-cert
 *   node evals/recognized/run.mjs terminal-bench --from-job path/to/harbor/job
 *
 * Harbor scores hidden tests. The Cursor CLI then judges each trial the same
 * way the dev bench does. Writes report.json + report.md under
 * ../halo-agent-benchmark/recognized/<suite>/<run-id>/.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadRecognizedOptions } from "./config.mjs";
import {
  buildHarborArgs,
  buildHarborEnv,
  commandExists,
  findHarbor,
  ollamaUrlForContainer,
  runHarborProcess,
} from "./harbor.mjs";
import { judgeHarborTask } from "./judge.mjs";
import {
  latestReportPaths,
  reportPaths,
  runDirectory,
  timestampRunId,
} from "./layout.mjs";
import { parseHarborJob, resolveJobDir, summarizeTasks } from "./parse.mjs";
import {
  buildRecognizedReport,
  formatRecognizedConsole,
  formatRecognizedMarkdown,
} from "./report.mjs";
import { listSuites, resolveDataset, resolveSuite } from "./registry.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGE_VERSION = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
).version;

function printHelp() {
  console.log(`halo-agent recognized benchmarks

Usage:
  node evals/recognized/run.mjs --list
  node evals/recognized/run.mjs --check
  node evals/recognized/run.mjs <suite> [options]
  node evals/recognized/run.mjs <suite> --from-job <harbor-job-dir>

This is not the development bench (npm run bench). Suites here are public
leaderboard tasks, run on demand.

Suites:
${listSuites()
  .map((s) => `  ${s.id.padEnd(22)} ${s.status.padEnd(8)} ${s.title}`)
  .join("\n")}

Options:
  --dataset <id>         2.1 (default), 2.0, 1.0, 3.0, or a raw Harbor dataset id
  --model, -m <name>     Ollama model (default: auto)
  --base-url <url>       Host Ollama URL (rewritten to host.docker.internal in Docker)
  --include, -i <glob>   Harbor task name glob (repeatable or comma-separated)
  --exclude, -x <glob>   Exclude task names
  --n-concurrent <n>     Parallel Harbor trials (default 1)
  --attempts, -k <n>     Attempts per task (default 1)
  --max-steps <n>        halo-agent loop cap (default 80)
  --skip-judge           Harbor tests only; skip Cursor CLI grading
  --judge-model <name>   Cursor CLI model (default auto)
  --from-job <dir>       Parse an existing Harbor job and (re)judge; do not run Harbor
  --out <dir>            Run directory (default: sibling halo-agent-benchmark/recognized/...)
  --dry-run              Print the Harbor command and exit
  --check                Verify Harbor, Docker, Ollama, Cursor CLI
  --verbose
`);
}

async function main() {
  const argv = process.argv.slice(2);
  let loaded;
  try {
    loaded = await loadRecognizedOptions(argv);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  const { options, configPath } = loaded;

  if (options.help || argv.length === 0) {
    printHelp();
    return;
  }
  if (options.list) {
    printList();
    return;
  }
  if (options.check) {
    const ok = await runChecks(options);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const suite = resolveSuite(options.suite);
  if (!suite) {
    console.error(`Unknown suite '${options.suite ?? ""}'. Use --list.`);
    process.exitCode = 1;
    return;
  }
  if (suite.status !== "ready") {
    console.error(
      `${suite.title} is catalogued but not wired yet. Start with: node evals/recognized/run.mjs terminal-bench`,
    );
    process.exitCode = 1;
    return;
  }

  let dataset;
  try {
    dataset = resolveDataset(suite, options.dataset);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  if (configPath) console.error(`config: ${configPath}`);
  console.error(`suite: ${suite.title} (${dataset.label ?? dataset.id})`);
  console.error("This is a recognized public benchmark, not the development bench.");

  const ranAt = new Date().toISOString();
  const runId = timestampRunId(ranAt);
  const runDir = options.out
    ? path.resolve(options.out)
    : runDirectory(suite.id, runId);

  let harborJobDir = options.fromJob ? await resolveJobDir(options.fromJob) : path.join(runDir, options.jobName ?? "harbor");
  let harborCode = 0;

  if (!options.fromJob) {
    const harbor = findHarbor() ?? (options.dryRun ? { bin: "harbor", argsPrefix: [] } : null);
    if (!harbor) {
      console.error(
        "Harbor is not installed. Install it, then re-run:\n  uv tool install harbor\n  pip install harbor",
      );
      process.exitCode = 1;
      return;
    }
    if (!options.dryRun && !commandExists("docker")) {
      console.error("Docker is required for Terminal-Bench (Harbor environments). Start Docker Desktop and retry.");
      process.exitCode = 1;
      return;
    }
    const jobName = options.jobName ?? "harbor";
    harborJobDir = path.join(runDir, jobName);
    const args = buildHarborArgs({
      datasetId: dataset.id,
      model: options.model,
      jobsDir: runDir,
      jobName,
      repoRoot: REPO_ROOT,
      containerBaseUrl: ollamaUrlForContainer(options.baseUrl),
      nConcurrent: options.nConcurrent,
      nAttempts: options.nAttempts,
      maxSteps: options.maxSteps,
      numCtx: options.numCtx,
      commandTimeoutSeconds: options.commandTimeoutSeconds,
      maxCommandTimeoutSeconds: options.maxCommandTimeoutSeconds,
      timeoutMultiplier: options.timeoutMultiplier,
      includeTaskNames: options.includeTaskNames,
      excludeTaskNames: options.excludeTaskNames,
      agentVersion: PACKAGE_VERSION,
    });
    const env = buildHarborEnv({
      repoRoot: REPO_ROOT,
      agentVersion: PACKAGE_VERSION,
      model: options.model,
      containerBaseUrl: ollamaUrlForContainer(options.baseUrl),
    });
    if (!options.dryRun) await mkdir(runDir, { recursive: true });
    const result = await runHarborProcess({
      harbor,
      args,
      env,
      cwd: REPO_ROOT,
      dryRun: options.dryRun,
    });
    console.error(`harbor: ${result.command}`);
    if (result.dryRun) return;
    harborCode = result.code;
    if (harborCode !== 0) {
      console.error(`Harbor exited ${harborCode}. Parsing any completed trials.`);
    }
  }

  const parsed = await parseHarborJob(harborJobDir);
  if (parsed.tasks.length === 0) {
    console.error(`No Harbor trials found in ${harborJobDir}.`);
    process.exitCode = 1;
    return;
  }

  if (!options.skipJudge) {
    if (!commandExists("agent")) {
      console.error("Cursor CLI (`agent`) not found. Install it or pass --skip-judge.");
      process.exitCode = 1;
      return;
    }
    let index = 0;
    for (const task of parsed.tasks) {
      index += 1;
      console.error(`  judging ${index}/${parsed.tasks.length} ${task.name}...`);
      try {
        task.verdict = await judgeHarborTask(task, {
          model: options.judgeModel,
          timeoutSeconds: options.judgeTimeoutSeconds,
          retries: options.judgeRetries,
        });
      } catch (err) {
        task.judgeError = err?.message ?? String(err);
        console.error(`  judge failed: ${task.judgeError}`);
      }
    }
  }

  const overall = summarizeTasks(parsed.tasks);
  const report = buildRecognizedReport({
    suite: suite.id,
    suiteTitle: suite.title,
    dataset: dataset.id,
    datasetLabel: dataset.label,
    agent: "halo-agent",
    agentVersion: PACKAGE_VERSION,
    model: options.model,
    judgeModel: options.skipJudge ? null : options.judgeModel,
    harness: "harbor",
    ranAt,
    harborJobDir,
    overall,
    tasks: parsed.tasks,
    environment: {
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      node: process.version,
      cpus: os.cpus().length,
      memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      ollamaBaseUrl: options.baseUrl,
      containerOllama: ollamaUrlForContainer(options.baseUrl),
    },
    notes: [
      "Harbor reward is the shareable mechanical score (hidden tests).",
      "Cursor judge scores are qualitative (process + artifacts), same schema as the development bench.",
      "Ollama must be reachable from Docker (host.docker.internal). On Linux, bind Ollama to 0.0.0.0 if the container cannot connect.",
      "halo-agent command timeouts are raised for this suite via HALO_COMMAND_TIMEOUT / HALO_MAX_COMMAND_TIMEOUT.",
    ],
  });

  console.log(formatRecognizedConsole(report));
  await writeRecognizedReports(report, runDir, suite.id);
  process.exitCode = harborCode === 0 ? 0 : 1;
}

function printList() {
  console.log("Recognized suites (on demand, not npm run bench):\n");
  for (const suite of listSuites()) {
    const datasets = suite.datasets
      ? Object.entries(suite.datasets)
          .map(([alias, spec]) => `${alias}=${spec.id}`)
          .join(", ")
      : "";
    console.log(`  ${suite.id}  [${suite.status}]  ${suite.title}`);
    console.log(`      ${suite.description}`);
    if (datasets) console.log(`      datasets: ${datasets}`);
    if (suite.leaderboard) console.log(`      ${suite.leaderboard}`);
    console.log("");
  }
}

async function runChecks(options) {
  const rows = [];
  const harbor = findHarbor();
  rows.push(["Harbor", harbor ? `${harbor.bin} ${(harbor.argsPrefix ?? []).join(" ")}`.trim() : "MISSING — uv tool install harbor"]);
  rows.push(["Docker", commandExists("docker") ? "ok" : "MISSING"]);
  rows.push(["Cursor CLI (agent)", commandExists("agent") ? "ok" : "MISSING — needed unless --skip-judge"]);
  let ollama = "unreachable";
  try {
    const res = await fetch(`${options.baseUrl.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(3000) });
    ollama = res.ok ? "ok" : `HTTP ${res.status}`;
  } catch (err) {
    ollama = err?.message ?? String(err);
  }
  rows.push(["Ollama", `${ollama} (${options.baseUrl} → ${ollamaUrlForContainer(options.baseUrl)} in Docker)`]);
  for (const [name, value] of rows) {
    console.log(`  ${name.padEnd(22)} ${value}`);
  }
  return Boolean(harbor) && commandExists("docker");
}

async function writeRecognizedReports(report, runDir, suiteId) {
  const paths = reportPaths(runDir);
  await mkdir(runDir, { recursive: true });
  await writeFile(paths.json, JSON.stringify(report, null, 2));
  await writeFile(paths.markdown, formatRecognizedMarkdown(report));
  const latest = latestReportPaths(suiteId);
  await mkdir(path.dirname(latest.json), { recursive: true });
  await writeFile(latest.json, JSON.stringify(report, null, 2));
  await writeFile(latest.markdown, formatRecognizedMarkdown(report));
  console.error(`JSON report: ${paths.json}`);
  console.error(`Markdown report: ${paths.markdown}`);
  console.error(`Latest: ${latest.json}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}

export { main, printHelp };
