/**
 * Build and format the dev-bench assessment report.
 */

import { formatGateSummary } from "./gates.mjs";

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

/**
 * @param {Array<object>} results
 * @param {object} meta
 */
export function buildAssessmentReport(results, meta = {}) {
  const judged = results.filter((r) => r.verdict);
  const totalSeconds = results.reduce((sum, r) => sum + (r.seconds ?? 0), 0);

  const byTier = new Map();
  for (const row of results) {
    if (!byTier.has(row.tier)) byTier.set(row.tier, []);
    byTier.get(row.tier).push(row);
  }

  /** @type {Array<{tier: number, count: number, judged: number, avgScore: number|null, minScore: number|null, maxScore: number|null, passedPrecheck: number}>} */
  const tierSummaries = [...byTier.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tier, rows]) => {
      const tierJudged = rows.filter((r) => r.verdict);
      const scores = tierJudged.map((r) => r.verdict.score);
      const precheckPassed = rows.filter((r) => r.precheck?.pass === true).length;
      const integrityPassed = rows.filter((r) => r.integrity?.pass === true).length;
      const integrityChecked = rows.filter((r) => r.integrity?.pass != null).length;
      return {
        tier,
        count: rows.length,
        judged: tierJudged.length,
        avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
        minScore: scores.length ? Math.min(...scores) : null,
        maxScore: scores.length ? Math.max(...scores) : null,
        passedPrecheck: precheckPassed,
        passedIntegrity: integrityPassed,
        integrityChecked,
      };
    });

  const overallScores = judged.map((r) => r.verdict.score);
  const overallAvg = overallScores.length
    ? overallScores.reduce((a, b) => a + b, 0) / overallScores.length
    : null;

  const recommendations = collectRecommendations(judged);
  const stoppedEarly = meta.stoppedAtTier != null;

  return {
    ranAt: meta.ranAt ?? new Date().toISOString(),
    models: meta.models ?? [],
    judgeModel: meta.judgeModel ?? "auto",
    progression: meta.progression ?? false,
    stoppedEarly,
    stoppedAtTier: meta.stoppedAtTier ?? null,
    stopReason: meta.stopReason ?? null,
    gateEvaluation: meta.gateEvaluation ?? null,
    overall: {
      scenarios: results.length,
      judged: judged.length,
      avgScore: overallAvg,
      grade: overallAvg != null ? scoreToGrade(overallAvg) : null,
      totalSeconds,
      precheckPassed: results.filter((r) => r.precheck?.pass === true).length,
      integrityPassed: results.filter((r) => r.integrity?.pass === true).length,
      integrityChecked: results.filter((r) => r.integrity?.pass != null).length,
      errors: results.filter((r) => r.error).length,
      avgSteps: results.length
        ? results.reduce((sum, r) => sum + (r.agent?.steps ?? 0), 0) / results.length
        : null,
      cloudRate: results.length
        ? results.filter((r) => r.agent?.cloudUsed).length / results.length
        : null,
      avgEscalations: results.length
        ? results.reduce((sum, r) => sum + (r.agent?.escalationCount ?? 0), 0) / results.length
        : null,
    },
    tierSummaries,
    scenarios: results.map((row) => ({
      name: row.scenario,
      tier: row.tier,
      model: row.model,
      score: row.verdict?.score ?? null,
      grade: row.verdict?.grade ?? null,
      precheck: row.precheck?.pass,
      precheckDetail: row.precheck?.detail,
      integrity: row.integrity?.pass,
      integrityDetail: row.integrity?.detail,
      steps: row.agent?.steps ?? 0,
      stopReason: row.agent?.stopReason,
      escalationCount: row.agent?.escalationCount ?? 0,
      cloudUsed: row.agent?.cloudUsed ?? false,
      verificationPassed: row.agent?.verificationPassed ?? null,
      memoryEnabled: row.agent?.memoryEnabled ?? null,
      seconds: row.seconds,
      summary: row.verdict?.summary ?? null,
      error: row.error ?? null,
      judgeError: row.judgeError ?? null,
    })),
    recommendations,
  };
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
  lines.push("  halo-agent dev bench — assessment report");
  lines.push(bar);
  lines.push(`  Ran: ${report.ranAt}`);
  lines.push(`  Agent model(s): ${report.models.join(", ")}  |  Judge: ${report.judgeModel}`);
  if (report.progression) lines.push(`  Mode: tier progression${report.stoppedEarly ? " (stopped early)" : ""}`);
  lines.push("");

  if (report.overall.avgScore != null) {
    lines.push(
      `  Overall: ${report.overall.avgScore.toFixed(1)}/100 (${report.overall.grade}) — ${report.overall.judged}/${report.overall.scenarios} graded`,
    );
    lines.push(
      `  Precheck pass: ${report.overall.precheckPassed}/${report.overall.scenarios}  |  Integrity: ${report.overall.integrityPassed}/${report.overall.integrityChecked}  |  Duration: ${formatDuration(report.overall.totalSeconds)}`,
    );
  } else {
    lines.push(`  Scenarios: ${report.overall.scenarios}  |  Duration: ${formatDuration(report.overall.totalSeconds)}`);
  }
  if (report.stopReason) lines.push(`  ${report.stopReason}`);
  lines.push("");

  if (report.tierSummaries.length > 1 || report.progression) {
    lines.push("  Tier breakdown");
    lines.push("  " + "─".repeat(52));
    for (const tier of report.tierSummaries) {
      const scoreStr = tier.avgScore != null ? tier.avgScore.toFixed(1).padStart(5) : "  n/a";
      const barVisual = tier.avgScore != null ? scoreBar(tier.avgScore) : "          ";
      lines.push(
        `  Tier ${tier.tier}  ${barVisual}  ${scoreStr}  (${tier.passedPrecheck}/${tier.count} precheck, ${tier.passedIntegrity}/${tier.integrityChecked} integrity, ${tier.judged} graded)`,
      );
    }
    lines.push("");
  }

  lines.push("  Scores by scenario");
  lines.push("  " + "─".repeat(52));
  for (const row of report.scenarios) {
    const score = row.score != null ? String(row.score).padStart(3) : " --";
    const grade = (row.grade ?? "").padEnd(3);
    const pre =
      row.precheck === true ? "ok" : row.precheck === false ? "FAIL" : "—";
    const integ =
      row.integrity === true ? "ok" : row.integrity === false ? "FAIL" : "—";
    const err = row.error ? `  ERROR: ${row.error}` : "";
    lines.push(
      `  ${score} ${grade}  tier ${row.tier}  ${row.name.padEnd(22)}  pre ${pre}  integ ${integ}${err}`,
    );
    if (row.summary) lines.push(`         ${row.summary.slice(0, 100)}${row.summary.length > 100 ? "…" : ""}`);
  }
  lines.push("");

  if (report.recommendations.length > 0) {
    lines.push("  Recommendations for halo-agent");
    lines.push("  " + "─".repeat(52));
    for (const rec of report.recommendations.slice(0, 12)) {
      const tag = `[${rec.priority.toUpperCase()}]`.padEnd(8);
      const count = rec.count > 1 ? ` (${rec.count}x, ${rec.scenarios.join(", ")})` : "";
      lines.push(`  ${tag} ${rec.area}: ${rec.suggestion}${count}`);
    }
    lines.push("");
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
    "# halo-agent dev bench report",
    "",
    `**Ran:** ${report.ranAt}`,
    `**Agent model(s):** ${report.models.join(", ")}`,
    `**Judge:** ${report.judgeModel}`,
    "",
  ];

  if (report.overall.avgScore != null) {
    lines.push(
      `**Overall score:** ${report.overall.avgScore.toFixed(1)}/100 (${report.overall.grade})`,
    );
    lines.push(
      `**Graded:** ${report.overall.judged}/${report.overall.scenarios} scenarios | **Precheck pass:** ${report.overall.precheckPassed}/${report.overall.scenarios} | **Integrity pass:** ${report.overall.integrityPassed}/${report.overall.integrityChecked} | **Duration:** ${formatDuration(report.overall.totalSeconds)}`,
    );
  }
  if (report.stopReason) lines.push(`**Note:** ${report.stopReason}`);
  lines.push("");

  if (report.tierSummaries.length > 0) {
    lines.push(
      "## Tier breakdown",
      "",
      "| Tier | Avg score | Precheck | Integrity | Graded |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const tier of report.tierSummaries) {
      const avg = tier.avgScore != null ? tier.avgScore.toFixed(1) : "—";
      lines.push(
        `| ${tier.tier} | ${avg} | ${tier.passedPrecheck}/${tier.count} | ${tier.passedIntegrity}/${tier.integrityChecked} | ${tier.judged}/${tier.count} |`,
      );
    }
    lines.push("");
  }

  lines.push(
    "## Scenarios",
    "",
    "| Score | Grade | Tier | Scenario | Precheck | Integrity | Steps |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const row of report.scenarios) {
    const pre = row.precheck === true ? "pass" : row.precheck === false ? "fail" : "—";
    const integ = row.integrity === true ? "pass" : row.integrity === false ? "fail" : "—";
    lines.push(
      `| ${row.score ?? "—"} | ${row.grade ?? "—"} | ${row.tier} | ${row.name} | ${pre} | ${integ} | ${row.steps} |`,
    );
    if (row.summary) lines.push(`| | | | *${row.summary.replaceAll("|", "\\|")}* | | |`);
  }
  lines.push("");

  if (report.recommendations.length > 0) {
    lines.push("## Recommendations", "");
    for (const rec of report.recommendations) {
      lines.push(`- **[${rec.priority}] ${rec.area}:** ${rec.suggestion}`);
      if (rec.count > 1) lines.push(`  - Seen ${rec.count}x in: ${rec.scenarios.join(", ")}`);
    }
    lines.push("");
  }

  if (report.gateEvaluation) {
    lines.push("## Gates", "", "```");
    lines.push(formatGateSummary(report.gateEvaluation));
    lines.push("```", "");
  }

  return lines.join("\n");
}

function scoreToGrade(score) {
  if (score >= 93) return "A";
  if (score >= 90) return "A-";
  if (score >= 87) return "B+";
  if (score >= 83) return "B";
  if (score >= 80) return "B-";
  if (score >= 77) return "C+";
  if (score >= 73) return "C";
  if (score >= 70) return "C-";
  if (score >= 67) return "D+";
  if (score >= 60) return "D";
  return "F";
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
