/**
 * Turn bench report recommendations into an actionable processing plan for halo-agent.
 *
 *   node evals/process-recommendations.mjs
 *   node evals/process-recommendations.mjs --report path/to/report.json
 *   node evals/process-recommendations.mjs --markdown plan.md --json plan.json
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { latestReportPaths } from "./recognized/layout.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Primary edit targets keyed by judge `area` (case-insensitive). */
export const AREA_TARGETS = {
  "system prompt": [
    "src/context-builder.mjs",
    "src/agent-loop.mjs",
  ],
  tools: [
    "src/tools/builtin.mjs",
    "src/tools/shell.mjs",
    "src/tools/fs.mjs",
    "src/tool-registry.mjs",
  ],
  planning: [
    "src/prompt-enhancements.mjs",
    "src/agent-loop.mjs",
  ],
  compaction: ["src/compaction.mjs"],
  other: [],
};

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

/**
 * @param {string} area
 */
export function targetsForArea(area) {
  const key = String(area ?? "").trim().toLowerCase();
  for (const [name, files] of Object.entries(AREA_TARGETS)) {
    if (name.toLowerCase() === key) return [...files];
  }
  return [...AREA_TARGETS.other];
}

/**
 * @param {object} report
 */
export function extractRecommendations(report) {
  if (Array.isArray(report?.recommendations) && report.recommendations.length > 0) {
    return report.recommendations.map((rec) => ({
      area: rec.area ?? "other",
      suggestion: rec.suggestion ?? "",
      priority: rec.priority ?? "medium",
      count: rec.count ?? 1,
      sources: rec.tasks ?? rec.scenarios ?? [],
    }));
  }

  /** @type {Map<string, {area: string, suggestion: string, priority: string, count: number, sources: string[]}>} */
  const map = new Map();
  const rows = report?.tasks ?? report?.scenarios ?? [];
  for (const row of rows) {
    const name = row.name ?? row.scenario ?? "unknown";
    const improvements = row.agentImprovements ?? row.verdict?.agentImprovements ?? [];
    for (const item of improvements) {
      const key = `${item.area}::${item.suggestion}`;
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
        if (!existing.sources.includes(name)) existing.sources.push(name);
      } else {
        map.set(key, {
          area: item.area ?? "other",
          suggestion: item.suggestion ?? "",
          priority: item.priority ?? "medium",
          count: 1,
          sources: [name],
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 9;
    const pb = PRIORITY_ORDER[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    return b.count - a.count;
  });
}

/**
 * @param {object} report
 * @param {object} [meta]
 */
export function buildProcessingPlan(report, meta = {}) {
  const recommendations = extractRecommendations(report);
  const items = recommendations.map((rec, index) => ({
    id: index + 1,
    area: rec.area,
    suggestion: rec.suggestion,
    priority: rec.priority,
    count: rec.count,
    sources: rec.sources,
    targetFiles: targetsForArea(rec.area),
    status: "pending",
  }));

  return {
    version: 1,
    kind: "recommendations-plan",
    generatedAt: new Date().toISOString(),
    reportPath: meta.reportPath ?? null,
    suite: report.suite ?? report.kind ?? null,
    dataset: report.dataset ?? report.datasetLabel ?? null,
    ranAt: report.ranAt ?? null,
    model: report.model ?? null,
    recommendationCount: items.length,
    items,
    guidance: [
      "Implement each suggestion in the mapped target files (or the closest related module).",
      "Prefer prompt-enhancements.mjs for task-type hints; context-builder/agent-loop for system prompt.",
      "Keep changes minimal and focused — one recommendation per logical commit when possible.",
      "Run npm test after edits; add a focused test when the change is testable.",
      "Skip recommendations that are vague, duplicate existing behavior, or conflict with LIMITATIONS.md.",
    ],
  };
}

/**
 * @param {ReturnType<typeof buildProcessingPlan>} plan
 */
export function formatProcessingMarkdown(plan) {
  const lines = [
    "# halo-agent — bench recommendations plan",
    "",
    `Generated: ${plan.generatedAt}`,
  ];
  if (plan.reportPath) lines.push(`Report: \`${plan.reportPath}\``);
  if (plan.suite) lines.push(`Suite: ${plan.suite}${plan.dataset ? ` (${plan.dataset})` : ""}`);
  if (plan.ranAt) lines.push(`Bench ran: ${plan.ranAt}`);
  if (plan.model) lines.push(`Model: ${plan.model}`);
  lines.push("", `**${plan.recommendationCount}** recommendation(s) to process.`, "");
  if (plan.recommendationCount === 0) {
    lines.push("No agent improvements were recorded. Nothing to implement.");
    return lines.join("\n");
  }

  lines.push("## Guidance", "");
  for (const note of plan.guidance) lines.push(`- ${note}`);
  lines.push("", "## Recommendations", "");

  for (const item of plan.items) {
    const seen =
      item.sources.length > 0
        ? ` (${item.count > 1 ? `${item.count}x: ` : ""}${item.sources.join(", ")})`
        : "";
    lines.push(`### ${item.id}. [${item.priority}] ${item.area}${seen}`, "");
    lines.push(item.suggestion, "");
    if (item.targetFiles.length > 0) {
      lines.push("**Target files:**");
      for (const file of item.targetFiles) lines.push(`- \`${file}\``);
      lines.push("");
    } else {
      lines.push("**Target files:** (judge area `other` — pick the closest module)", "");
    }
    lines.push(`Status: ${item.status}`, "");
  }

  return lines.join("\n");
}

/**
 * @param {string} reportPath
 */
export async function loadReport(reportPath) {
  const raw = await readFile(reportPath, "utf8");
  return JSON.parse(raw);
}

/**
 * @param {object} options
 * @param {string} [options.report]
 * @param {string} [options.json]
 * @param {string} [options.markdown]
 * @param {string} [options.repoRoot]
 */
export async function processRecommendations(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const reportPath = options.report
    ? path.resolve(options.report)
    : latestReportPaths("terminal-bench", { repoRoot }).json;

  const report = await loadReport(reportPath);
  const plan = buildProcessingPlan(report, { reportPath });
  const outputs = { plan, reportPath };

  if (options.json) {
    const jsonPath = path.resolve(options.json);
    await mkdir(path.dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, JSON.stringify(plan, null, 2));
    outputs.jsonPath = jsonPath;
  }
  if (options.markdown) {
    const mdPath = path.resolve(options.markdown);
    await mkdir(path.dirname(mdPath), { recursive: true });
    await writeFile(mdPath, formatProcessingMarkdown(plan));
    outputs.markdownPath = mdPath;
  }

  return outputs;
}

function printHelp() {
  console.log(`Process bench recommendations into an implementation plan.

Usage:
  node evals/process-recommendations.mjs [options]

Options:
  --report <path>   Report JSON (default: ../halo-agent-benchmark/recognized/terminal-bench/latest.json)
  --json <path>     Write plan JSON
  --markdown <path> Write plan markdown
  --help            Show this help
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const options = { repoRoot: REPO_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--report") options.report = argv[++i];
    else if (arg === "--json") options.json = argv[++i];
    else if (arg === "--markdown") options.markdown = argv[++i];
    else {
      console.error(`Unknown option: ${arg}`);
      process.exitCode = 1;
      return;
    }
  }

  if (!options.json && !options.markdown) {
    options.json = path.join(REPO_ROOT, "bench-recommendations-plan.json");
    options.markdown = path.join(REPO_ROOT, "bench-recommendations-plan.md");
  }

  try {
    const { plan, reportPath, jsonPath, markdownPath } = await processRecommendations(options);
    console.error(`report: ${reportPath}`);
    console.error(`recommendations: ${plan.recommendationCount}`);
    if (jsonPath) console.error(`plan json: ${jsonPath}`);
    if (markdownPath) console.error(`plan markdown: ${markdownPath}`);
    if (plan.recommendationCount === 0) return;
    console.log(formatProcessingMarkdown(plan));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
