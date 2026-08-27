/**
 * Pattern-based architectural insights from bench telemetry.
 *
 * Judge recommendations stay freeform and concrete ("add retry", "shorter
 * plans"). This module does the opposite: it looks across scenario metrics for
 * recurring shapes, then names the *approach* that might (or might not) help —
 * acceptance contracts, struggle/escalation, memory, critique, cloud gating —
 * without hard-coding scenario tips or model names.
 *
 * An insight is emitted only when the evidence threshold is met. Silence is a
 * feature: no pattern is better than a forced recommendation.
 */

/** Minimum scenarios that must exhibit a shape before it counts as a pattern. */
const MIN_PATTERN_SCENARIOS = 2;

/** Score below which a graded scenario is treated as a quality miss. */
const LOW_SCORE = 70;

/** Score at or above which a graded scenario is treated as a clear pass. */
const HIGH_SCORE = 85;

/** Fraction of a step budget that counts as "burning the budget". */
const BUDGET_BURN_RATIO = 0.85;

/**
 * @typedef {object} ScenarioMetrics
 * @property {string} name
 * @property {number|null} [score]
 * @property {boolean|null} [precheck]
 * @property {boolean|null} [integrity]
 * @property {number} [steps]
 * @property {string|null} [stopReason]
 * @property {number} [escalationCount]
 * @property {boolean} [cloudUsed]
 * @property {boolean|null} [verificationPassed]
 * @property {boolean|null} [memoryEnabled]
 * @property {string|null} [error]
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
 * Normalize either raw bench rows or an already-built report scenarios list.
 * @param {Array<object>} rows
 * @returns {ScenarioMetrics[]}
 */
export function normalizeScenarioMetrics(rows) {
  return (rows ?? []).map((row) => ({
    name: row.name ?? row.scenario ?? "unknown",
    score: row.score ?? row.verdict?.score ?? null,
    precheck: row.precheck?.pass ?? row.precheck ?? null,
    integrity: row.integrity?.pass ?? row.integrity ?? null,
    steps: row.steps ?? row.agent?.steps ?? 0,
    stopReason: row.stopReason ?? row.agent?.stopReason ?? null,
    escalationCount: row.escalationCount ?? row.agent?.escalationCount ?? 0,
    cloudUsed: row.cloudUsed ?? row.agent?.cloudUsed ?? false,
    verificationPassed: row.verificationPassed ?? row.agent?.verificationPassed ?? null,
    memoryEnabled: row.memoryEnabled ?? row.agent?.memoryEnabled ?? null,
    error: row.error ?? null,
  }));
}

/**
 * Detect architectural patterns in a single bench run.
 *
 * @param {Array<object>} results Raw scenario rows or report.scenarios
 * @param {object} [meta]
 * @param {number} [meta.maxSteps] Step budget used for the run (budget-burn patterns).
 * @param {object} [meta.flags] Feature toggles active for this run.
 * @returns {ArchitectureInsight[]}
 */
export function detectRunPatterns(results, meta = {}) {
  const scenarios = normalizeScenarioMetrics(results);
  if (scenarios.length === 0) return [];

  const maxSteps = meta.maxSteps ?? null;
  const flags = meta.flags ?? {};
  /** @type {ArchitectureInsight[]} */
  const insights = [];

  const graded = scenarios.filter((s) => s.score != null);
  const verified = scenarios.filter((s) => s.verificationPassed === true);
  const unverified = scenarios.filter((s) => s.verificationPassed === false);
  const precheckFail = scenarios.filter((s) => s.precheck === false);
  const precheckPass = scenarios.filter((s) => s.precheck === true);
  const clouded = scenarios.filter((s) => s.cloudUsed === true);
  const escalated = scenarios.filter((s) => (s.escalationCount ?? 0) > 0);
  const completed = scenarios.filter((s) => s.stopReason === "completed");
  const maxed = scenarios.filter((s) => s.stopReason === "max_steps" || s.stopReason === "max-steps");

  // --- Contract / verification shapes ------------------------------------

  // Machine gate says done; human/judge score still weak. The closed loop is
  // measuring the wrong thing, or measuring too little.
  const verifiedButWeak = verified.filter((s) => (s.score ?? 100) < LOW_SCORE);
  if (verifiedButWeak.length >= MIN_PATTERN_SCENARIOS ||
      (verifiedButWeak.length === 1 && scenarios.length === 1)) {
    insights.push({
      id: "verified-but-weak-score",
      source: "run",
      priority: verifiedButWeak.length >= Math.ceil(scenarios.length / 2) ? "high" : "medium",
      pattern:
        "Acceptance verification passed while judge scores stayed low — the machine gate and quality bar disagree.",
      lever:
        "Tighten what 'done' means: richer acceptance checks (output shape, fixture assertions) beat more prompt text. A weak contract that always passes teaches the loop nothing.",
      scenarios: namesOf(verifiedButWeak),
      evidence: {
        verifiedWeak: verifiedButWeak.length,
        verified: verified.length,
        avgScore: avg(verifiedButWeak.map((s) => s.score)),
      },
    });
  }

  // Precheck (the real test suite) fails while the acceptance gate passed —
  // or was never built. Classic empty-contract / silent-success shape.
  const gateMissedPrecheck = scenarios.filter(
    (s) => s.precheck === false && s.verificationPassed === true,
  );
  if (gateMissedPrecheck.length >= 1) {
    insights.push({
      id: "verification-missed-precheck",
      source: "run",
      priority: gateMissedPrecheck.length >= MIN_PATTERN_SCENARIOS ? "high" : "medium",
      pattern:
        "Runs declared verification-passed while the scenario precheck failed — the acceptance contract did not catch the real failure.",
      lever:
        "Treat an empty or always-true contract as a defect, not a pass. Prefer deriving checks from the goal's own verify commands over trusting the model's self-authored Acceptance block.",
      scenarios: namesOf(gateMissedPrecheck),
      evidence: {
        mismatched: gateMissedPrecheck.length,
        precheckFail: precheckFail.length,
      },
    });
  }

  // Precheck green, acceptance red: the gate is stricter than reality, or
  // checking the wrong artifact. Escalating the model will not help.
  const precheckOkGateFail = scenarios.filter(
    (s) => s.precheck === true && s.verificationPassed === false,
  );
  if (precheckOkGateFail.length >= MIN_PATTERN_SCENARIOS ||
      (precheckOkGateFail.length === 1 && scenarios.length <= 2)) {
    insights.push({
      id: "precheck-ok-gate-fail",
      source: "run",
      priority: "medium",
      pattern:
        "Scenario prechecks passed while acceptance verification failed — the gate is disagreeing with the ground-truth tests.",
      lever:
        "Audit whether contract checks mirror the precheck, or whether they demand artifacts the task never required. Over-strict gates burn steps on work that is already done.",
      scenarios: namesOf(precheckOkGateFail),
      evidence: { count: precheckOkGateFail.length },
    });
  }

  // Finished "completed" with almost no work and no verification.
  const hollowCompletions = completed.filter(
    (s) =>
      (s.steps ?? 0) <= 3 &&
      s.verificationPassed !== true &&
      (s.precheck === false || (s.score != null && s.score < LOW_SCORE)),
  );
  if (hollowCompletions.length >= 1) {
    insights.push({
      id: "hollow-completion",
      source: "run",
      priority: "high",
      pattern:
        "Runs stopped as completed after few steps with no successful verification and a failed outcome — the loop accepted a hollow finish.",
      lever:
        "Closed-loop gating should refuse 'done' when no deliverable work happened. An empty acceptance contract must not evaluate to passed; escalate struggle, not silence.",
      scenarios: namesOf(hollowCompletions),
      evidence: {
        count: hollowCompletions.length,
        avgSteps: avg(hollowCompletions.map((s) => s.steps)),
      },
    });
  }

  // --- Escalation / cloud / budget shapes --------------------------------

  // Paid for cloud (or climbed hard) and still failed. Escalation was the
  // wrong lever — or it came too late.
  const costlyFailures = scenarios.filter(
    (s) =>
      (s.cloudUsed || (s.escalationCount ?? 0) >= 2) &&
      (s.precheck === false || (s.score != null && s.score < LOW_SCORE)),
  );
  if (costlyFailures.length >= 1) {
    insights.push({
      id: "costly-escalation-still-failed",
      source: "run",
      priority: costlyFailures.some((s) => s.cloudUsed) ? "high" : "medium",
      pattern:
        "Escalation (and sometimes cloud) was spent, yet the outcome still failed — a stronger model did not fix the underlying approach.",
      lever:
        "Ask whether the struggle signals fire on the right symptoms. If the failure is a missing verify step or a hollow contract, climbing the ladder pays for intelligence the task never gets to use. Prefer fixing the loop's stop conditions before raising the model ceiling.",
      scenarios: namesOf(costlyFailures),
      evidence: {
        count: costlyFailures.length,
        cloudFailures: costlyFailures.filter((s) => s.cloudUsed).length,
        avgEscalations: avg(costlyFailures.map((s) => s.escalationCount)),
      },
    });
  }

  // Cloud used while local ladder likely had headroom unused is hard to know
  // without hardware telemetry; but any cloud use with escalation is a signal
  // that "escalate" meant "pay".
  if (clouded.length >= 1 && (flags.escalationCloud === true || flags.escalationCloud == null)) {
    const cloudAndEscalated = clouded.filter((s) => (s.escalationCount ?? 0) > 0);
    if (cloudAndEscalated.length >= 1) {
      insights.push({
        id: "escalation-became-cloud",
        source: "run",
        priority: "medium",
        pattern:
          "Escalation landed on a cloud model — 'try harder' silently became a paid call.",
        lever:
          "Default escalation to local-only, and treat cloud as an explicit policy choice. On hardware that holds one large model at a time, intensifying the resident model (reasoning effort) is usually cheaper than a full reload or a cloud hop.",
        scenarios: namesOf(cloudAndEscalated),
        evidence: {
          cloudRuns: clouded.length,
          escalatedToCloud: cloudAndEscalated.length,
        },
      });
    }
  }

  // Failed without ever escalating: either struggle detection is blind, or
  // escalation is off. Philosophical answer differs by flag.
  const quietFailures = scenarios.filter(
    (s) =>
      (s.escalationCount ?? 0) === 0 &&
      !s.cloudUsed &&
      (s.precheck === false || (s.score != null && s.score < LOW_SCORE)),
  );
  if (quietFailures.length >= MIN_PATTERN_SCENARIOS && flags.escalation !== false) {
    insights.push({
      id: "failed-without-escalation",
      source: "run",
      priority: "medium",
      pattern:
        "Multiple scenarios failed without any model escalation — struggle signals never crossed the threshold, or there was no stronger local rung.",
      lever:
        "Revisit what counts as struggle (budget pressure with work outstanding, hollow completions, repeated empty turns). Escalating a model that is calmly producing nothing is more valuable than escalating one that is visibly looping. If the start model is already the top local rung, escalation cannot help without cloud — that is a hardware/policy question, not a prompt question.",
      scenarios: namesOf(quietFailures),
      evidence: { quietFailures: quietFailures.length, total: scenarios.length },
    });
  }

  // Escalation idle AND outcomes strong: do not "improve" what is working.
  if (
    escalated.length === 0 &&
    clouded.length === 0 &&
    graded.length >= MIN_PATTERN_SCENARIOS &&
    graded.every((s) => (s.score ?? 0) >= HIGH_SCORE) &&
    precheckFail.length === 0
  ) {
    insights.push({
      id: "stable-without-escalation",
      source: "run",
      priority: "low",
      pattern:
        "Strong scores with zero escalations and no cloud use — the current routing and loop held under this load.",
      lever:
        "Resist adding complexity here. Prefer measuring a harder tier or an ablation (memory/critique off) before changing the escalation ladder or acceptance policy.",
      scenarios: namesOf(graded),
      evidence: {
        avgScore: avg(graded.map((s) => s.score)),
        scenarios: graded.length,
      },
    });
  }

  // Burned the step budget without verifying.
  if (maxSteps != null && maxSteps > 0) {
    const burned = scenarios.filter(
      (s) =>
        (s.steps ?? 0) >= maxSteps * BUDGET_BURN_RATIO &&
        s.verificationPassed !== true,
    );
    if (burned.length >= MIN_PATTERN_SCENARIOS ||
        (burned.length === 1 && scenarios.length === 1)) {
      insights.push({
        id: "budget-burned-unverified",
        source: "run",
        priority: "high",
        pattern:
          "Step budgets were nearly exhausted without a passing acceptance check — the loop spent capacity without proving progress.",
        lever:
          "Mid-run verification under budget pressure should force a course correction earlier, not at the last step. Consider whether planning/critique is consuming paid steps that never touch the deliverable.",
        scenarios: namesOf(burned),
        evidence: {
          burned: burned.length,
          maxSteps,
          avgSteps: avg(burned.map((s) => s.steps)),
        },
      });
    }
  }

  // High step counts on passes: capable but inefficient. Memory / planning
  // philosophy, not model size.
  const expensivePasses = precheckPass.filter(
    (s) => maxSteps != null && maxSteps > 0 && (s.steps ?? 0) >= maxSteps * 0.75,
  );
  if (expensivePasses.length >= MIN_PATTERN_SCENARIOS) {
    insights.push({
      id: "expensive-passes",
      source: "run",
      priority: "low",
      pattern:
        "Scenarios passed but consumed most of the step budget — correctness without thrift.",
      lever:
        "Look at retrieval and planning cost, not raw model power. Episodic memory that injects the wrong lesson, or a critique pass that rewrites a good plan, can inflate steps without changing the outcome grade.",
      scenarios: namesOf(expensivePasses),
      evidence: {
        count: expensivePasses.length,
        avgSteps: avg(expensivePasses.map((s) => s.steps)),
      },
    });
  }

  // Unverified majority with acceptance supposedly on.
  if (
    flags.acceptance !== false &&
    unverified.length >= MIN_PATTERN_SCENARIOS &&
    unverified.length >= Math.ceil(scenarios.length / 2)
  ) {
    insights.push({
      id: "acceptance-mostly-failing",
      source: "run",
      priority: "medium",
      pattern:
        "Acceptance verification failed on most scenarios — the gate is active but rarely satisfied.",
      lever:
        "Decide whether the contract is aspirational or enforceable. If checks are routinely unmet at stop time, either the agent is stopping too early or the contract is authored too loosely to guide mid-run behavior. Self-critique of the plan against the contract is the cheaper lever before escalating models.",
      scenarios: namesOf(unverified),
      evidence: {
        unverified: unverified.length,
        total: scenarios.length,
      },
    });
  }

  return sortInsights(insights);
}

/**
 * Compare scoreboard history for approach-level A/B signals.
 *
 * Looks for runs that differ on a single feature flag while holding the others
 * steady. Bundle flips (memory+acceptance+critique+escalation all at once)
 * are reported as a package effect — not attributed to every flag.
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

  const FLAGS = [
    {
      key: "memory",
      onLabel: "memory on",
      offLabel: "memory off",
      leverOn:
        "Episodic memory appears to help under this load — keep writes gated on verified struggle so the store compounds quality rather than volume.",
      leverOff:
        "Memory on/off did not move outcomes here — retrieval may be injecting noise, or this scenario set does not reward prior lessons. Prefer curation (eviction/win-rate) over adding more writes.",
      leverRegress:
        "Memory-on runs scored worse — treat that as a curation problem first (wrong lessons retrieved), not a reason to delete the store. Readonly mode is the cheap experiment before disabling memory entirely.",
    },
    {
      key: "critique",
      onLabel: "critique on",
      offLabel: "critique off",
      leverOn:
        "Self-critique correlates with better outcomes — keep it, and consider aiming critique specifically at the acceptance contract rather than the plan narrative.",
      leverOff:
        "Critique did not differentiate scores — it may be spending a model call without changing behavior. Gate critique on plan complexity or struggle, rather than running it unconditionally.",
      leverRegress:
        "Critique-on runs scored worse — a rewrite pass can destabilize a workable plan. Prefer critique that only fires when acceptance checks look unsatisfiable.",
    },
    {
      key: "acceptance",
      onLabel: "acceptance on",
      offLabel: "acceptance off",
      leverOn:
        "Acceptance gating correlates with better outcomes — the closed loop is earning its keep. Invest in better contracts, not in bypassing the gate.",
      leverOff:
        "Acceptance on/off did not move scores — checks may be vacuous (empty contracts pass) or the judge already covers the same ground. Empty-contract-as-pass is the defect to fix before declaring the gate useless.",
      leverRegress:
        "Acceptance-on runs scored worse — over-strict or misaligned checks can burn the budget on already-correct work. Align contracts with prechecks before raising the struggle threshold.",
    },
    {
      key: "escalation",
      onLabel: "escalation on",
      offLabel: "escalation off",
      leverOn:
        "Escalation correlates with better outcomes — keep the ladder, and bias toward intensifying the resident model before swapping under VRAM pressure.",
      leverOff:
        "Escalation on/off did not move scores — either struggle never fired, or the start model was already sufficient. Avoid expanding the ladder until struggle signals actually trigger.",
      leverRegress:
        "Escalation-on runs scored worse — model swaps mid-run can thrash context and VRAM. Prefer a stronger start model or intensify-before-swap over more rungs.",
    },
    {
      key: "planning",
      onLabel: "planning on",
      offLabel: "planning off",
      leverOn:
        "Planning correlates with better outcomes — keep it, and make the plan's Acceptance block the source of truth for the verification gate.",
      leverOff:
        "Planning on/off did not move scores — for this load the extra planning turn may be overhead. Consider planning only when the goal is multi-deliverable.",
      leverRegress:
        "Planning-on runs scored worse — plans that invent the wrong stack or burn steps before tools fire are worse than acting. Prefer shorter plans tightly coupled to acceptance checks.",
    },
  ];

  const CONTROL_FLAGS = FLAGS.map((f) => f.key);

  let isolatedAblations = 0;
  for (const flag of FLAGS) {
    const ablation = compareFlagAblation(entries, flag.key, CONTROL_FLAGS);
    if (!ablation) continue;
    isolatedAblations += 1;
    insights.push(...insightFromAblation(flag, ablation));
  }

  // When flags always flip together (the usual "baseline vs closed-loop"
  // labeling), isolate nothing — report the package effect instead of
  // pretending each lever earned the same delta.
  if (isolatedAblations === 0) {
    const bundle = compareClosedLoopBundle(entries);
    if (bundle) {
      const delta = bundle.onAvg - bundle.offAvg;
      const abs = Math.abs(delta);
      if (abs >= 3) {
        insights.push({
          id: delta >= 0 ? "ablation-closed-loop-helps" : "ablation-closed-loop-hurts",
          source: "ablation",
          priority: abs >= 8 ? "high" : "medium",
          pattern: `Across comparable runs, the closed-loop package (memory+acceptance+critique+escalation) averages ${bundle.onAvg.toFixed(1)} vs ${bundle.offAvg.toFixed(1)} without it (Δ ${delta.toFixed(1)}). Flags were not isolated, so this is a package signal — not evidence for any single lever.`,
          lever:
            delta >= 0
              ? "The closed-loop package is earning its keep as a whole. To learn which piece matters, run one-flag ablations (memory off alone, critique off alone, …) rather than rewriting prompts."
              : "The closed-loop package scored worse as a whole. Before tearing it out, isolate which flag regresses — empty contracts and mid-run model swaps are the usual suspects, not 'memory' in the abstract.",
          scenarios: [],
          evidence: bundle,
        });
      } else {
        insights.push({
          id: "ablation-closed-loop-flat",
          source: "ablation",
          priority: "low",
          pattern: `Closed-loop package vs baseline changed avg score by only ${delta.toFixed(1)} across comparable runs — and flags were not isolated.`,
          lever:
            "No strong package signal yet. Prefer one-flag ablations before changing approach; score noise on a 3-scenario set is easy to over-read.",
          scenarios: [],
          evidence: bundle,
        });
      }
    }
  }

  // Cloud rate rising while scores flat/down: paying more for no gain.
  const withCloud = entries.filter((e) => typeof e.cloudRate === "number" && e.avgScore != null);
  if (withCloud.length >= 4) {
    const recent = withCloud.slice(-6);
    const earlier = withCloud.slice(0, Math.max(1, withCloud.length - 6));
    const recentCloud = avg(recent.map((e) => e.cloudRate));
    const earlierCloud = avg(earlier.map((e) => e.cloudRate));
    const recentScore = avg(recent.map((e) => e.avgScore));
    const earlierScore = avg(earlier.map((e) => e.avgScore));
    if (recentCloud - earlierCloud >= 0.15 && recentScore - earlierScore < 2) {
      insights.push({
        id: "history-cloud-without-gain",
        source: "history",
        priority: "high",
        pattern: `Recent runs use cloud more often (${pct(recentCloud)} vs ${pct(earlierCloud)} earlier) without a meaningful score gain (${recentScore.toFixed(1)} vs ${earlierScore.toFixed(1)}).`,
        lever:
          "Cloud spend is climbing as a habit, not as a remedy. Gate cloud behind explicit policy, keep escalation local-first, and ask whether struggle is firing because the contract is empty rather than because the model is weak.",
        scenarios: [],
        evidence: { recentCloud, earlierCloud, recentScore, earlierScore },
      });
    }
  }

  return sortInsights(insights);
}

/**
 * @param {object} flag
 * @param {object} ablation
 * @returns {ArchitectureInsight[]}
 */
function insightFromAblation(flag, ablation) {
  const delta = ablation.onAvg - ablation.offAvg;
  const abs = Math.abs(delta);
  if (abs < 3) {
    return [
      {
        id: `ablation-${flag.key}-flat`,
        source: "ablation",
        priority: "low",
        pattern: `With other flags held steady, ${flag.onLabel} vs ${flag.offLabel} changed avg score by only ${delta.toFixed(1)} points (${ablation.onN}+${ablation.offN} runs).`,
        lever: flag.leverOff,
        scenarios: [],
        evidence: ablation,
      },
    ];
  }
  if (delta >= 3) {
    return [
      {
        id: `ablation-${flag.key}-helps`,
        source: "ablation",
        priority: abs >= 8 ? "high" : "medium",
        pattern: `With other flags held steady, ${flag.onLabel} averages ${ablation.onAvg.toFixed(1)} vs ${ablation.offAvg.toFixed(1)} with ${flag.offLabel} (Δ ${delta.toFixed(1)}).`,
        lever: flag.leverOn,
        scenarios: [],
        evidence: ablation,
      },
    ];
  }
  return [
    {
      id: `ablation-${flag.key}-hurts`,
      source: "ablation",
      priority: abs >= 8 ? "high" : "medium",
      pattern: `With other flags held steady, ${flag.onLabel} averages ${ablation.onAvg.toFixed(1)} vs ${ablation.offAvg.toFixed(1)} with ${flag.offLabel} (Δ ${delta.toFixed(1)}).`,
      lever: flag.leverRegress,
      scenarios: [],
      evidence: ablation,
    },
  ];
}

/**
 * Build the full insight set for a finished bench report.
 *
 * @param {object} report Assessment report from buildAssessmentReport
 * @param {object} [options]
 * @param {object[]} [options.history] Scoreboard history entries
 * @param {object} [options.flags] Feature toggles for this run
 * @param {number} [options.maxSteps]
 * @returns {ArchitectureInsight[]}
 */
export function buildArchitectureInsights(report, options = {}) {
  const runInsights = detectRunPatterns(report?.scenarios ?? [], {
    maxSteps: options.maxSteps,
    flags: options.flags ?? inferFlagsFromReport(report),
  });

  const currentEntry =
    report?.overall != null
      ? {
          avgScore: report.overall.avgScore,
          cloudRate: report.overall.cloudRate,
          avgEscalations: report.overall.avgEscalations,
          passRate:
            report.overall.scenarios > 0
              ? report.overall.precheckPassed / report.overall.scenarios
              : null,
          ...(options.flags ?? {}),
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
 * Compare runs that differ on exactly one boolean flag, holding the other
 * control flags at the same values. Bundle flips are rejected here so they
 * can be reported as a package effect instead.
 *
 * @param {object[]} entries
 * @param {string} flagKey
 * @param {string[]} controlFlags
 */
function compareFlagAblation(entries, flagKey, controlFlags = []) {
  const usable = entries.filter(
    (e) => typeof e.avgScore === "number" && typeof e[flagKey] === "boolean",
  );
  const on = usable.filter((e) => e[flagKey] === true);
  const off = usable.filter((e) => e[flagKey] === false);
  if (on.length < 1 || off.length < 1) return null;

  const others = controlFlags.filter((k) => k !== flagKey);
  /** @type {Map<string, {on: object[], off: object[]}>} */
  const buckets = new Map();

  for (const e of [...on, ...off]) {
    // Skip entries that are missing sibling flag values — we cannot prove isolation.
    if (others.some((k) => typeof e[k] !== "boolean")) continue;
    const n = e.scenarios ?? 0;
    const signature = `${n}|${others.map((k) => `${k}=${e[k]}`).join(",")}`;
    if (!buckets.has(signature)) buckets.set(signature, { on: [], off: [] });
    buckets.get(signature)[e[flagKey] ? "on" : "off"].push(e);
  }

  let best = null;
  for (const pair of buckets.values()) {
    if (pair.on.length >= 1 && pair.off.length >= 1) {
      // Prefer buckets with replication on both sides.
      const weight = pair.on.length + pair.off.length;
      const replicated = pair.on.length >= 2 && pair.off.length >= 2;
      if (
        !best ||
        (replicated && !best.replicated) ||
        (replicated === best.replicated && weight > best.weight)
      ) {
        best = { ...pair, weight, replicated };
      }
    }
  }

  // Require at least one replicated side overall, or both sides with n>=2 across
  // the chosen bucket, before claiming an isolated effect.
  if (!best) return null;
  if (!best.replicated && best.on.length + best.off.length < 4) return null;

  return {
    flag: flagKey,
    isolated: true,
    onAvg: avg(best.on.map((e) => e.avgScore)),
    offAvg: avg(best.off.map((e) => e.avgScore)),
    onN: best.on.length,
    offN: best.off.length,
    onCloud: avg(best.on.map((e) => e.cloudRate ?? 0)),
    offCloud: avg(best.off.map((e) => e.cloudRate ?? 0)),
  };
}

/**
 * Baseline (all closed-loop flags off) vs package (all on), when flags always
 * flip together and isolation is impossible.
 * @param {object[]} entries
 */
function compareClosedLoopBundle(entries) {
  const keys = ["memory", "acceptance", "critique", "escalation"];
  const usable = entries.filter(
    (e) => typeof e.avgScore === "number" && keys.every((k) => typeof e[k] === "boolean"),
  );

  const on = usable.filter((e) => keys.every((k) => e[k] === true));
  const off = usable.filter((e) => keys.every((k) => e[k] === false));
  if (on.length < 2 || off.length < 2) return null;

  const matched = matchByScenarioCount(on, off);
  const onSet = matched?.on ?? on;
  const offSet = matched?.off ?? off;
  if (onSet.length < 2 || offSet.length < 2) return null;

  return {
    flag: "closed-loop-package",
    isolated: false,
    onAvg: avg(onSet.map((e) => e.avgScore)),
    offAvg: avg(offSet.map((e) => e.avgScore)),
    onN: onSet.length,
    offN: offSet.length,
    onCloud: avg(onSet.map((e) => e.cloudRate ?? 0)),
    offCloud: avg(offSet.map((e) => e.cloudRate ?? 0)),
  };
}

function matchByScenarioCount(on, off) {
  /** @type {Map<number, {on: object[], off: object[]}>} */
  const buckets = new Map();
  for (const e of on) {
    const n = e.scenarios ?? 0;
    if (!buckets.has(n)) buckets.set(n, { on: [], off: [] });
    buckets.get(n).on.push(e);
  }
  for (const e of off) {
    const n = e.scenarios ?? 0;
    if (!buckets.has(n)) buckets.set(n, { on: [], off: [] });
    buckets.get(n).off.push(e);
  }

  let best = null;
  for (const pair of buckets.values()) {
    if (pair.on.length >= 2 && pair.off.length >= 2) {
      const weight = pair.on.length + pair.off.length;
      if (!best || weight > best.weight) best = { ...pair, weight };
    }
  }
  return best;
}

function inferFlagsFromReport(report) {
  // Reports do not always carry flags; scoreboard append is the source of truth.
  // Leave undefined so ablation detectors that need booleans simply skip.
  return {
    memory: report?.flags?.memory,
    critique: report?.flags?.critique,
    acceptance: report?.flags?.acceptance,
    escalation: report?.flags?.escalation,
    escalationCloud: report?.flags?.escalationCloud,
    planning: report?.flags?.planning,
  };
}

function namesOf(rows) {
  return rows.map((r) => r.name);
}

function avg(nums) {
  const vals = (nums ?? []).filter((n) => typeof n === "number" && Number.isFinite(n));
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function pct(rate) {
  return `${Math.round((rate ?? 0) * 100)}%`;
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
