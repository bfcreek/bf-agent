#!/usr/bin/env node
/**
 * Development benchmark: run halo-agent on tiered scenarios, then grade with
 * the Cursor CLI agent (default model: auto).
 *
 *   npm run bench
 *   node evals/dev-bench.mjs --tier 3          # auto-loads bench.config.json if present
 *   node evals/dev-bench.mjs --flat              # all scenarios, no tier pauses
 *   node evals/dev-bench.mjs --scenario greet-module --keep-workspace
 *   node evals/dev-bench.mjs --list-scenarios
 *   node evals/dev-bench.mjs --skip-judge
 *
 * Requires: Ollama + a tool model for halo-agent; Cursor CLI (`agent`) for judging.
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAgent } from "../src/index.mjs";
import { OllamaClient } from "../src/ollama-client.mjs";
import { resolveModelAuto } from "../src/model-routing.mjs";
import { loadBenchOptions } from "./config.mjs";
import {
  buildCapabilityProfile,
  buildPublicBenchmark,
  evaluateGates,
} from "./gates.mjs";
import { captureIntegritySnapshot, checkScenarioIntegrity } from "./integrity.mjs";
import { judgeRun } from "./judge.mjs";
import { buildAssessmentReport, formatReportConsole, formatReportMarkdown } from "./report.mjs";
import { SCENARIOS, agentAnswerText, selectScenarios } from "./scenarios.mjs";
import { removeWorkspaceDir } from "./workspace-cleanup.mjs";

const PACKAGE_VERSION = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;

function validateScenarioSelection(options) {
  if (options.scenarioFilter) {
    const known = SCENARIOS.some((s) => s.name === options.scenarioFilter);
    if (!known) {
      console.error(
        `Unknown scenario '${options.scenarioFilter}'. Available: ${SCENARIOS.map((s) => s.name).join(", ")}`,
      );
      process.exit(1);
    }
  }
  if (options.scenarioList?.length) {
    const names = new Set(SCENARIOS.map((s) => s.name));
    const unknown = options.scenarioList.filter((name) => !names.has(name));
    if (unknown.length > 0) {
      console.error(
        `Unknown scenario(s): ${unknown.join(", ")}. Available: ${SCENARIOS.map((s) => s.name).join(", ")}`,
      );
      process.exit(1);
    }
  }
}

function groupByTier(scenarios) {
  const tiers = new Map();
  for (const scenario of scenarios) {
    if (!tiers.has(scenario.tier)) tiers.set(scenario.tier, []);
    tiers.get(scenario.tier).push(scenario);
  }
  return [...tiers.entries()].sort((a, b) => a[0] - b[0]);
}

function tierAverage(results) {
  const judged = results.filter((r) => r.verdict);
  if (judged.length === 0) return null;
  return judged.reduce((sum, r) => sum + r.verdict.score, 0) / judged.length;
}

async function runScenario({ scenario, model, options }) {
  const dir = options.judgeOnly ?? (await mkdtemp(path.join(os.tmpdir(), "halo-bench-")));
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutSeconds = scenario.timeoutSeconds ?? options.timeoutSeconds;
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

  /** @type {import("../src/agent-loop.mjs").AgentRunResult} */
  let agentResult = {
    text: "(judge-only run — no agent execution)",
    stopReason: "completed",
    steps: [],
    messages: [],
  };

  /** @type {{pass: boolean|null, detail: string}} */
  let integrity = { pass: null, detail: "no integrity rules" };

  try {
    if (!options.judgeOnly) {
      await scenario.setup(dir);
      const integrityBefore = scenario.integrity
        ? await captureIntegritySnapshot(dir)
        : null;

      const agent = await createAgent({
        model,
        baseUrl: options.baseUrl,
        workspaceRoot: dir,
        maxSteps: scenario.maxSteps ?? options.maxSteps,
        projectIndex: false,
        planning: options.planning,
        taskHints: options.taskHints,
        onStep: options.verbose
          ? (step) => {
              for (const call of step.toolCalls) {
                console.error(`    [${scenario.name}] ${call.name} -> ${call.ok ? "ok" : call.error}`);
              }
            }
          : undefined,
      });
      agentResult = await agent.run(scenario.goal, { signal: controller.signal });

      if (integrityBefore) {
        integrity = await checkScenarioIntegrity(dir, integrityBefore, scenario.integrity);
      }
    }

    const precheck = scenario.precheck
      ? await scenario.precheck(dir, agentResult)
      : { pass: null, detail: "no precheck" };

    const shouldJudge =
      !options.skipJudge && !scenario.skipJudge && scenario.tier !== 0;

    let verdict = null;
    if (shouldJudge) {
      console.error(`  judging with cursor agent (${options.judgeModel})...`);
      verdict = await judgeRun({
        scenario,
        agentResult,
        workspaceDir: dir,
        options: {
          model: options.judgeModel,
          timeoutSeconds: options.judgeTimeoutSeconds,
          retries: options.judgeRetries,
        },
      });
    }

    return {
      scenario: scenario.name,
      tier: scenario.tier,
      model,
      workspace: dir,
      keptWorkspace: options.keepWorkspace || Boolean(options.judgeOnly),
      precheck,
      integrity,
      agent: {
        stopReason: agentResult.stopReason,
        steps: agentResult.steps.length,
        answerPreview: agentAnswerText(agentResult).slice(0, 300),
      },
      verdict,
      seconds: (Date.now() - startedAt) / 1000,
    };
  } catch (err) {
    return {
      scenario: scenario.name,
      tier: scenario.tier,
      model,
      workspace: dir,
      keptWorkspace: options.keepWorkspace || Boolean(options.judgeOnly),
      precheck: { pass: false, detail: `runner error: ${err?.message ?? err}` },
      integrity: { pass: false, detail: `runner error: ${err?.message ?? err}` },
      agent: {
        stopReason: agentResult.stopReason ?? "error",
        steps: agentResult.steps?.length ?? 0,
        answerPreview: agentAnswerText(agentResult).slice(0, 300),
      },
      verdict: null,
      seconds: (Date.now() - startedAt) / 1000,
      error: err?.message ?? String(err),
    };
  } finally {
    clearTimeout(timer);
    if (!options.keepWorkspace && !options.judgeOnly) {
      const cleanup = await removeWorkspaceDir(dir);
      if (!cleanup.removed) {
        console.error(
          `  warning: could not remove workspace ${dir}: ${cleanup.error?.message ?? cleanup.error}`,
        );
      }
    }
  }
}

async function logResolvedModel(model, options) {
  if (options.judgeOnly) return model;
  try {
    const client = new OllamaClient({ baseUrl: options.baseUrl, model });
    const routed = await resolveModelAuto({ requested: model, client });
    console.error(`  resolved Ollama model: ${routed.model}`);
    return routed.model;
  } catch (err) {
    console.error(`  could not resolve model '${model}': ${err?.message ?? err}`);
    return model;
  }
}

function printProgress(row) {
  const pre = row.error
    ? "runner error"
    : row.precheck.pass === null
      ? "—"
      : row.precheck.pass
        ? "precheck ok"
        : "precheck fail";
  const integ =
    row.integrity?.pass === null
      ? "—"
      : row.integrity.pass
        ? "integrity ok"
        : "integrity FAIL";
  if (row.verdict) {
    console.error(
      `  ${row.verdict.score} (${row.verdict.grade})  ${row.scenario}  ${pre}  ${integ}  ${row.agent.steps} steps  ${row.seconds.toFixed(1)}s`,
    );
  } else {
    console.error(
      `  ${row.scenario}  ${pre}  ${integ}  ${row.agent.steps} steps  ${row.seconds.toFixed(1)}s`,
    );
  }
  if (row.error) console.error(`    error: ${row.error}`);
  if (row.integrity?.pass === false) console.error(`    integrity: ${row.integrity.detail}`);
}

function printTierProgress(tier, tierResults, avg) {
  console.error("");
  console.error(`── tier ${tier} complete: avg ${avg != null ? avg.toFixed(1) : "n/a"}/100 (${tierResults.length} scenario(s)) ──`);
}

async function runAllScenarios(scenarios, model, options) {
  const results = [];
  const groups = options.progression ? groupByTier(scenarios) : [[null, scenarios]];
  let stoppedAtTier = null;
  let stopReason = null;

  for (const [tier, tierScenarios] of groups) {
    if (tier != null) console.error(`== tier ${tier} (${tierScenarios.length} scenario(s)) ==`);

    const tierResults = [];
    for (const scenario of tierScenarios) {
      console.error(`  running: ${scenario.name}...`);
      const row = await runScenario({ scenario, model, options });
      printProgress(row);
      tierResults.push(row);
      results.push(row);
    }

    if (options.progression && tier != null && !options.skipJudge) {
      const avg = tierAverage(tierResults);
      printTierProgress(tier, tierResults, avg);
      if (options.stopBelowScore != null && avg != null && avg < options.stopBelowScore) {
        stoppedAtTier = tier;
        stopReason = `Stopped after tier ${tier}: average score ${avg.toFixed(1)} is below threshold ${options.stopBelowScore}.`;
        console.error(`  ${stopReason}`);
        break;
      }
    }
  }

  return { results, stoppedAtTier, stopReason };
}

async function writeReports(report, options, extras = {}) {
  if (options.json) {
    const jsonPath = path.resolve(options.json);
    await mkdir(path.dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, JSON.stringify(report, null, 2));
    console.error(`JSON report: ${jsonPath}`);
  }
  if (options.markdown) {
    const mdPath = path.resolve(options.markdown);
    await mkdir(path.dirname(mdPath), { recursive: true });
    await writeFile(mdPath, formatReportMarkdown(report));
    console.error(`Markdown report: ${mdPath}`);
  }
  if (options.capabilityJson && extras.capabilityProfile) {
    const capPath = path.resolve(options.capabilityJson);
    await mkdir(path.dirname(capPath), { recursive: true });
    await writeFile(capPath, JSON.stringify(extras.capabilityProfile, null, 2));
    console.error(`Capability profile: ${capPath}`);
  }
  if (options.publicJson && extras.publicBenchmark) {
    const pubPath = path.resolve(options.publicJson);
    await mkdir(path.dirname(pubPath), { recursive: true });
    await writeFile(pubPath, JSON.stringify(extras.publicBenchmark, null, 2));
    console.error(`Public benchmark: ${pubPath}`);
  }
}

function listScenarios() {
  console.error("Available scenarios:");
  for (const scenario of SCENARIOS) {
    const tag = scenario.tier === 0 ? "safety" : `tier ${scenario.tier}`;
    console.error(`  ${scenario.name}  (${tag})`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--list-scenarios")) {
    listScenarios();
    return;
  }

  const { options, configPath } = await loadBenchOptions(argv);
  if (configPath) {
    console.error(`config: ${configPath}`);
  } else {
    console.error("config: (built-in defaults)");
  }

  validateScenarioSelection(options);

  if (options.judgeOnly) {
    const scenario = SCENARIOS.find((s) => s.name === options.scenarioFilter);
    if (!scenario) {
      console.error(`--judge-only requires --scenario <name>. Available: ${SCENARIOS.map((s) => s.name).join(", ")}`);
      process.exit(1);
    }
    options.judgeOnly = path.resolve(options.judgeOnly);
    const row = await runScenario({ scenario, model: "(judge-only)", options });
    const report = buildAssessmentReport([row], {
      ranAt: new Date().toISOString(),
      models: ["(judge-only)"],
      judgeModel: options.judgeModel,
    });
    console.log(formatReportConsole(report));
    await writeReports(report, options);
    return;
  }

  const scenarios = selectScenarios(options);
  if (scenarios.length === 0) {
    console.error(`No scenarios matched. Names: ${SCENARIOS.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }

  const allResults = [];
  let stoppedAtTier = null;
  let stopReason = null;
  let resolvedModel = options.models[0];

  for (const model of options.models) {
    console.error(`== halo-agent model: ${model} ==`);
    resolvedModel = await logResolvedModel(model, options);
    const { results, stoppedAtTier: stopped, stopReason: reason } = await runAllScenarios(
      scenarios,
      resolvedModel,
      options,
    );
    allResults.push(...results);
    if (stopped != null) {
      stoppedAtTier = stopped;
      stopReason = reason;
      break;
    }
  }

  const gateEvaluation = evaluateGates(allResults, options.gates, {
    preset: options.gatePreset,
  });

  const report = buildAssessmentReport(allResults, {
    ranAt: new Date().toISOString(),
    models: options.models,
    judgeModel: options.judgeModel,
    progression: options.progression,
    stoppedAtTier,
    stopReason,
    gateEvaluation,
  });

  const meta = { resolvedModel, version: PACKAGE_VERSION };
  const capabilityProfile = buildCapabilityProfile(report, gateEvaluation, meta);
  const publicBenchmark = buildPublicBenchmark(report, gateEvaluation, meta);

  console.log("");
  console.log(formatReportConsole(report));
  await writeReports(report, options, { capabilityProfile, publicBenchmark });

  if (options.enforceGates && !gateEvaluation.overallPass) {
    console.error("");
    console.error("Gate enforcement failed — see gate summary above.");
    process.exit(2);
  }
}

await main();
