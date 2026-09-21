#!/usr/bin/env node
/**
 * Development benchmark: run halo-agent on tiered scenarios, then grade with
 * the Cursor CLI agent (default model: auto).
 *
 *   npm run bench
 *   node evals/dev-bench.mjs --tier 3          # auto-loads bench.config.json if present
 *   node evals/dev-bench.mjs --tier-preset cloud   # cloud-only models (no GPU)
 *   node evals/dev-bench.mjs --tier-preset cloud-max  # pinned cloud model, max think
 *   node evals/dev-bench.mjs --scenario greet-module
 *   node evals/dev-bench.mjs --language csharp --flat
 *   node evals/dev-bench.mjs --list-scenarios
 *   node evals/dev-bench.mjs --skip-judge
 *   node evals/dev-bench.mjs --resume          # continue after an interrupted run
 *   node evals/dev-bench.mjs --reset           # clear saved progress and that sequence's output folders
 *
 * Scenario workspaces are kept under ../halo-agent-benchmark/<language>/t<tier>/<scenario>/.
 *
 * Requires: Ollama + a tool model for halo-agent; Cursor CLI (`agent`) for judging.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createAgent } from "../src/index.mjs";
import { OllamaClient } from "../src/ollama-client.mjs";
import { resolveModelAuto } from "../src/model-routing.mjs";
import { loadBenchOptions, resolveTierModel, uniqueTierModels } from "./config.mjs";
import {
  DEFAULT_CHECKPOINT_REL,
  buildCheckpointRecord,
  buildRunKey,
  checkpointMatchesRun,
  clearAllCheckpoints,
  clearCheckpoint,
  describeRunSelection,
  isTransientProviderError,
  languageFilterFromCheckpoint,
  listCheckpoints,
  loadCheckpoint,
  resolveCheckpointPath,
  saveCheckpoint,
  shouldStopBench,
} from "./checkpoint.mjs";
import {
  buildCapabilityProfile,
  buildPublicBenchmark,
  evaluateGates,
} from "./gates.mjs";
import { computeEfficiency } from "./efficiency.mjs";
import { captureIntegritySnapshot, checkScenarioIntegrity } from "./integrity.mjs";
import { buildOracle, judgeRun } from "./judge.mjs";
import { appendScoreboardEntry, computeRunMetrics, loadScoreboardHistory } from "./scoreboard.mjs";
import { mergePhaseResults, scenarioPhases } from "./phases.mjs";
import { buildAssessmentReport, formatReportConsole, formatReportMarkdown } from "./report.mjs";
import { SCENARIOS, agentAnswerText, filterAvailableScenarios, selectScenarios } from "./scenarios.mjs";
import { defaultBenchmarkRoot, prepareScenarioWorkspace, resetSequenceWorkspaces } from "./workspace-layout.mjs";

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

async function runAgentOnWorkspace({ scenario, model, options, dir, goal, maxSteps, signal }) {
  const agent = await createAgent({
    model,
    baseUrl: options.baseUrl,
    workspaceRoot: dir,
    maxSteps,
    projectIndex: false,
    // Checkpoints give the judge an exact before/after of every file the
    // agent touched (see change-set.mjs). They live under .halo-agent/,
    // which integrity and snapshots already skip.
    checkpoints: true,
    think: options.think ?? undefined,
    onStep: options.verbose
      ? (step) => {
          for (const call of step.toolCalls) {
            console.error(`    [${scenario.name}] ${call.name} -> ${call.ok ? "ok" : call.error}`);
          }
        }
      : undefined,
  });
  try {
    return await agent.run(goal, { signal });
  } catch (err) {
    if (signal.aborted || !isTransientProviderError(err?.message ?? err)) {
      throw err;
    }
    return await agent.run(goal, { signal });
  }
}

async function runScenario({ scenario, model, options }) {
  const benchmarkRoot = options.benchmarkRoot ?? defaultBenchmarkRoot();
  const dir =
    options.judgeOnly ?? (await prepareScenarioWorkspace(scenario, { root: benchmarkRoot }));
  if (!options.judgeOnly) {
    console.error(`  workspace: ${dir}`);
  }
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
  /** @type {Awaited<ReturnType<typeof captureIntegritySnapshot>>|null} */
  let integrityBefore = null;

  try {
    if (!options.judgeOnly) {
      await scenario.setup(dir);
      integrityBefore = scenario.integrity
        ? await captureIntegritySnapshot(dir)
        : null;

      const phases = scenarioPhases(scenario, { maxSteps: options.maxSteps });
      const phaseResults = [];
      for (const [index, phase] of phases.entries()) {
        if (phases.length > 1) {
          console.error(`  phase ${index + 1}/${phases.length} (${phase.id})...`);
        }
        phaseResults.push(
          await runAgentOnWorkspace({
            scenario,
            model,
            options,
            dir,
            goal: phase.goal,
            maxSteps: phase.maxSteps,
            signal: controller.signal,
          }),
        );
      }
      agentResult = mergePhaseResults(phaseResults, phases);

      if (integrityBefore) {
        integrity = await checkScenarioIntegrity(dir, integrityBefore, scenario.integrity);
      }
    }

    const precheck = scenario.precheck
      ? await scenario.precheck(dir, agentResult)
      : { pass: null, detail: "no precheck" };
    const efficiency = computeEfficiency(agentResult, { maxSteps: options.maxSteps });

    const shouldJudge =
      !options.skipJudge && !scenario.skipJudge && scenario.tier !== 0;

    let verdict = null;
    let judgeError = null;
    if (shouldJudge) {
      console.error(`  judging with cursor agent (${options.judgeModel})...`);
      try {
        verdict = await judgeRun({
          scenario,
          agentResult,
          workspaceDir: dir,
          oracle: buildOracle(precheck, integrity),
          options: {
            model: options.judgeModel,
            timeoutSeconds: options.judgeTimeoutSeconds,
            retries: options.judgeRetries,
            efficiency,
            maxSteps: options.maxSteps,
          },
        });
      } catch (err) {
        judgeError = err?.message ?? String(err);
        console.error(`  judge failed: ${judgeError}`);
      }
    }

    return {
      scenario: scenario.name,
      tier: scenario.tier,
      model,
      workspace: dir,
      keptWorkspace: true,
      precheck,
      integrity,
      agent: {
        stopReason: agentResult.stopReason,
        steps: agentResult.steps.length,
        toolCalls: efficiency.toolCalls,
        elapsedMs: agentResult.elapsedMs ?? null,
        wallClockExhausted: agentResult.wallClockExhausted === true,
        answerPreview: agentAnswerText(agentResult).slice(0, 300),
        efficiency,
      },
      verdict,
      judgeError,
      seconds: (Date.now() - startedAt) / 1000,
    };
  } catch (err) {
    const errDetail = `runner error: ${err?.message ?? err}`;
    // Still score workspace integrity when the agent crashed mid-run — a
    // parse/transport failure must not invent an integrity miss if nothing
    // on disk changed. Precheck stays null when the scenario has none.
    if (integrityBefore) {
      try {
        integrity = await checkScenarioIntegrity(dir, integrityBefore, scenario.integrity);
      } catch (integErr) {
        integrity = {
          pass: false,
          detail: `${errDetail}; integrity check failed: ${integErr?.message ?? integErr}`,
        };
      }
    } else if (scenario.integrity) {
      integrity = { pass: false, detail: errDetail };
    }

    const precheck = scenario.precheck
      ? { pass: false, detail: errDetail }
      : { pass: null, detail: "no precheck" };

    return {
      scenario: scenario.name,
      tier: scenario.tier,
      model,
      workspace: dir,
      keptWorkspace: true,
      precheck,
      integrity,
      agent: {
        stopReason: agentResult.stopReason ?? "error",
        steps: agentResult.steps?.length ?? 0,
        toolCalls: null,
        elapsedMs: agentResult.elapsedMs ?? null,
        wallClockExhausted: agentResult.wallClockExhausted === true,
        answerPreview: agentAnswerText(agentResult).slice(0, 300),
        efficiency: computeEfficiency(agentResult, { maxSteps: options.maxSteps }),
      },
      verdict: null,
      judgeError: null,
      seconds: (Date.now() - startedAt) / 1000,
      error: err?.message ?? String(err),
    };
  } finally {
    clearTimeout(timer);
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

async function logResolvedModels(models, options) {
  /** @type {Map<string, string>} */
  const resolved = new Map();
  for (const model of models) {
    resolved.set(model, await logResolvedModel(model, options));
  }
  return resolved;
}

function describeTierModels(tierModels) {
  let prev = -1;
  for (const band of tierModels) {
    const range =
      band.throughTier != null
        ? `tier ${prev + 1}–${band.throughTier}`
        : `tier ${prev + 1}+`;
    const vision = band.vision && band.vision !== band.model ? ` (vision: ${band.vision})` : "";
    console.error(`  ${range}: ${band.model}${vision}`);
    prev = band.throughTier ?? prev;
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
  const tools =
    row.agent.toolCalls != null ? `${row.agent.steps} steps/${row.agent.toolCalls} tools` : `${row.agent.steps} steps`;
  const flags = row.agent.efficiency?.flags?.length ? `  [${row.agent.efficiency.flags.join(", ")}]` : "";
  if (row.verdict) {
    const proc = row.verdict.process?.score != null ? `  process ${row.verdict.process.score}` : "";
    console.error(
      `  outcome ${row.verdict.score} (${row.verdict.grade})${proc}  ${row.scenario}  ${pre}  ${integ}  ${tools}  ${row.seconds.toFixed(1)}s${flags}`,
    );
  } else {
    console.error(
      `  ${row.scenario}  ${pre}  ${integ}  ${tools}  ${row.seconds.toFixed(1)}s${flags}`,
    );
  }
  if (row.error) console.error(`    error: ${row.error}`);
  if (row.judgeError) console.error(`    judge: ${row.judgeError}`);
  if (row.integrity?.pass === false) console.error(`    integrity: ${row.integrity.detail}`);
  if (row.verdict?.outcome?.agreesWithOracle === false) {
    console.error(
      `    judge disagreed with ground truth (judge ${row.verdict.outcome.judgeScore}, anchored to ${row.verdict.score})`,
    );
  }
}

function printTierProgress(tier, tierResults, avg) {
  console.error("");
  console.error(`── tier ${tier} complete: avg ${avg != null ? avg.toFixed(1) : "n/a"}/100 (${tierResults.length} scenario(s)) ──`);
}

async function runAllScenarios(scenarios, fixedModel, options, resumeState = null, resolvedModels = null) {
  const completedNames = new Set(resumeState?.completedNames ?? []);
  const results = [...(resumeState?.results ?? [])];
  const groups = options.progression ? groupByTier(scenarios) : [[null, scenarios]];
  let stoppedAtTier = resumeState?.stoppedAtTier ?? null;
  let stopReason = resumeState?.stopReason ?? null;
  const modelFor = (scenario) => {
    const requested = fixedModel ?? resolveTierModel(scenario.tier, options.tierModels, options.models[0]);
    return resolvedModels?.get(requested) ?? requested;
  };

  if (completedNames.size > 0) {
    console.error(
      `  resuming: ${completedNames.size}/${scenarios.length} scenario(s) already completed`,
    );
  }

  for (const [tier, tierScenarios] of groups) {
    if (tier != null) {
      const tierModel = modelFor(tierScenarios[0]);
      console.error(`== tier ${tier} (model: ${tierModel}, ${tierScenarios.length} scenario(s)) ==`);
    }

    const tierResults = [];
    for (const scenario of tierScenarios) {
      if (completedNames.has(scenario.name)) {
        const existing = results.find((row) => row.scenario === scenario.name);
        if (existing) tierResults.push(existing);
        console.error(`  skipping: ${scenario.name} (completed)`);
        continue;
      }

      const model = modelFor(scenario);
      console.error(`  running: ${scenario.name}...`);
      const row = await runScenario({ scenario, model, options });
      printProgress(row);

      // Replace any prior failed attempt so resume can retry this scenario.
      const prior = results.findIndex((r) => r.scenario === scenario.name);
      if (prior >= 0) results.splice(prior, 1);
      results.push(row);
      tierResults.push(row);

      if (!shouldStopBench(row)) {
        completedNames.add(scenario.name);
      }

      if (resumeState?.onProgress) {
        await resumeState.onProgress({
          results,
          completedNames: [...completedNames],
          stoppedAtTier,
          stopReason,
        });
      }

      if (shouldStopBench(row)) {
        stopReason = `Stopped after ${row.scenario}: ${row.error}`;
        console.error(`  ${stopReason}`);
        if (resumeState?.onProgress) {
          await resumeState.onProgress({
            results,
            completedNames: [...completedNames],
            stoppedAtTier: tier ?? stoppedAtTier,
            stopReason,
          });
        }
        return {
          results,
          stoppedAtTier: tier ?? stoppedAtTier,
          stopReason,
          completedNames: [...completedNames],
          stoppedOnError: true,
        };
      }
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

  return { results, stoppedAtTier, stopReason, completedNames: [...completedNames], stoppedOnError: false };
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
    const lang = scenario.language ? `, ${scenario.language}` : "";
    const need = scenario.requires ? `, needs ${scenario.requires}` : "";
    console.error(`  ${scenario.name}  (${tag}${lang}${need})`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--list-scenarios")) {
    listScenarios();
    return;
  }

  const { options, configPath } = await loadBenchOptions(argv);
  let checkpointPath = resolveCheckpointPath(options.checkpointPath);

  if (options.reset) {
    if (!options.languageFilter?.length && !options.checkpointExplicit) {
      const cleared = await clearAllCheckpoints();
      if (cleared.length === 0) {
        await clearCheckpoint(checkpointPath);
        console.error(`checkpoint cleared: ${checkpointPath}`);
      } else {
        for (const clearedPath of cleared) {
          console.error(`checkpoint cleared: ${clearedPath}`);
        }
      }
    } else {
      await clearCheckpoint(checkpointPath);
      console.error(`checkpoint cleared: ${checkpointPath}`);
    }
    const benchmarkRoot = options.benchmarkRoot ?? defaultBenchmarkRoot();
    const clearedDirs = await resetSequenceWorkspaces(options.languageFilter, { root: benchmarkRoot });
    for (const dir of clearedDirs) {
      console.error(`benchmark output cleared: ${dir}`);
    }
    const valueFlags = new Set(["--checkpoint", "--language", "--lang", "--benchmark-root"]);
    const onlyReset =
      argv.length === 0 ||
      argv.every(
        (arg, index) =>
          arg === "--reset" ||
          valueFlags.has(arg) ||
          (index > 0 && valueFlags.has(argv[index - 1])),
      );
    if (onlyReset) return;
  }

  if (configPath) {
    console.error(`config: ${configPath}`);
  } else {
    console.error("config: (built-in defaults)");
  }

  let resumeCheckpoint = null;
  if (options.resume) {
    resumeCheckpoint = await loadCheckpoint(checkpointPath);
    if (!resumeCheckpoint && options.languageFilter?.length && !options.checkpointExplicit) {
      const fallbackPath = resolveCheckpointPath(DEFAULT_CHECKPOINT_REL);
      if (fallbackPath !== checkpointPath) {
        const fallback = await loadCheckpoint(fallbackPath);
        const langs = languageFilterFromCheckpoint(fallback);
        if (langs && langs.join("\0") === options.languageFilter.join("\0")) {
          resumeCheckpoint = fallback;
          checkpointPath = fallbackPath;
        }
      }
    }
    if (!resumeCheckpoint && !options.languageFilter?.length && !options.checkpointExplicit) {
      const found = await listCheckpoints();
      if (found.length === 1) {
        resumeCheckpoint = found[0].record;
        checkpointPath = found[0].path;
        const langs = languageFilterFromCheckpoint(found[0].record);
        if (langs?.length) options.languageFilter = langs;
      } else if (found.length > 1) {
        console.error("Multiple language checkpoints found. Resume one with --language:");
        for (const item of found) {
          const langs = item.languageFilter?.join("+") ?? "all";
          const done = item.record.completedNames?.length ?? 0;
          const total = item.record.scenarioNames?.length ?? 0;
          console.error(`  ${langs}  ${done}/${total}  (${item.record.selectionLabel ?? item.fileName})`);
        }
        process.exit(1);
      }
    }
    if (resumeCheckpoint && !options.languageFilter?.length) {
      const langs = languageFilterFromCheckpoint(resumeCheckpoint);
      if (langs?.length) options.languageFilter = langs;
    }
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

  const selected = selectScenarios(options);
  const explicitSelection = Boolean(options.scenarioFilter) || Boolean(options.scenarioList?.length);
  const scenarios = filterAvailableScenarios(selected, { explicit: explicitSelection });
  if (scenarios.length < selected.length) {
    const skipped = selected.filter((s) => !scenarios.includes(s));
    console.error(
      `Skipping (missing runtime): ${skipped.map((s) => `${s.name} [${s.requires}]`).join(", ")}`,
    );
  }
  if (scenarios.length === 0) {
    console.error(`No scenarios matched. Names: ${SCENARIOS.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }

  const scenarioNames = scenarios.map((s) => s.name);
  const runKey = buildRunKey(scenarioNames, options);
  const selectionLabel = describeRunSelection(scenarioNames, options);
  let checkpoint = options.resume ? resumeCheckpoint : await loadCheckpoint(checkpointPath);

  if (options.resume) {
    if (!checkpoint) {
      console.error(`No checkpoint found at ${checkpointPath}. Run without --resume to start fresh.`);
      process.exit(1);
    }
    if (!checkpointMatchesRun(checkpoint, runKey, scenarioNames)) {
      console.error(
        "Checkpoint does not match this run (different scenarios or options). Use --reset to clear it, then start fresh.",
      );
      console.error(`  checkpoint: ${checkpoint.selectionLabel ?? "(unknown)"}`);
      console.error(`  this run:   ${selectionLabel}`);
      process.exit(1);
    }
    console.error(
      `checkpoint: ${checkpoint.completedNames.length}/${scenarioNames.length} scenario(s) completed (${checkpoint.selectionLabel})`,
    );
  } else if (checkpoint) {
    await clearCheckpoint(checkpointPath);
    console.error("Starting fresh run (previous checkpoint cleared). Use --resume to continue it.");
    checkpoint = null;
  }

  const resumeStartedAt = checkpoint?.startedAt ?? new Date().toISOString();
  let resumeCompleted = new Set(checkpoint?.completedNames ?? []);
  let resumeResults = [...(checkpoint?.results ?? [])];

  const allResults = [];
  let stoppedAtTier = checkpoint?.stoppedAtTier ?? null;
  let stopReason = checkpoint?.stopReason ?? null;
  let stoppedOnError = false;
  let resolvedModel = checkpoint?.resolvedModel ?? options.models[0];
  const useTierRouting = Boolean(options.tierModels?.length);
  const reportModels = useTierRouting ? uniqueTierModels(options.tierModels) : options.models;
  /** @type {Map<string, string>} */
  let resolvedModels = new Map();

  const persistCheckpoint = async ({
    results,
    completedNames,
    stoppedAtTier: stopped,
    stopReason: reason,
    resolvedModel: model,
  }) => {
    await saveCheckpoint(
      checkpointPath,
      buildCheckpointRecord({
        runKey,
        selectionLabel,
        scenarioNames,
        completedNames,
        results,
        startedAt: resumeStartedAt,
        languageFilter: options.languageFilter,
        resolvedModel: model,
        stoppedAtTier: stopped,
        stopReason: reason,
      }),
    );
  };

  if (useTierRouting) {
    console.error("== tier-routed models ==");
    describeTierModels(options.tierModels);
    resolvedModels = await logResolvedModels(reportModels, options);
    resolvedModel = resolvedModels.get(options.tierModels[0].model) ?? resolvedModel;
    const outcome = await runAllScenarios(scenarios, null, options, {
      completedNames: [...resumeCompleted],
      results: resumeResults,
      stoppedAtTier,
      stopReason,
      onProgress: async (progress) => {
        resumeCompleted = new Set(progress.completedNames);
        resumeResults = progress.results;
        stoppedAtTier = progress.stoppedAtTier;
        stopReason = progress.stopReason;
        await persistCheckpoint({
          results: progress.results,
          completedNames: progress.completedNames,
          stoppedAtTier: progress.stoppedAtTier,
          stopReason: progress.stopReason,
          resolvedModel,
        });
      },
    }, resolvedModels);
    const { results, stoppedAtTier: stopped, stopReason: reason, completedNames } = outcome;
    allResults.push(...results);
    resumeCompleted = new Set(completedNames);
    resumeResults = results;
    if (outcome.stoppedOnError) {
      stoppedOnError = true;
      stoppedAtTier = stopped;
      stopReason = reason;
    } else if (stopped != null) {
      stoppedAtTier = stopped;
      stopReason = reason;
    }
  } else {
    for (const model of options.models) {
      console.error(`== Bitfield Agent model: ${model} ==`);
      resolvedModel = await logResolvedModel(model, options);
      const outcome = await runAllScenarios(scenarios, resolvedModel, options, {
        completedNames: [...resumeCompleted],
        results: resumeResults,
        stoppedAtTier,
        stopReason,
        onProgress: async (progress) => {
          resumeCompleted = new Set(progress.completedNames);
          resumeResults = progress.results;
          stoppedAtTier = progress.stoppedAtTier;
          stopReason = progress.stopReason;
          await persistCheckpoint({
            results: progress.results,
            completedNames: progress.completedNames,
            stoppedAtTier: progress.stoppedAtTier,
            stopReason: progress.stopReason,
            resolvedModel,
          });
        },
      });
      const { results, stoppedAtTier: stopped, stopReason: reason, completedNames } = outcome;
      allResults.push(...results);
      resumeCompleted = new Set(completedNames);
      resumeResults = results;
      if (outcome.stoppedOnError) {
        stoppedOnError = true;
        stoppedAtTier = stopped;
        stopReason = reason;
        break;
      }
      if (stopped != null) {
        stoppedAtTier = stopped;
        stopReason = reason;
        break;
      }
    }
  }

  const runFinished =
    !stoppedOnError &&
    (resumeCompleted.size >= scenarioNames.length || stoppedAtTier != null);
  if (runFinished) {
    await clearCheckpoint(checkpointPath);
  }

  const gateEvaluation = evaluateGates(allResults, options.gates, {
    preset: options.gatePreset,
  });

  const flags = {
    think: options.think ?? null,
    tierPreset: options.tierPreset ?? null,
  };

  const history = await loadScoreboardHistory().catch(() => []);

  const report = buildAssessmentReport(allResults, {
    ranAt: new Date().toISOString(),
    models: reportModels,
    judgeModel: options.judgeModel,
    progression: options.progression,
    stoppedAtTier,
    stopReason,
    gateEvaluation,
    flags,
    history,
    maxSteps: options.maxSteps,
  });

  const meta = { resolvedModel, version: PACKAGE_VERSION };
  const capabilityProfile = buildCapabilityProfile(report, gateEvaluation, meta);
  const publicBenchmark = buildPublicBenchmark(report, gateEvaluation, meta);

  const metrics = computeRunMetrics(allResults);
  await appendScoreboardEntry({
    label: options.label ?? null,
    models: reportModels,
    ...flags,
    maxSteps: options.maxSteps ?? null,
    scenarios: allResults.length,
    ...metrics,
    avgScore: report.overall.avgScore,
  });

  console.log("");
  console.log(formatReportConsole(report));
  await writeReports(report, options, { capabilityProfile, publicBenchmark });

  if (options.enforceGates && !gateEvaluation.overallPass) {
    console.error("");
    console.error("Gate enforcement failed — see gate summary above.");
    process.exit(2);
  }

  if (stoppedOnError) {
    console.error("");
    console.error("Bench run stopped due to an error (use --resume to continue).");
    process.exit(1);
  }
}

await main();
