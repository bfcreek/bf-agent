/**
 * Build and format the dev-bench assessment report.
 */

import { summarizeEfficiency } from "./efficiency.mjs";
import { formatGateSummary } from "./gates.mjs";
import { scoreToGrade } from "./judge.mjs";
import {
  buildArchitectureInsights,
  formatInsightsConsole,
  formatInsightsMarkdown,
} from "./patterns.mjs";

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

/**
 * @param {Array<object>} results
 * @param {object} meta
 * @param {object} [meta.insightOptions] Flags / history for architecture patterns.
 */
export function buildAssessmentReport(results, meta = {}) {
  const judged = results.filter((r) => r.verdict);
  const totalSeconds = results.reduce((sum, r) => sum + (r.seconds ?? 0), 0);

  const byTier = new Map();
  for (const row of results) {
    if (!byTier.has(row.tier)) byTier.set(row.tier, []);
    byTier.get(row.tier).push(row);
  }

  /** @type {Array<{tier: number, count: number, judged: number, avgScore: number|null, avgProcessScore: number|null, minScore: number|null, maxScore: number|null, passedPrecheck: number}>} */
  const tierSummaries = [...byTier.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tier, rows]) => {
      const tierJudged = rows.filter((r) => r.verdict);
      const scores = tierJudged.map((r) => r.verdict.score);
      const processScores = tierJudged
        .map((r) => r.verdict.process?.score)
        .filter((s) => typeof s === "number");
      const precheckPassed = rows.filter((r) => r.precheck?.pass === true).length;
      const integrityPassed = rows.filter((r) => r.integrity?.pass === true).length;
      const integrityChecked = rows.filter((r) => r.integrity?.pass != null).length;
      return {
        tier,
        count: rows.length,
        judged: tierJudged.length,
        avgScore: avgOf(scores),
        avgProcessScore: avgOf(processScores),
        minScore: scores.length ? Math.min(...scores) : null,
        maxScore: scores.length ? Math.max(...scores) : null,
        passedPrecheck: precheckPassed,
        passedIntegrity: integrityPassed,
        integrityChecked,
      };
    });

  const overallAvg = avgOf(judged.map((r) => r.verdict.score));
  const overallProcessAvg = avgOf(
    judged.map((r) => r.verdict.process?.score).filter((s) => typeof s === "number"),
  );
  const efficiency = summarizeEfficiency(results.map((r) => r.agent?.efficiency));

  const recommendations = collectRecommendations(judged);
  const stoppedEarly = meta.stoppedAtTier != null;

  const report = {
    ranAt: meta.ranAt ?? new Date().toISOString(),
    models: meta.models ?? [],
    judgeModel: meta.judgeModel ?? "auto",
    progression: meta.progression ?? false,
    stoppedEarly,
    stoppedAtTier: meta.stoppedAtTier ?? null,
    stopReason: meta.stopReason ?? null,
    gateEvaluation: meta.gateEvaluation ?? null,
    flags: meta.flags ?? null,
    overall: {
      scenarios: results.length,
      judged: judged.length,
      avgScore: overallAvg,
      grade: overallAvg != null ? scoreToGrade(overallAvg) : null,
      avgProcessScore: overallProcessAvg,
      totalSeconds,
      precheckPassed: results.filter((r) => r.precheck?.pass === true).length,
      integrityPassed: results.filter((r) => r.integrity?.pass === true).length,
      integrityChecked: results.filter((r) => r.integrity?.pass != null).length,
      errors: results.filter((r) => r.error).length,
      avgSteps: results.length
        ? results.reduce((sum, r) => sum + (r.agent?.steps ?? 0), 0) / results.length
        : null,
      avgToolCalls: efficiency.avgToolCalls,
      avgPromptTokens: efficiency.avgPromptTokens,
      verifiedRate: efficiency.verifiedRate,
      avgHeuristicScore: efficiency.avgHeuristicScore,
      flagCounts: efficiency.flagCounts,
    },
    tierSummaries,
    scenarios: results.map((row) => ({
      name: row.scenario,
      tier: row.tier,
      model: row.model,
      score: row.verdict?.score ?? null,
      grade: row.verdict?.grade ?? null,
      outcome: row.verdict?.outcome ?? null,
      processScore: row.verdict?.process?.score ?? null,
      process: row.verdict?.process ?? null,
      precheck: row.precheck?.pass,
      precheckDetail: row.precheck?.detail,
      integrity: row.integrity?.pass,
      integrityDetail: row.integrity?.detail,
      steps: row.agent?.steps ?? 0,
      stopReason: row.agent?.stopReason,
      toolCalls: row.agent?.efficiency?.toolCalls ?? row.agent?.toolCalls ?? null,
      promptTokens: row.agent?.efficiency?.tokens?.prompt ?? null,
      efficiencyFlags: row.agent?.efficiency?.flags ?? [],
      heuristicScore: row.agent?.efficiency?.heuristicScore ?? null,
      efficiency: row.agent?.efficiency ?? null,
      seconds: row.seconds,
      summary: row.verdict?.summary ?? null,
      error: row.error ?? null,
      judgeError: row.judgeError ?? null,
    })),
    recommendations,
  };

  report.architectureInsights = buildArchitectureInsights(report, {
    history: meta.history ?? [],
    flags: meta.flags ?? {},
    maxSteps: meta.maxSteps,
  });

  return report;
}

/**
 * @param {Array<{verdict?: {agentImprovements?: Array<{area: string, suggestion: string, priority: string}>}}>} judged
 */
function collectRecommendations(judged) {
  /** @type {Map<string, {area: string, suggestion: string, priority: string, count: number, scenarios: string[]}>} */
  const map = new Map();
  for (const row of judged) {
    for (const item of row.verdict?.agentImprovements ?? []) {
      const key = `${item.area}::${item.suggestion}`;
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        map.set(key, {
          area: item.area,
          suggestion: item.suggestion,
          priority: item.priority,
          count: 1,
          scenarios: [],
        });
      }
      const entry = map.get(key);
      if (!entry.scenarios.includes(row.scenario)) entry.scenarios.push(row.scenario);
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
 * @param {ReturnType<typeof buildAssessmentReport>} report
 */
export function formatReportConsole(report) {
  const lines = [];
  const bar = "═".repeat(56);
  lines.push(bar);
  lines.push("  Bitfield Agent dev bench — assessment report");
  lines.push(bar);
  lines.push(`  Ran: ${report.ranAt}`);
  lines.push(`  Agent model(s): ${report.models.join(", ")}  |  Judge: ${report.judgeModel}`);
  if (report.progression) lines.push(`  Mode: tier progression${report.stoppedEarly ? " (stopped early)" : ""}`);
  lines.push("");

  if (report.overall.avgScore != null) {
    const proc =
      report.overall.avgProcessScore != null
        ? `  |  Process: ${report.overall.avgProcessScore.toFixed(1)}/100`
        : "";
    lines.push(
      `  Outcome: ${report.overall.avgScore.toFixed(1)}/100 (${report.overall.grade})${proc} — ${report.overall.judged}/${report.overall.scenarios} graded`,
    );
    lines.push(
      `  Precheck pass: ${report.overall.precheckPassed}/${report.overall.scenarios}  |  Integrity: ${report.overall.integrityPassed}/${report.overall.integrityChecked}  |  Duration: ${formatDuration(report.overall.totalSeconds)}`,
    );
  } else {
    lines.push(`  Scenarios: ${report.overall.scenarios}  |  Duration: ${formatDuration(report.overall.totalSeconds)}`);
  }
  const effLine = formatEfficiencyLine(report.overall);
  if (effLine) lines.push(`  ${effLine}`);
  if (report.stopReason) lines.push(`  ${report.stopReason}`);
  lines.push("");

  if (report.tierSummaries.length > 1 || report.progression) {
    lines.push("  Tier breakdown");
    lines.push("  " + "─".repeat(52));
    for (const tier of report.tierSummaries) {
      const scoreStr = tier.avgScore != null ? tier.avgScore.toFixed(1).padStart(5) : "  n/a";
      const procStr = tier.avgProcessScore != null ? ` proc ${tier.avgProcessScore.toFixed(1)}` : "";
      const barVisual = tier.avgScore != null ? scoreBar(tier.avgScore) : "          ";
      lines.push(
        `  Tier ${tier.tier}  ${barVisual}  ${scoreStr}${procStr}  (${tier.passedPrecheck}/${tier.count} precheck, ${tier.passedIntegrity}/${tier.integrityChecked} integrity, ${tier.judged} graded)`,
      );
    }
    lines.push("");
  }

  lines.push("  Scores by scenario (outcome / process)");
  lines.push("  " + "─".repeat(52));
  for (const row of report.scenarios) {
    const score = row.score != null ? String(row.score).padStart(3) : " --";
    const grade = (row.grade ?? "").padEnd(3);
    const proc = row.processScore != null ? `p${String(row.processScore).padStart(3)}` : "p --";
    const pre =
      row.precheck === true ? "ok" : row.precheck === false ? "FAIL" : "—";
    const integ =
      row.integrity === true ? "ok" : row.integrity === false ? "FAIL" : "—";
    const tools = row.toolCalls != null ? `${row.steps} steps/${row.toolCalls} tools` : `${row.steps} steps`;
    const flags = row.efficiencyFlags?.length ? `  [${row.efficiencyFlags.join(", ")}]` : "";
    const err = row.error ? `  ERROR: ${row.error}` : "";
    lines.push(
      `  ${score} ${grade} ${proc}  tier ${row.tier}  ${row.name.padEnd(22)}  pre ${pre}  integ ${integ}  ${tools}${flags}${err}`,
    );
    if (row.summary) lines.push(`         ${row.summary.slice(0, 100)}${row.summary.length > 100 ? "…" : ""}`);
  }
  lines.push("");

  if (report.recommendations.length > 0) {
    lines.push("  Recommendations for Bitfield Agent");
    lines.push("  " + "─".repeat(52));
    for (const rec of report.recommendations.slice(0, 12)) {
      const tag = `[${rec.priority.toUpperCase()}]`.padEnd(8);
      const count = rec.count > 1 ? ` (${rec.count}x, ${rec.scenarios.join(", ")})` : "";
      lines.push(`  ${tag} ${rec.area}: ${rec.suggestion}${count}`);
    }
    lines.push("");
  }

  const insightBlock = formatInsightsConsole(report.architectureInsights ?? []);
  if (insightBlock) {
    lines.push(insightBlock);
  }

  if (report.gateEvaluation) {
    lines.push(formatGateSummary(report.gateEvaluation));
    lines.push("");
  }

  lines.push(bar);
  return lines.join("\n");
}

/**
 * @param {ReturnType<typeof buildAssessmentReport>} report
 */
export function formatReportMarkdown(report) {
  const lines = [
    "# Bitfield Agent dev bench report",
    "",
    `**Ran:** ${report.ranAt}`,
    `**Agent model(s):** ${report.models.join(", ")}`,
    `**Judge:** ${report.judgeModel}`,
    "",
  ];

  if (report.overall.avgScore != null) {
    const proc =
      report.overall.avgProcessScore != null
        ? ` | **Process score:** ${report.overall.avgProcessScore.toFixed(1)}/100`
        : "";
    lines.push(
      `**Outcome score:** ${report.overall.avgScore.toFixed(1)}/100 (${report.overall.grade})${proc}`,
    );
    lines.push(
      `**Graded:** ${report.overall.judged}/${report.overall.scenarios} scenarios | **Precheck pass:** ${report.overall.precheckPassed}/${report.overall.scenarios} | **Integrity pass:** ${report.overall.integrityPassed}/${report.overall.integrityChecked} | **Duration:** ${formatDuration(report.overall.totalSeconds)}`,
    );
  }
  const effLine = formatEfficiencyLine(report.overall, { markdown: true });
  if (effLine) lines.push(effLine);
  if (report.stopReason) lines.push(`**Note:** ${report.stopReason}`);
  lines.push("");

  if (report.tierSummaries.length > 0) {
    lines.push(
      "## Tier breakdown",
      "",
      "| Tier | Outcome | Process | Precheck | Integrity | Graded |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const tier of report.tierSummaries) {
      const avg = tier.avgScore != null ? tier.avgScore.toFixed(1) : "—";
      const proc = tier.avgProcessScore != null ? tier.avgProcessScore.toFixed(1) : "—";
      lines.push(
        `| ${tier.tier} | ${avg} | ${proc} | ${tier.passedPrecheck}/${tier.count} | ${tier.passedIntegrity}/${tier.integrityChecked} | ${tier.judged}/${tier.count} |`,
      );
    }
    lines.push("");
  }

  lines.push(
    "## Scenarios",
    "",
    "| Outcome | Grade | Process | Tier | Scenario | Precheck | Integrity | Steps | Tools | Tokens | Flags |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const row of report.scenarios) {
    const pre = row.precheck === true ? "pass" : row.precheck === false ? "fail" : "—";
    const integ = row.integrity === true ? "pass" : row.integrity === false ? "fail" : "—";
    const tools = row.toolCalls != null ? row.toolCalls : "—";
    const tokens = row.promptTokens != null ? row.promptTokens : "—";
    const flags = row.efficiencyFlags?.length ? row.efficiencyFlags.join(", ") : "—";
    lines.push(
      `| ${row.score ?? "—"} | ${row.grade ?? "—"} | ${row.processScore ?? "—"} | ${row.tier} | ${row.name} | ${pre} | ${integ} | ${row.steps} | ${tools} | ${tokens} | ${flags} |`,
    );
    if (row.summary) lines.push(`| | | | | *${row.summary.replaceAll("|", "\\|")}* | | | | | | |`);
  }
  lines.push("");

  const wasted = report.scenarios.filter((r) => r.process?.wastedSteps?.length || r.process?.missing?.length);
  if (wasted.length > 0) {
    lines.push("## Wasted steps (judge)", "");
    lines.push("_Step numbers refer to the agent trace in each scenario's `.halo-bench/agent-steps.txt`._", "");
    for (const row of wasted) {
      lines.push(`- **${row.name}**`);
      for (const w of row.process.wastedSteps ?? []) lines.push(`  - step ${w.step}: ${w.why}`);
      for (const m of row.process.missing ?? []) lines.push(`  - missing: ${m}`);
    }
    lines.push("");
  }

  if (report.recommendations.length > 0) {
    lines.push("## Recommendations", "");
    lines.push("_Judge-authored concrete fixes (deduped across scenarios)._");
    lines.push("");
    for (const rec of report.recommendations) {
      lines.push(`- **[${rec.priority}] ${rec.area}:** ${rec.suggestion}`);
      if (rec.count > 1) lines.push(`  - Seen ${rec.count}x in: ${rec.scenarios.join(", ")}`);
    }
    lines.push("");
  }

  lines.push(formatInsightsMarkdown(report.architectureInsights ?? []));

  if (report.gateEvaluation) {
    lines.push("## Gates", "", "```");
    lines.push(formatGateSummary(report.gateEvaluation));
    lines.push("```", "");
  }

  return lines.join("\n");
}

function avgOf(nums) {
  const vals = (nums ?? []).filter((n) => typeof n === "number" && Number.isFinite(n));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

/**
 * Deterministic efficiency aggregates in one line (empty when no telemetry).
 * @param {object} o report.overall
 */
function formatEfficiencyLine(o, { markdown = false } = {}) {
  const b = (s) => (markdown ? `**${s}**` : s);
  const parts = [];
  if (o.avgSteps != null) parts.push(`${b("Avg steps:")} ${o.avgSteps.toFixed(1)}`);
  if (o.avgToolCalls != null) parts.push(`${b("Avg tool calls:")} ${o.avgToolCalls.toFixed(1)}`);
  if (o.avgPromptTokens != null) parts.push(`${b("Avg prompt tokens:")} ${Math.round(o.avgPromptTokens)}`);
  if (o.verifiedRate != null) parts.push(`${b("Verified after last change:")} ${Math.round(o.verifiedRate * 100)}%`);
  if (o.avgHeuristicScore != null) parts.push(`${b("Heuristic efficiency:")} ${o.avgHeuristicScore.toFixed(0)}/100`);
  const flags = Object.entries(o.flagCounts ?? {}).sort((a, b2) => b2[1] - a[1]);
  if (flags.length) parts.push(`${b("Flags:")} ${flags.map(([f, n]) => `${f}×${n}`).join(", ")}`);
  return parts.length > 1 ? parts.join(markdown ? " | " : "  |  ") : "";
}

function scoreBar(score) {
  const filled = Math.round(score / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}
