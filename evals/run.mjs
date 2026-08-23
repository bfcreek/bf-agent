#!/usr/bin/env node
/**
 * Eval runner: measures real task success against live Ollama models, so
 * agent-quality changes are validated instead of guessed at.
 *
 *   node evals/run.mjs                         # default model, all tasks
 *   node evals/run.mjs --models llama3.2,qwen3-coder:30b
 *   node evals/run.mjs --task fix-failing-test --max-steps 15
 *   node evals/run.mjs --json results.json
 *
 * Requires a running Ollama with the model(s) installed. Runs unattended:
 * write/shell tools execute without approval, but only inside a fresh temp
 * workspace per task.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAgent } from "../src/index.mjs";
import { TASKS } from "./tasks.mjs";
import { removeWorkspaceDir } from "./workspace-cleanup.mjs";

function parseArgs(argv) {
  const options = {
    models: ["llama3.2"],
    baseUrl: "http://127.0.0.1:11434",
    maxSteps: 12,
    timeoutSeconds: 180,
    taskFilter: null,
    json: null,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--models" || arg === "--model") {
      options.models = (argv[++i] ?? "").split(",").map((m) => m.trim()).filter(Boolean);
    } else if (arg === "--base-url") options.baseUrl = argv[++i];
    else if (arg === "--max-steps") options.maxSteps = Number.parseInt(argv[++i], 10);
    else if (arg === "--timeout") options.timeoutSeconds = Number.parseInt(argv[++i], 10);
    else if (arg === "--task") options.taskFilter = argv[++i];
    else if (arg === "--json") options.json = argv[++i];
    else if (arg === "--verbose") options.verbose = true;
    else {
      console.error(`Unknown option '${arg}'.`);
      process.exit(1);
    }
  }
  return options;
}

async function runTask({ task, model, options }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-eval-"));
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutSeconds * 1000);

  try {
    await task.setup(dir);
    const agent = await createAgent({
      model,
      baseUrl: options.baseUrl,
      workspaceRoot: dir,
      maxSteps: options.maxSteps,
      projectIndex: false, // no embedding-model dependency for evals
      onStep: options.verbose
        ? (step) => {
            for (const call of step.toolCalls) {
              console.error(`    [${task.name}] ${call.name} -> ${call.ok ? "ok" : call.error}`);
            }
          }
        : undefined,
    });
    const result = await agent.run(task.goal, { signal: controller.signal });
    const verdict = await task.check(dir, result);
    return {
      task: task.name,
      model,
      pass: verdict.pass,
      detail: verdict.detail,
      stopReason: result.stopReason,
      steps: result.steps.length,
      seconds: (Date.now() - startedAt) / 1000,
    };
  } catch (err) {
    return {
      task: task.name,
      model,
      pass: false,
      detail: `runner error: ${err?.message ?? err}`,
      stopReason: "error",
      steps: 0,
      seconds: (Date.now() - startedAt) / 1000,
    };
  } finally {
    clearTimeout(timer);
    const cleanup = await removeWorkspaceDir(dir);
    if (!cleanup.removed) {
      console.error(
        `  warning: could not remove workspace ${dir}: ${cleanup.error?.message ?? cleanup.error}`,
      );
    }
  }
}

function printSummary(results, models) {
  console.log("");
  for (const model of models) {
    const rows = results.filter((r) => r.model === model);
    const passed = rows.filter((r) => r.pass).length;
    console.log(`${model}: ${passed}/${rows.length} passed`);
    for (const r of rows) {
      const mark = r.pass ? "PASS" : "FAIL";
      const line = `  ${mark}  ${r.task}  (${r.steps} steps, ${r.seconds.toFixed(1)}s, ${r.stopReason})`;
      console.log(line);
      if (!r.pass) console.log(`        ${r.detail}`);
    }
    console.log("");
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tasks = options.taskFilter
    ? TASKS.filter((t) => t.name === options.taskFilter)
    : TASKS;
  if (tasks.length === 0) {
    console.error(
      `No task named '${options.taskFilter}'. Tasks: ${TASKS.map((t) => t.name).join(", ")}`,
    );
    process.exit(1);
  }

  const results = [];
  for (const model of options.models) {
    console.error(`== model: ${model} ==`);
    for (const task of tasks) {
      console.error(`  running ${task.name}...`);
      const result = await runTask({ task, model, options });
      console.error(`  ${result.pass ? "PASS" : "FAIL"} ${task.name} (${result.seconds.toFixed(1)}s)`);
      results.push(result);
    }
  }

  printSummary(results, options.models);

  if (options.json) {
    await writeFile(
      options.json,
      JSON.stringify({ ranAt: new Date().toISOString(), options, results }, null, 2),
    );
    console.error(`results written to ${options.json}`);
  }

  const failed = results.filter((r) => !r.pass).length;
  process.exitCode = failed > 0 ? 2 : 0;
}

await main();
