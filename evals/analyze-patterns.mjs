#!/usr/bin/env node
/**
 * Analyze scoreboard history (and optionally a bench report) for architecture
 * patterns — approach-level levers, not tip-style fixes.
 *
 *   node evals/analyze-patterns.mjs
 *   node evals/analyze-patterns.mjs --report bench-H2.json
 *   node evals/analyze-patterns.mjs --scoreboard evals/scoreboard-history.jsonl
 *   node evals/analyze-patterns.mjs --json patterns.json --markdown patterns.md
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  buildArchitectureInsights,
  detectHistoryPatterns,
  detectRunPatterns,
  formatInsightsConsole,
  formatInsightsMarkdown,
} from "./patterns.mjs";
import { DEFAULT_SCOREBOARD, loadScoreboardHistory } from "./scoreboard.mjs";

function parseArgs(argv) {
  const options = {
    report: null,
    scoreboard: DEFAULT_SCOREBOARD,
    json: null,
    markdown: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--report") options.report = argv[++i];
    else if (arg === "--scoreboard") options.scoreboard = argv[++i];
    else if (arg === "--json") options.json = argv[++i];
    else if (arg === "--markdown") options.markdown = argv[++i];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      options.help = true;
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node evals/analyze-patterns.mjs [options]

  --report <path>       Bench report JSON (scenarios + overall)
  --scoreboard <path>   Scoreboard history JSONL (default: ${DEFAULT_SCOREBOARD})
  --json <path>         Write insights JSON
  --markdown <path>     Write insights markdown
  --help                Show this help

Reads telemetry patterns across a run and/or scoreboard A/B history.
Emits architectural levers (acceptance, escalation, memory, critique) —
not hard-coded tip-style recommendations.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    process.exit(options.report === null && process.argv.length <= 2 ? 0 : 1);
  }

  const history = await loadScoreboardHistory(options.scoreboard);

  /** @type {object|null} */
  let report = null;
  if (options.report) {
    report = JSON.parse(await readFile(path.resolve(options.report), "utf8"));
  }

  const insights = report
    ? buildArchitectureInsights(report, {
        history,
        flags: report.flags ?? {},
        maxSteps: report.maxSteps,
      })
    : detectHistoryPatterns(history);

  // If we only have a report without history-shaped flags, still surface run patterns.
  const runOnly =
    report && (!report.architectureInsights || report.architectureInsights.length === 0)
      ? detectRunPatterns(report.scenarios ?? report.tasks ?? [], {
          flags: report.flags ?? {},
          maxSteps: report.maxSteps,
        })
      : [];

  const combined = insights.length ? insights : runOnly;

  const payload = {
    generatedAt: new Date().toISOString(),
    reportPath: options.report,
    scoreboardPath: options.scoreboard,
    historyEntries: history.length,
    insightCount: combined.length,
    insights: combined,
  };

  console.log(formatInsightsConsole(combined) || "  No architecture patterns crossed the evidence threshold.\n");

  if (options.json) {
    await mkdir(path.dirname(path.resolve(options.json)), { recursive: true });
    await writeFile(path.resolve(options.json), JSON.stringify(payload, null, 2), "utf8");
    console.error(`Wrote ${options.json}`);
  }
  if (options.markdown) {
    await mkdir(path.dirname(path.resolve(options.markdown)), { recursive: true });
    const md = [
      "# Architecture patterns",
      "",
      `Generated: ${payload.generatedAt}`,
      `History entries: ${payload.historyEntries}`,
      "",
      formatInsightsMarkdown(combined).replace(/^## Architecture patterns\n\n/, ""),
    ].join("\n");
    await writeFile(path.resolve(options.markdown), md, "utf8");
    console.error(`Wrote ${options.markdown}`);
  }
}

await main();
