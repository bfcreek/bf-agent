/**
 * Structured JSON + descriptive markdown for recognized-benchmark runs.
 */

import {
  buildArchitectureInsights,
  formatInsightsConsole,
  formatInsightsMarkdown,
} from "../patterns.mjs";

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

/** Runtime settings the Harbor adapter runs with (see adapters/halo_agent.py). */
export const HARBOR_RUN_FLAGS = {
  think: "max",
};

/**
 * @param {object} input
 */
export function buildRecognizedReport(input) {
  const tasks = input.tasks ?? [];
  const overall = input.overall ?? {};
  const flags = input.flags ?? HARBOR_RUN_FLAGS;
  const maxSteps = input.maxSteps ?? null;

  const report = {
    version: 1,
    kind: "recognized",
    suite: input.suite,
    suiteTitle: input.suiteTitle,
    dataset: input.dataset,
    datasetLabel: input.datasetLabel ?? input.dataset,
    agent: input.agent ?? "halo-agent",
    agentVersion: input.agentVersion ?? "0.1.0",
    model: input.model,
    judgeModel: input.judgeModel ?? null,
    harness: input.harness ?? "harbor",
    ranAt: input.ranAt ?? new Date().toISOString(),
    environment: input.environment ?? {},
    notes: input.notes ?? [],
    harborJobDir: input.harborJobDir ?? null,
    maxSteps,
    flags,
    overall: {
      tasks: overall.tasks ?? tasks.length,
      resolved: overall.resolved ?? 0,
      errors: overall.errors ?? 0,
      resolveRate: overall.resolveRate ?? 0,
      judged: overall.judged ?? 0,
      judgeAvg: overall.judgeAvg ?? null,
      processAvg: overall.processAvg ?? null,
      totalSeconds: overall.totalSeconds ?? 0,
      avgSteps: overall.avgSteps ?? null,
      avgToolCalls: overall.avgToolCalls ?? null,
      avgPromptTokens: overall.avgPromptTokens ?? null,
      verifiedRate: overall.verifiedRate ?? null,
      avgHeuristicScore: overall.avgHeuristicScore ?? null,
      flagCounts: overall.flagCounts ?? {},
    },
    tasks: tasks.map((task) => ({
      name: task.name,
      trialName: task.trialName,
      resolved: task.resolved,
      reward: task.reward,
      exception: task.exception,
      seconds: task.seconds,
      trialDir: task.trialDir,
      score: task.verdict?.score ?? task.score ?? null,
      grade: task.verdict?.grade ?? task.grade ?? null,
      outcome: task.verdict?.outcome ?? task.outcome ?? null,
      processScore: task.verdict?.process?.score ?? task.processScore ?? null,
      process: task.verdict?.process ?? task.process ?? null,
      summary: task.verdict?.summary ?? task.summary ?? null,
      strengths: task.verdict?.strengths ?? task.strengths ?? [],
      weaknesses: task.verdict?.weaknesses ?? task.weaknesses ?? [],
      agentImprovements: task.verdict?.agentImprovements ?? task.agentImprovements ?? [],
      judgeError: task.judgeError ?? null,
      steps: task.steps ?? task.stepCount ?? 0,
      stopReason: task.stopReason ?? null,
      toolCalls: task.efficiency?.toolCalls ?? task.toolCalls ?? null,
      promptTokens: task.efficiency?.tokens?.prompt ?? task.promptTokens ?? null,
      efficiencyFlags: task.efficiency?.flags ?? task.efficiencyFlags ?? [],
      heuristicScore: task.efficiency?.heuristicScore ?? task.heuristicScore ?? null,
      efficiency: task.efficiency ?? null,
    })),
    recommendations: collectRecommendations(tasks),
  };

  report.architectureInsights = buildArchitectureInsights(report, {
    history: input.history ?? [],
    flags,
    maxSteps,
  });

  return report;
}

/**
 * @param {ReturnType<typeof buildRecognizedReport>} report
 */
export function formatRecognizedMarkdown(report) {
  const o = report.overall;
  const lines = [
    `# ${report.suiteTitle ?? report.suite}`,
    "",
    `**Ran:** ${report.ranAt}`,
    `**Agent:** ${report.agent} ${report.agentVersion}  |  **Model:** ${report.model}`,
    `**Dataset:** ${report.datasetLabel ?? report.dataset} (\`${report.dataset}\`)`,
    `**Harness:** ${report.harness}`,
  ];
  if (report.judgeModel) lines.push(`**Judge:** Cursor CLI (\`${report.judgeModel}\`)`);
  lines.push("");
  lines.push(
    `**Harbor resolve rate:** ${o.resolved}/${o.tasks} (${pct(o.resolveRate)}) — hidden tests, mechanical`,
  );
  if (o.judgeAvg != null) {
    lines.push(
      `**Cursor judge — outcome:** ${o.judgeAvg.toFixed(1)}/100${o.processAvg != null ? `  |  **process:** ${o.processAvg.toFixed(1)}/100` : ""} — ${o.judged}/${o.tasks} tasks graded`,
    );
  } else {
    lines.push("**Cursor judge:** not run");
  }
  lines.push(`**Errors:** ${o.errors}  |  **Duration:** ${formatDuration(o.totalSeconds)}`);
  lines.push(formatEfficiencyLine(o));
  if (report.harborJobDir) lines.push(`**Harbor job:** \`${report.harborJobDir}\``);
  lines.push("");

  if (report.environment && Object.keys(report.environment).length) {
    lines.push("## Environment", "");
    for (const [key, value] of Object.entries(report.environment)) {
      lines.push(`- **${key}:** ${value}`);
    }
    lines.push("");
  }

  if (report.notes?.length) {
    lines.push("## Notes", "");
    for (const note of report.notes) lines.push(`- ${note}`);
    lines.push("");
  }

  lines.push(
    "## Tasks",
    "",
    "| Task | Harbor | Outcome | Process | Steps | Tools | Flags | Seconds | Summary |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const task of report.tasks) {
    const harbor = task.resolved ? "pass" : task.exception ? "error" : "fail";
    const score = task.score != null ? `${task.score} (${task.grade ?? "—"})` : "—";
    const proc = task.processScore != null ? String(task.processScore) : "—";
    const tools = task.toolCalls != null ? String(task.toolCalls) : "—";
    const flags = task.efficiencyFlags?.length ? task.efficiencyFlags.join(", ") : "—";
    const seconds = task.seconds != null ? formatDuration(task.seconds) : "—";
    const summary = (task.judgeError || task.summary || task.exception || "")
      .replaceAll("|", "\\|")
      .replaceAll("\n", " ");
    lines.push(
      `| ${task.name} | ${harbor} | ${score} | ${proc} | ${task.steps ?? "—"} | ${tools} | ${flags} | ${seconds} | ${summary.slice(0, 160)} |`,
    );
  }
  lines.push("");

  const wasted = report.tasks.filter((t) => t.process?.wastedSteps?.length);
  if (wasted.length) {
    lines.push("## Wasted steps (judge)", "");
    for (const task of wasted) {
      lines.push(`- **${task.name}**`);
      for (const w of task.process.wastedSteps.slice(0, 6)) lines.push(`  - step ${w.step}: ${w.why}`);
      for (const m of task.process.missing ?? []) lines.push(`  - missing: ${m}`);
    }
    lines.push("");
  }

  if (report.recommendations.length > 0) {
    lines.push("## Recommendations for Bitfield Agent", "");
    for (const rec of report.recommendations) {
      const seen = rec.count > 1 ? ` (${rec.count}x: ${rec.tasks.join(", ")})` : "";
      lines.push(`- **[${rec.priority}] ${rec.area}:** ${rec.suggestion}${seen}`);
    }
    lines.push("");
  }

  if (report.architectureInsights?.length) {
    lines.push(formatInsightsMarkdown(report.architectureInsights));
  } else if (Array.isArray(report.architectureInsights)) {
    lines.push(formatInsightsMarkdown([]));
  }

  return lines.join("\n");
}

/**
 * @param {ReturnType<typeof buildRecognizedReport>} report
 */
export function formatRecognizedConsole(report) {
  const o = report.overall;
  const bar = "═".repeat(56);
  const lines = [
    bar,
    `  ${report.suiteTitle ?? report.suite} — recognized bench`,
    bar,
    `  Ran: ${report.ranAt}`,
    `  ${report.agent} ${report.agentVersion}  |  model ${report.model}  |  ${report.datasetLabel ?? report.dataset}`,
    "",
    `  Harbor: ${o.resolved}/${o.tasks} resolved (${pct(o.resolveRate)})  |  errors ${o.errors}  |  ${formatDuration(o.totalSeconds)}`,
  ];
  if (o.judgeAvg != null) {
    lines.push(
      `  Judge:  outcome ${o.judgeAvg.toFixed(1)}/100${o.processAvg != null ? `  |  process ${o.processAvg.toFixed(1)}/100` : ""}  (${o.judged}/${o.tasks} graded)`,
    );
  }
  lines.push(`  ${formatEfficiencyLine(o).replaceAll("**", "")}`);
  lines.push("");
  for (const task of report.tasks) {
    const harbor = task.resolved ? "PASS" : task.exception ? "ERR " : "fail";
    const score = task.score != null ? String(task.score).padStart(3) : " --";
    const proc = task.processScore != null ? `p${String(task.processScore).padStart(3)}` : "p --";
    const tools = task.toolCalls != null ? `${task.steps} steps/${task.toolCalls} tools` : `${task.steps} steps`;
    const flags = task.efficiencyFlags?.length ? `  [${task.efficiencyFlags.join(", ")}]` : "";
    lines.push(`  ${harbor}  ${score} ${proc}  ${task.name}  ${tools}${flags}`);
    if (task.summary) lines.push(`         ${task.summary.slice(0, 100)}`);
    if (task.judgeError) lines.push(`         judge: ${task.judgeError}`);
  }
  if (report.recommendations.length > 0) {
    lines.push("", "  Recommendations");
    for (const rec of report.recommendations.slice(0, 8)) {
      lines.push(`  [${rec.priority}] ${rec.area}: ${rec.suggestion}`);
    }
  }
  const insightBlock = formatInsightsConsole(report.architectureInsights ?? []);
  if (insightBlock) {
    lines.push("", insightBlock.trimEnd());
  }
  lines.push(bar);
  return lines.join("\n");
}

function collectRecommendations(tasks) {
  /** @type {Map<string, {area: string, suggestion: string, priority: string, count: number, tasks: string[]}>} */
  const map = new Map();
  for (const task of tasks) {
    for (const item of task.verdict?.agentImprovements ?? []) {
      const key = `${item.area}::${item.suggestion}`;
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
        if (!existing.tasks.includes(task.name)) existing.tasks.push(task.name);
      } else {
        map.set(key, {
          area: item.area,
          suggestion: item.suggestion,
          priority: item.priority,
          count: 1,
          tasks: [task.name],
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

function pct(rate) {
  return `${(rate * 100).toFixed(1)}%`;
}

/** One line of deterministic efficiency aggregates for the report header. */
function formatEfficiencyLine(o) {
  const parts = [];
  if (o.avgSteps != null) parts.push(`**Avg steps:** ${o.avgSteps.toFixed(1)}`);
  if (o.avgToolCalls != null) parts.push(`**Avg tool calls:** ${o.avgToolCalls.toFixed(1)}`);
  if (o.avgPromptTokens != null) parts.push(`**Avg prompt tokens:** ${Math.round(o.avgPromptTokens)}`);
  if (o.verifiedRate != null) parts.push(`**Verified after last change:** ${pct(o.verifiedRate)}`);
  if (o.avgHeuristicScore != null) parts.push(`**Heuristic efficiency:** ${o.avgHeuristicScore.toFixed(0)}/100`);
  const flags = Object.entries(o.flagCounts ?? {}).sort((a, b) => b[1] - a[1]);
  if (flags.length) parts.push(`**Flags:** ${flags.map(([f, n]) => `${f}×${n}`).join(", ")}`);
  return parts.length ? parts.join("  |  ") : "**Efficiency:** no trace telemetry";
}

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
