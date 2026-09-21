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

import { buildArchitectureInsights } from "./patterns.mjs";
import { localPaths } from "./local-layout.mjs";
import { latestReportPaths } from "./recognized/layout.mjs";
import { TB_SCOREBOARD, loadScoreboardHistory } from "./scoreboard.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Primary edit targets keyed by judge `area` (case-insensitive). The areas
 * match the judge schema: system prompt | tools | loop | compaction | routing | other.
 */
export const AREA_TARGETS = {
  "system prompt": ["src/context-builder.mjs", "src/model-tuning.mjs"],
  tools: [
    "src/tools/builtin.mjs",
    "src/tools/shell.mjs",
    "src/tools/fs.mjs",
    "src/tools/output.mjs",
    "src/tool-registry.mjs",
  ],
  loop: ["src/agent-loop.mjs", "src/index.mjs"],
  compaction: ["src/compaction.mjs"],
  routing: ["src/model-routing.mjs", "src/tier-models.mjs", "src/models-config.mjs"],
  bench: ["evals/dev-bench.mjs", "evals/judge.mjs", "evals/scenarios"],
  other: [],
};

/** Which runtime lever each pattern id implicates. */
const INSIGHT_AREAS = {
  "hollow-completion": "system prompt",
  "budget-exhausted-failures": "tools",
  "expensive-passes": "tools",
  "spinning-on-failures": "tools",
  "blind-edits": "tools",
  "unverified-changes": "system prompt",
  "redundant-reads": "compaction",
  "tool-call-friction": "system prompt",
  "context-pressure": "compaction",
  "context-overflow": "compaction",
  "tests-mostly-failed": "routing",
  "judge-oracle-disagreement": "bench",
  "stable-and-lean": "other",
  "history-efficiency-regression": "tools",
  "history-efficiency-gain": "other",
  "history-outcome-regression": "loop",
};

const SKIP_INSIGHT_IDS = new Set(["stable-and-lean", "history-efficiency-gain"]);

const PATTERN_GUIDANCE = [
  "Pending items are architecture-pattern levers — change the runtime surface the metrics implicate (tool feedback, prompt wording, compaction, routing), not a specific benchmark task.",
  "Do not add prompt text keyed to a task name from this sample, and do not add supervisory machinery (gates, nudges, mid-run model swaps) to the loop; those belong in caller hooks if anywhere.",
  "Skip items with status `skip` — the pattern says the current approach is holding.",
  "Judge notes (if any) are corroborating color, not a punch list. Ignore advice that only fits one task.",
  "Keep changes minimal and focused. Run npm test after edits; add a focused test when the change is testable.",
  "Skip levers that duplicate existing behavior or conflict with LIMITATIONS.md.",
];

const DEFAULT_GUIDANCE = [
  "Judge recommendations below are concrete runtime fixes — implement those in the mapped target files.",
  "Architecture insights are pattern-level approach signals (tool feedback, prompt, compaction, routing). Use them to decide *whether* to change strategy, not as a punch list of edits.",
  "System-prompt changes go in context-builder.mjs (or a per-model overlay in model-tuning.mjs); tool feedback goes in src/tools; loop mechanics in agent-loop.mjs.",
  "Keep changes minimal and focused — one recommendation per logical commit when possible.",
  "Run npm test after edits; add a focused test when the change is testable.",
  "Skip recommendations that are vague, duplicate existing behavior, or conflict with LIMITATIONS.md.",
];

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
 * @param {object} insight
 */
export function areaForInsight(insight) {
  const id = String(insight?.id ?? "");
  if (INSIGHT_AREAS[id]) return INSIGHT_AREAS[id];
  if (/compaction|context|reads/.test(id)) return "compaction";
  if (/tool|edit|spinning|budget/.test(id)) return "tools";
  if (/prompt|verif|hollow/.test(id)) return "system prompt";
  if (/routing|model|tests/.test(id)) return "routing";
  if (/judge|oracle|ablation/.test(id)) return "bench";
  return "other";
}

/**
 * @param {object} insight
 */
export function shouldSkipInsight(insight) {
  if (SKIP_INSIGHT_IDS.has(insight?.id)) return true;
  return /^resist\b/i.test(String(insight?.lever ?? ""));
}

/**
 * @param {object[]} insights
 */
export function itemsFromInsights(insights) {
  return (insights ?? []).map((insight, index) => {
    const area = areaForInsight(insight);
    const skip = shouldSkipInsight(insight);
    return {
      id: index + 1,
      kind: "pattern",
      insightId: insight.id,
      area,
      suggestion: insight.lever ?? "",
      pattern: insight.pattern ?? "",
      priority: insight.priority ?? "medium",
      count: insight.scenarios?.length ?? 1,
      sources: insight.scenarios ?? [],
      targetFiles: targetsForArea(area),
      status: skip ? "skip" : "pending",
      skipReason: skip ? "Pattern says not to change — leave the loop as-is." : null,
    };
  });
}

/**
 * @param {object} report
 * @param {object} [meta]
 */
export function buildProcessingPlan(report, meta = {}) {
  const patterns = meta.patterns === true;
  const architectureInsights = Array.isArray(report?.architectureInsights)
    ? report.architectureInsights
    : [];
  const judgeRecs = extractRecommendations(report);

  const items = patterns
    ? itemsFromInsights(architectureInsights)
    : judgeRecs.map((rec, index) => ({
        id: index + 1,
        kind: "recommendation",
        area: rec.area,
        suggestion: rec.suggestion,
        priority: rec.priority,
        count: rec.count,
        sources: rec.sources,
        targetFiles: targetsForArea(rec.area),
        status: "pending",
      }));

  const pending = items.filter((item) => item.status === "pending");

  return {
    version: 1,
    kind: patterns ? "patterns-plan" : "recommendations-plan",
    mode: patterns ? "patterns" : "recommendations",
    generatedAt: new Date().toISOString(),
    reportPath: meta.reportPath ?? null,
    suite: report.suite ?? report.kind ?? null,
    dataset: report.dataset ?? report.datasetLabel ?? null,
    ranAt: report.ranAt ?? null,
    model: report.model ?? null,
    recommendationCount: pending.length,
    items,
    judgeNotes: patterns ? judgeRecs : [],
    architectureInsights,
    guidance: patterns ? PATTERN_GUIDANCE : DEFAULT_GUIDANCE,
  };
}

/**
 * @param {ReturnType<typeof buildProcessingPlan>} plan
 */
export function formatProcessingMarkdown(plan) {
  const patterns = plan.mode === "patterns";
  const lines = [
    patterns
      ? "# Bitfield Agent — architecture patterns plan"
      : "# Bitfield Agent — bench recommendations plan",
    "",
    `Generated: ${plan.generatedAt}`,
  ];
  if (plan.reportPath) lines.push(`Report: \`${plan.reportPath}\``);
  if (plan.suite) lines.push(`Suite: ${plan.suite}${plan.dataset ? ` (${plan.dataset})` : ""}`);
  if (plan.ranAt) lines.push(`Bench ran: ${plan.ranAt}`);
  if (plan.model) lines.push(`Model: ${plan.model}`);
  if (patterns) lines.push("", `**${plan.recommendationCount}** pattern lever(s) to consider.`, "");
  else lines.push("", `**${plan.recommendationCount}** recommendation(s) to process.`, "");

  const hasInsights = plan.architectureInsights?.length > 0;
  const hasJudgeNotes = plan.judgeNotes?.length > 0;
  if (plan.recommendationCount === 0 && !hasInsights && !hasJudgeNotes && plan.items?.length === 0) {
    lines.push(
      patterns
        ? "No recurring telemetry patterns crossed the evidence threshold. Nothing to implement."
        : "No agent improvements were recorded. Nothing to implement.",
    );
    return lines.join("\n");
  }

  lines.push("## Guidance", "");
  for (const note of plan.guidance) lines.push(`- ${note}`);

  if (plan.items?.length > 0) {
    lines.push("", patterns ? "## Pattern levers" : "## Recommendations", "");

    for (const item of plan.items) {
      const seen =
        item.sources?.length > 0
          ? ` (${item.count > 1 ? `${item.count}x: ` : ""}${item.sources.join(", ")})`
          : "";
      lines.push(`### ${item.id}. [${item.priority}] ${item.area}${seen}`, "");
      if (item.pattern) {
        lines.push(`**Pattern:** ${item.pattern}`, "");
        lines.push(`**Lever:** ${item.suggestion}`, "");
      } else {
        lines.push(item.suggestion, "");
      }
      if (item.targetFiles?.length > 0) {
        lines.push("**Target files:**");
        for (const file of item.targetFiles) lines.push(`- \`${file}\``);
        lines.push("");
      } else {
        lines.push("**Target files:** (area `other` — pick the closest module)", "");
      }
      lines.push(`Status: ${item.status}${item.skipReason ? ` — ${item.skipReason}` : ""}`, "");
    }
  }

  if (!patterns && plan.architectureInsights?.length) {
    lines.push("## Architecture patterns", "");
    lines.push(
      "Evidence-backed approach signals from telemetry. These are not edit tickets — they suggest which lever to reconsider.",
      "",
    );
    for (const insight of plan.architectureInsights) {
      const where = insight.scenarios?.length ? ` _(seen in: ${insight.scenarios.join(", ")})_` : "";
      lines.push(`- **[${insight.priority} · ${insight.source}]** ${insight.pattern}${where}`);
      lines.push(`  - **Lever:** ${insight.lever}`);
    }
    lines.push("");
  }

  if (patterns && hasJudgeNotes) {
    lines.push("## Judge notes (do not treat as tickets)", "");
    lines.push(
      "Freeform Cursor-judge advice from this sample. Use only as color. Skip anything that names a specific task.",
      "",
    );
    for (const rec of plan.judgeNotes) {
      lines.push(`- **[${rec.priority}] ${rec.area}:** ${rec.suggestion}`);
    }
    lines.push("");
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

  let report = await loadReport(reportPath);
  if (options.patterns && (!Array.isArray(report.architectureInsights) || report.architectureInsights.length === 0)) {
    let history = [];
    try {
      history = await loadScoreboardHistory(TB_SCOREBOARD);
    } catch {
      history = [];
    }
    report = {
      ...report,
      architectureInsights: buildArchitectureInsights(report, {
        history,
        flags: report.flags,
        maxSteps: report.maxSteps,
      }),
    };
  }

  const plan = buildProcessingPlan(report, {
    reportPath,
    patterns: options.patterns === true,
  });
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
  --json <path>     Write plan JSON (default: ../halo-agent-benchmark/local/recommendations-plan.json)
  --markdown <path> Write plan markdown (default: ../halo-agent-benchmark/local/recommendations-plan.md)
  --patterns        Plan from architecture-pattern levers, not per-task judge tips
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
    else if (arg === "--patterns") options.patterns = true;
    else {
      console.error(`Unknown option: ${arg}`);
      process.exitCode = 1;
      return;
    }
  }

  if (!options.json && !options.markdown) {
    const paths = localPaths(REPO_ROOT);
    options.json = paths.recommendationsJson;
    options.markdown = paths.recommendationsMd;
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
