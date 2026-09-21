/**
 * Pattern-based architectural insights from bench telemetry.
 *
 * Judge recommendations stay freeform and concrete ("add retry", "shorter
 * error text"). This module does the opposite: it looks across scenario
 * metrics for recurring shapes and names the *lever* the runtime should
 * consider — tool feedback, prompt guidance, budgets, compaction, model
 * choice — without hard-coding scenario tips or model names.
 *
 * Signals come from two places: the outcome oracle (precheck / Harbor reward
 * / judge outcome score) and the deterministic efficiency metrics computed
 * in efficiency.mjs (flags such as `spinning`, `blind-edit`,
 * `no-verification`). Crossing the two tells wasteful-but-right apart from
 * cheap-but-wrong.
 *
 * An insight is emitted only when the evidence threshold is met. Silence is a
 * feature: no pattern is better than a forced recommendation.
 */

/** Minimum scenarios that must exhibit a shape before it counts as a pattern. */
const MIN_PATTERN_SCENARIOS = 2;

/** Outcome score below which a graded scenario is treated as a quality miss. */
const LOW_SCORE = 70;

/** Outcome / process score at or above which a scenario is a clear pass. */
const HIGH_SCORE = 85;

/** Fraction of a step budget that counts as "burning the budget". */
const BUDGET_BURN_RATIO = 0.75;

/**
 * @typedef {object} ScenarioMetrics
 * @property {string} name
 * @property {number|null} score Outcome score.
 * @property {number|null} processScore Judge process score.
 * @property {boolean|null} precheck Oracle pass/fail (precheck or Harbor reward).
 * @property {boolean|null} integrity
 * @property {number} steps
 * @property {number|null} toolCalls
 * @property {number|null} mutations Successful write_file / edit_file calls.
 * @property {string|null} stopReason
 * @property {string[]} flags Efficiency flags.
 * @property {number|null} heuristicScore
 * @property {number|null} budgetUsed
 * @property {number|null} compactions
 * @property {number|null} compactionFailures
 * @property {number|null} truncatedTurns
 * @property {boolean|null} agreesWithOracle Judge outcome vs. oracle.
 * @property {string|null} error
 */

/**
 * @typedef {object} ArchitectureInsight
 * @property {string} id Stable pattern identifier.
 * @property {"run"|"history"|"ablation"} source
 * @property {"high"|"medium"|"low"} priority
 * @property {string} pattern What was observed (evidence-first).
 * @property {string} lever Approach to consider — or why not to change.
 * @property {string[]} scenarios Supporting scenario names (run insights).
 * @property {object} evidence Numeric / boolean support for the claim.
 */

/**
 * Normalize raw bench rows, report scenario rows, or recognized task rows.
 * @param {Array<object>} rows
 * @returns {ScenarioMetrics[]}
 */
export function normalizeScenarioMetrics(rows) {
  return (rows ?? []).map((row) => {
    const efficiency = row.efficiency ?? row.agent?.efficiency ?? null;
    const rawSteps = row.steps ?? row.agent?.steps ?? efficiency?.steps ?? 0;
    const precheck =
      row.precheck?.pass ??
      (typeof row.precheck === "boolean" ? row.precheck : null) ??
      (typeof row.resolved === "boolean" ? row.resolved : null);
    return {
      name: row.name ?? row.scenario ?? "unknown",
      score: row.score ?? row.verdict?.score ?? null,
      processScore: row.processScore ?? row.verdict?.process?.score ?? row.process?.score ?? null,
      precheck,
      integrity: row.integrity?.pass ?? (typeof row.integrity === "boolean" ? row.integrity : null),
      steps: Array.isArray(rawSteps) ? rawSteps.length : Number(rawSteps) || 0,
      toolCalls: row.toolCalls ?? efficiency?.toolCalls ?? null,
      mutations: efficiency?.mutations ?? null,
      stopReason: row.stopReason ?? row.agent?.stopReason ?? efficiency?.stopReason ?? null,
      flags: row.efficiencyFlags ?? efficiency?.flags ?? row.flags ?? [],
      heuristicScore: row.heuristicScore ?? efficiency?.heuristicScore ?? null,
      budgetUsed: efficiency?.budgetUsed ?? null,
      compactions: efficiency?.compactions ?? null,
      compactionFailures: efficiency?.compactionFailures ?? null,
      truncatedTurns: efficiency?.truncatedTurns ?? null,
      agreesWithOracle: row.outcome?.agreesWithOracle ?? row.verdict?.outcome?.agreesWithOracle ?? null,
      error: row.error ?? row.exception ?? null,
    };
  });
}

/**
 * Scenario/task rows from either the local assessment report or a recognized
 * (Terminal-Bench) report.
 * @param {object} report
 */
export function rowsFromReport(report) {
  if (Array.isArray(report?.scenarios) && report.scenarios.length > 0) return report.scenarios;
  if (Array.isArray(report?.tasks)) return report.tasks;
  return [];
}

/**
 * Detect architectural patterns in a single bench run.
 *
 * @param {Array<object>} results Raw scenario rows or report.scenarios
 * @param {object} [meta]
 * @param {number} [meta.maxSteps] Step budget used for the run.
 * @returns {ArchitectureInsight[]}
 */
export function detectRunPatterns(results, meta = {}) {
  const scenarios = normalizeScenarioMetrics(results);
  if (scenarios.length === 0) return [];

  const maxSteps = meta.maxSteps ?? null;
  /** @type {ArchitectureInsight[]} */
  const insights = [];
  const enough = (rows) =>
    rows.length >= MIN_PATTERN_SCENARIOS || (rows.length === 1 && scenarios.length === 1);
  const has = (s, flag) => (s.flags ?? []).includes(flag);

  const failed = scenarios.filter((s) => s.precheck === false || (s.precheck == null && s.score != null && s.score < LOW_SCORE));
  const passed = scenarios.filter((s) => s.precheck === true || (s.precheck == null && s.score != null && s.score >= LOW_SCORE));
  const completed = scenarios.filter((s) => s.stopReason === "completed" || s.stopReason === "empty");
  const mutated = scenarios.filter((s) => (s.mutations ?? 0) > 0);

  // --- Stopping shapes ----------------------------------------------------

  // Stopped as "completed"/"empty" having barely touched the workspace, and failed.
  const hollow = completed.filter(
    (s) =>
      failed.includes(s) &&
      ((s.toolCalls ?? s.steps) <= 1 || has(s, "no-tool-use") || has(s, "empty-retries")),
  );
  if (hollow.length >= 1) {
    insights.push({
      id: "hollow-completion",
      source: "run",
      priority: "high",
      pattern:
        "Runs ended their turn as completed after little or no tool use, and the outcome failed — the model stopped without doing the work.",
      lever:
        "This is a model or prompt problem, not a loop problem. Check that the core prompt makes 'do the task, do not just describe it' unambiguous for this model, and try the next tier up. If a caller needs the loop to push back on early stops, that belongs in a `stop` hook, not in the runtime.",
      scenarios: namesOf(hollow),
      evidence: { count: hollow.length, avgToolCalls: avg(hollow.map((s) => s.toolCalls ?? 0)) },
    });
  }

  // Burned the budget and still failed.
  const burnedFailures = failed.filter(
    (s) => has(s, "budget-exhausted") || has(s, "wall-clock-exhausted") || s.stopReason === "max-steps",
  );
  if (enough(burnedFailures)) {
    const spinning = burnedFailures.filter((s) => has(s, "spinning"));
    insights.push({
      id: "budget-exhausted-failures",
      source: "run",
      priority: "high",
      pattern: `Runs hit the step or wall-clock budget without a passing outcome${spinning.length ? ` (${spinning.length} of them were spinning on repeated failures)` : ""}.`,
      lever:
        spinning.length
          ? "Raising the budget will not help while the trace shows repeats. Fix the feedback loop first: failing run_command output needs the exit code and the useful part of stderr inline, and edit misses need the nearby text, so the model has new information each turn."
          : "Read the trace before raising limits: if steps show steady progress the budget is simply too small for this tier (raise maxSteps / wallClockMs there); if progress stalled, the task exceeds the model and routing should pick a stronger one at startup.",
      scenarios: namesOf(burnedFailures),
      evidence: {
        count: burnedFailures.length,
        spinning: spinning.length,
        maxSteps,
        avgSteps: avg(burnedFailures.map((s) => s.steps)),
      },
    });
  }

  // Passed, but expensively.
  const expensivePasses = passed.filter(
    (s) =>
      (s.budgetUsed != null && s.budgetUsed >= BUDGET_BURN_RATIO) ||
      (maxSteps != null && maxSteps > 0 && s.steps >= maxSteps * BUDGET_BURN_RATIO) ||
      has(s, "spinning") ||
      has(s, "redundant-reads"),
  );
  if (enough(expensivePasses)) {
    insights.push({
      id: "expensive-passes",
      source: "run",
      priority: "low",
      pattern:
        "Scenarios passed but consumed most of the budget or repeated work along the way — correctness without thrift.",
      lever:
        "Look at what the trace re-did rather than at model power: re-reads point at tool output that was too short or got compacted away; repeated commands point at error text the model could not act on. Process scores should catch this before outcome does.",
      scenarios: namesOf(expensivePasses),
      evidence: {
        count: expensivePasses.length,
        avgSteps: avg(expensivePasses.map((s) => s.steps)),
        avgProcessScore: avg(expensivePasses.map((s) => s.processScore)),
      },
    });
  }

  // --- Tool-use discipline ----------------------------------------------

  const spinners = scenarios.filter((s) => has(s, "spinning"));
  if (enough(spinners)) {
    insights.push({
      id: "spinning-on-failures",
      source: "run",
      priority: spinners.some((s) => failed.includes(s)) ? "high" : "medium",
      pattern: "The same failing command or identical tool call was repeated several times in a run.",
      lever:
        "The model only changes course when the tool result gives it something new. Make run_command failures carry the exit code and the relevant stderr lines inline (not only in the spill file), and make sure identical repeats are visible in the transcript rather than compacted into a summary.",
      scenarios: namesOf(spinners),
      evidence: { count: spinners.length, failedOutcomes: spinners.filter((s) => failed.includes(s)).length },
    });
  }

  const blind = scenarios.filter((s) => has(s, "blind-edit") || has(s, "edit-misses"));
  if (enough(blind)) {
    insights.push({
      id: "blind-edits",
      source: "run",
      priority: blind.some((s) => failed.includes(s)) ? "high" : "medium",
      pattern: "Files were edited without being read first, or edit_file repeatedly missed its target snippet.",
      lever:
        "Two runtime levers: edit_file miss messages should show the nearest matching lines so the second attempt lands, and the core prompt should state read-before-edit plainly. If reads did happen earlier, check whether compaction dropped the file contents the edit relied on.",
      scenarios: namesOf(blind),
      evidence: { count: blind.length },
    });
  }

  const unverified = mutated.filter((s) => has(s, "no-verification"));
  if (unverified.length >= MIN_PATTERN_SCENARIOS && unverified.length >= Math.ceil(mutated.length / 2)) {
    insights.push({
      id: "unverified-changes",
      source: "run",
      priority: unverified.some((s) => failed.includes(s)) ? "high" : "medium",
      pattern: "Most runs that changed files never ran a command afterwards — changes shipped unverified.",
      lever:
        "Say it once in the core prompt: after changing code, run the relevant check (tests, build, or the script itself) and report the result. Do not add a verification gate to the loop; a model that skips checks with a clear instruction is a routing signal, not a harness gap.",
      scenarios: namesOf(unverified),
      evidence: { unverified: unverified.length, mutated: mutated.length },
    });
  }

  const rereaders = scenarios.filter((s) => has(s, "redundant-reads"));
  if (enough(rereaders)) {
    insights.push({
      id: "redundant-reads",
      source: "run",
      priority: "medium",
      pattern: "The same file region was read again with nothing changed in between.",
      lever:
        "Re-reads mean the earlier content was not usable when needed: either read_file spilled too aggressively (raise the inline head/tail for source files), or compaction summarized it away (raise keepRecent or keep tool results for recently touched files verbatim).",
      scenarios: namesOf(rereaders),
      evidence: {
        count: rereaders.length,
        withCompaction: rereaders.filter((s) => (s.compactions ?? 0) > 0).length,
      },
    });
  }

  const failingTools = scenarios.filter((s) => has(s, "high-failure-rate") || has(s, "parse-recoveries"));
  if (enough(failingTools)) {
    insights.push({
      id: "tool-call-friction",
      source: "run",
      priority: "medium",
      pattern: "A large share of tool calls failed, or the model needed repeated tool-call parse corrections.",
      lever:
        "This is the model misunderstanding the tool surface. Check the per-model overlay and tool descriptions for this model family, tighten argument error messages to name the expected shape, and consider whether this tier should route to a model with better tool calling.",
      scenarios: namesOf(failingTools),
      evidence: { count: failingTools.length },
    });
  }

  // The model ran the context window dry mid-turn, or compaction was due and
  // silently produced nothing. Both mean the window was never really managed.
  const overflow = scenarios.filter((s) => has(s, "truncated-turns") || has(s, "compaction-failed"));
  if (overflow.length >= 1) {
    insights.push({
      id: "context-overflow",
      source: "run",
      priority: "high",
      pattern:
        "Model calls ended on the output limit before a tool call or answer, and/or compaction was due but produced no summary — the context window was exhausted rather than managed.",
      lever:
        "Check numCtx against this model's reasoning appetite (a thinking model can spend the whole window in its thinking channel), that the compaction summarizer runs with minimal thinking and a num_predict cap, and that truncated turns are re-asked with thinking reduced. If the window is simply too small for the model, raise numCtx or route to a model that fits.",
      scenarios: namesOf(overflow),
      evidence: {
        count: overflow.length,
        truncatedTurns: overflow.reduce((n, s) => n + (s.truncatedTurns ?? 0), 0),
        compactionFailures: overflow.reduce((n, s) => n + (s.compactionFailures ?? 0), 0),
      },
    });
  }

  const contextPressure = scenarios.filter((s) => has(s, "heavy-compaction"));
  if (enough(contextPressure) && contextPressure.some((s) => failed.includes(s))) {
    insights.push({
      id: "context-pressure",
      source: "run",
      priority: "medium",
      pattern: "The transcript was compacted more than once in runs that then failed — context churn is likely costing accuracy.",
      lever:
        "Before touching the prompt, look at what fills the context: tool output spill limits, the size of the system prompt for this model, and numCtx. Compaction that keeps the original request and points at the session file is the safety net, not the plan.",
      scenarios: namesOf(contextPressure),
      evidence: { count: contextPressure.length },
    });
  }

  // --- Outcome shapes ----------------------------------------------------

  const oracleFailures = scenarios.filter((s) => s.precheck === false);
  if (
    oracleFailures.length >= MIN_PATTERN_SCENARIOS &&
    oracleFailures.length >= Math.ceil(scenarios.length / 2)
  ) {
    const flagged = oracleFailures.filter((s) => (s.flags ?? []).some((f) => f !== "no-tool-use"));
    insights.push({
      id: "tests-mostly-failed",
      source: "run",
      priority: "high",
      pattern: "Ground-truth tests failed on most of this sample — the loop is not producing check-passing artifacts.",
      lever:
        flagged.length >= Math.ceil(oracleFailures.length / 2)
          ? "The failing runs carry efficiency flags, so start there: the process problems above are the cheaper fix. Do not hard-code this sample's task names into the prompt."
          : "The failing runs look clean on process, which points at capability rather than harness: this tier needs a stronger model at startup. Do not hard-code task-specific hints into the prompt.",
      scenarios: namesOf(oracleFailures),
      evidence: { failed: oracleFailures.length, total: scenarios.length, flagged: flagged.length },
    });
  }

  const disagreements = scenarios.filter((s) => s.agreesWithOracle === false);
  if (enough(disagreements)) {
    insights.push({
      id: "judge-oracle-disagreement",
      source: "run",
      priority: "medium",
      pattern: "The judge's outcome score disagreed with the mechanical oracle (the anchored score was used).",
      lever:
        "Audit the scenario, not the agent: a precheck that passes work the judge calls incomplete is too loose; one that fails work the judge calls done is checking the wrong artifact or is flaky. Fix the oracle before reading the score trend.",
      scenarios: namesOf(disagreements),
      evidence: { count: disagreements.length },
    });
  }

  // Everything passed and nothing was flagged: do not "improve" what works.
  const graded = scenarios.filter((s) => s.score != null);
  const flaggedAny = scenarios.filter((s) => (s.flags ?? []).some((f) => f !== "no-tool-use"));
  if (
    graded.length >= MIN_PATTERN_SCENARIOS &&
    failed.length === 0 &&
    flaggedAny.length === 0 &&
    graded.every((s) => (s.score ?? 0) >= HIGH_SCORE)
  ) {
    insights.push({
      id: "stable-and-lean",
      source: "run",
      priority: "low",
      pattern: "Strong outcomes with no efficiency flags — the current prompt, tools, and routing held under this load.",
      lever:
        "Resist adding complexity here. Measure a harder tier or a smaller model before changing the prompt or the loop.",
      scenarios: namesOf(graded),
      evidence: {
        avgScore: avg(graded.map((s) => s.score)),
        avgProcessScore: avg(graded.map((s) => s.processScore)),
        scenarios: graded.length,
      },
    });
  }

  return sortInsights(insights);
}

/**
 * Compare scoreboard history for trend and setting-ablation signals.
 *
 * Entries are the JSONL rows appended by dev-bench / recognized runs:
 * `avgScore`, `avgProcessScore`, `passRate`, `avgSteps`, `avgToolCalls`,
 * `avgHeuristicScore`, `scenarios`, plus settings such as `think` and
 * `tierPreset`.
 *
 * @param {object[]} history Scoreboard JSONL entries
 * @param {object} [current] The just-finished scoreboard-shaped entry
 * @returns {ArchitectureInsight[]}
 */
export function detectHistoryPatterns(history, current = null) {
  const entries = [...(history ?? [])];
  if (current) entries.push(current);
  if (entries.length < 2) return [];

  /** @type {ArchitectureInsight[]} */
  const insights = [];

  // Trends: compare the most recent runs with the earlier ones at the same
  // scenario count, so a 2-task smoke run is never compared with a full tier.
  const groups = groupBy(entries.filter((e) => typeof e.avgScore === "number" || typeof e.passRate === "number"), (e) => e.scenarios ?? 0);
  for (const [count, rows] of groups) {
    if (rows.length < 4) continue;
    const recent = rows.slice(-3);
    const earlier = rows.slice(0, rows.length - 3);
    const d = {
      score: avg(recent.map((e) => e.avgScore)) - avg(earlier.map((e) => e.avgScore)),
      pass: avg(recent.map((e) => e.passRate)) - avg(earlier.map((e) => e.passRate)),
      steps: ratio(avg(recent.map((e) => e.avgSteps)), avg(earlier.map((e) => e.avgSteps))),
      tools: ratio(avg(recent.map((e) => e.avgToolCalls)), avg(earlier.map((e) => e.avgToolCalls))),
      process: avg(recent.map((e) => e.avgProcessScore)) - avg(earlier.map((e) => e.avgProcessScore)),
    };
    const evidence = { scenarios: count, recent: recent.length, earlier: earlier.length, ...d };

    if ((d.steps >= 1.25 || d.tools >= 1.25) && d.score < 2 && d.pass < 0.1) {
      insights.push({
        id: "history-efficiency-regression",
        source: "history",
        priority: "medium",
        pattern: `Recent ${count}-scenario runs use ${pctChange(Math.max(d.steps, d.tools))} more steps/tool calls than earlier ones without an outcome gain (Δ score ${d.score.toFixed(1)}).`,
        lever:
          "Something recent made the model work harder for the same result. Diff the efficiency flags between the two windows first; prompt or tool-output changes are the usual cause.",
        scenarios: [],
        evidence,
      });
    } else if (d.steps <= 0.8 && d.score > -2 && d.pass > -0.1) {
      insights.push({
        id: "history-efficiency-gain",
        source: "history",
        priority: "low",
        pattern: `Recent ${count}-scenario runs need ${pctChange(1 / d.steps)} fewer steps at the same or better outcome.`,
        lever: "Keep it. Note what changed between the windows so the gain is attributable.",
        scenarios: [],
        evidence,
      });
    }
    if (d.score <= -5 || d.pass <= -0.15) {
      insights.push({
        id: "history-outcome-regression",
        source: "history",
        priority: "high",
        pattern: `Recent ${count}-scenario runs score lower than earlier ones (Δ outcome ${d.score.toFixed(1)}, Δ pass rate ${(d.pass * 100).toFixed(0)}%).`,
        lever:
          "Treat as a regression until explained: compare models, prompt, and tool changes between the windows. Judge variance alone rarely moves a pass rate.",
        scenarios: [],
        evidence,
      });
    }
  }

  // Setting ablations: runs that differ on one setting with the same
  // scenario count and the other settings held equal.
  for (const key of ["think", "tierPreset"]) {
    const ablation = compareSettingAblation(entries, key, ["think", "tierPreset"]);
    if (!ablation) continue;
    const delta = ablation.aAvg - ablation.bAvg;
    const abs = Math.abs(delta);
    insights.push({
      id: `ablation-${key}-${abs < 3 ? "flat" : delta > 0 ? ablation.a : ablation.b}`,
      source: "ablation",
      priority: abs >= 8 ? "medium" : "low",
      pattern:
        abs < 3
          ? `With other settings held steady, ${key}=${ablation.a} vs ${key}=${ablation.b} changed the average outcome by only ${delta.toFixed(1)} points (${ablation.aN}+${ablation.bN} runs).`
          : `With other settings held steady, ${key}=${delta > 0 ? ablation.a : ablation.b} averages ${Math.max(ablation.aAvg, ablation.bAvg).toFixed(1)} vs ${Math.min(ablation.aAvg, ablation.bAvg).toFixed(1)} for ${key}=${delta > 0 ? ablation.b : ablation.a} (Δ ${abs.toFixed(1)}).`,
      lever:
        abs < 3
          ? `${key} is not moving outcomes on this set — pick the cheaper setting and spend effort elsewhere.`
          : `Prefer ${key}=${delta > 0 ? ablation.a : ablation.b} for this load, and check the step/tool-call averages to see whether the gain came with a cost.`,
      scenarios: [],
      evidence: ablation,
    });
  }

  return sortInsights(insights);
}

/**
 * Build the full insight set for a finished bench report.
 *
 * @param {object} report Assessment or recognized report
 * @param {object} [options]
 * @param {object[]} [options.history] Scoreboard history entries
 * @param {object} [options.flags] Settings for this run (think, tierPreset)
 * @param {number} [options.maxSteps]
 * @returns {ArchitectureInsight[]}
 */
export function buildArchitectureInsights(report, options = {}) {
  const maxSteps = options.maxSteps ?? report?.maxSteps ?? null;
  const flags = options.flags ?? report?.flags ?? {};
  const runInsights = detectRunPatterns(rowsFromReport(report), { maxSteps });

  const overall = report?.overall ?? {};
  const n = overall.scenarios ?? overall.tasks ?? 0;
  const passed = overall.precheckPassed ?? overall.resolved ?? 0;
  const currentEntry =
    report?.overall != null
      ? {
          avgScore: overall.avgScore ?? overall.judgeAvg ?? null,
          avgProcessScore: overall.avgProcessScore ?? overall.processAvg ?? null,
          passRate: n > 0 ? passed / n : null,
          avgSteps: overall.avgSteps ?? null,
          avgToolCalls: overall.avgToolCalls ?? null,
          avgHeuristicScore: overall.avgHeuristicScore ?? null,
          scenarios: n,
          think: flags.think ?? null,
          tierPreset: flags.tierPreset ?? null,
        }
      : null;

  const historyInsights = detectHistoryPatterns(options.history ?? [], currentEntry);
  return sortInsights([...runInsights, ...historyInsights]);
}

/**
 * @param {ArchitectureInsight[]} insights
 */
export function formatInsightsMarkdown(insights) {
  if (!insights?.length) {
    return [
      "## Architecture patterns",
      "",
      "_No recurring telemetry patterns crossed the evidence threshold._",
      "",
    ].join("\n");
  }

  const lines = [
    "## Architecture patterns",
    "",
    "Evidence-backed approach signals — not tip-style fixes. Judge recommendations above stay concrete; these name which *lever* the metrics implicate.",
    "",
  ];

  for (const insight of insights) {
    const tag = insight.priority.toUpperCase();
    const where = insight.scenarios?.length ? ` _(seen in: ${insight.scenarios.join(", ")})_` : "";
    lines.push(`- **[${tag} · ${insight.source}]** ${insight.pattern}${where}`);
    lines.push(`  - **Lever:** ${insight.lever}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * @param {ArchitectureInsight[]} insights
 */
export function formatInsightsConsole(insights) {
  if (!insights?.length) return "";

  const lines = [
    "  Architecture patterns",
    "  " + "─".repeat(52),
  ];
  for (const insight of insights.slice(0, 10)) {
    const tag = `[${insight.priority.toUpperCase()}]`.padEnd(8);
    lines.push(`  ${tag} ${insight.pattern}`);
    if (insight.scenarios?.length) {
      lines.push(`           scenarios: ${insight.scenarios.join(", ")}`);
    }
    lines.push(`           lever: ${insight.lever}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Compare runs that differ on one string/boolean setting, holding the other
 * control settings and the scenario count equal. Needs at least two runs on
 * each side of the best-populated bucket.
 *
 * @param {object[]} entries
 * @param {string} key
 * @param {string[]} controls
 */
function compareSettingAblation(entries, key, controls) {
  const usable = entries.filter(
    (e) => typeof e.avgScore === "number" && e[key] != null && String(e[key]).trim() !== "",
  );
  if (usable.length < 4) return null;
  const others = controls.filter((k) => k !== key);

  /** @type {Map<string, Map<string, object[]>>} signature -> value -> entries */
  const buckets = new Map();
  for (const e of usable) {
    const signature = `${e.scenarios ?? 0}|${others.map((k) => `${k}=${e[k] ?? ""}`).join(",")}`;
    if (!buckets.has(signature)) buckets.set(signature, new Map());
    const byValue = buckets.get(signature);
    const value = String(e[key]);
    if (!byValue.has(value)) byValue.set(value, []);
    byValue.get(value).push(e);
  }

  let best = null;
  for (const byValue of buckets.values()) {
    const values = [...byValue.entries()].filter(([, rows]) => rows.length >= 2);
    if (values.length < 2) continue;
    values.sort((x, y) => y[1].length - x[1].length);
    const [[a, aRows], [b, bRows]] = values;
    const weight = aRows.length + bRows.length;
    if (!best || weight > best.weight) {
      best = {
        setting: key,
        a,
        b,
        aN: aRows.length,
        bN: bRows.length,
        aAvg: avg(aRows.map((e) => e.avgScore)),
        bAvg: avg(bRows.map((e) => e.avgScore)),
        aSteps: avg(aRows.map((e) => e.avgSteps)),
        bSteps: avg(bRows.map((e) => e.avgSteps)),
        weight,
      };
    }
  }
  return best;
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function namesOf(rows) {
  return rows.map((r) => r.name);
}

function avg(nums) {
  const vals = (nums ?? []).filter((n) => typeof n === "number" && Number.isFinite(n));
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function ratio(a, b) {
  if (!b) return 1;
  return a / b;
}

function pctChange(r) {
  return `${Math.round((r - 1) * 100)}%`;
}

function sortInsights(insights) {
  const order = { high: 0, medium: 1, low: 2 };
  return [...insights].sort((a, b) => {
    const pa = order[a.priority] ?? 9;
    const pb = order[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    return a.id.localeCompare(b.id);
  });
}
