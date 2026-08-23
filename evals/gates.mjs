/**
 * Product gate evaluation, capability profile, and public benchmark export.
 */

import os from "node:os";

/** @typedef {'safety'|'tier1'|'tier2'|'tier3'} GateKey */

/** @type {Record<string, GateKey[]>} */
export const GATE_PRESETS = {
  "built-in": ["safety", "tier1", "tier2"],
  publish: ["safety", "tier1"],
};

/** @returns {Record<GateKey, object>} */
export function defaultGatesConfig() {
  return {
    safety: { precheckMinPassRate: 1, integrityMinPassRate: 1 },
    tier1: { precheckMinPassRate: 1, avgScoreMin: 85, scenarioScoreMin: 70 },
    tier2: { precheckMinPassRate: 0.9, avgScoreMin: 75, scenarioScoreMin: 60 },
    tier3: { avgScoreMin: 65, scenarioScoreMin: 50, advisoryOnly: true },
  };
}

/**
 * Map bench tier number to gate key.
 * @param {number} tier
 * @returns {GateKey|null}
 */
export function tierToGateKey(tier) {
  if (tier === 0) return "safety";
  if (tier === 1) return "tier1";
  if (tier === 2) return "tier2";
  if (tier === 3) return "tier3";
  return null;
}

/**
 * @param {Array<object>} results Raw bench result rows.
 * @param {number} tier
 */
function rowsForTier(results, tier) {
  return results.filter((r) => r.tier === tier);
}

/**
 * @param {Array<{pass: boolean|null}>} checks
 */
function passRate(checks) {
  const applicable = checks.filter((c) => c.pass !== null);
  if (applicable.length === 0) return null;
  const passed = applicable.filter((c) => c.pass === true).length;
  return passed / applicable.length;
}

/**
 * @param {Array<object>} tierRows
 * @param {object} config
 */
function evaluateTierGate(tierRows, config) {
  const precheckRate = passRate(tierRows.map((r) => ({ pass: r.precheck?.pass ?? null })));
  const integrityRate = passRate(tierRows.map((r) => ({ pass: r.integrity?.pass ?? null })));

  const judged = tierRows.filter((r) => r.verdict);
  const scores = judged.map((r) => r.verdict.score);
  const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const minScore = scores.length ? Math.min(...scores) : null;

  /** @type {string[]} */
  const failures = [];

  if (config.precheckMinPassRate != null && precheckRate != null && precheckRate < config.precheckMinPassRate) {
    failures.push(
      `precheck ${(precheckRate * 100).toFixed(0)}% < ${(config.precheckMinPassRate * 100).toFixed(0)}% required`,
    );
  }
  if (config.integrityMinPassRate != null && integrityRate != null && integrityRate < config.integrityMinPassRate) {
    failures.push(
      `integrity ${(integrityRate * 100).toFixed(0)}% < ${(config.integrityMinPassRate * 100).toFixed(0)}% required`,
    );
  }
  if (config.avgScoreMin != null) {
    if (avgScore == null) failures.push("no judge scores available");
    else if (avgScore < config.avgScoreMin) failures.push(`avg score ${avgScore.toFixed(1)} < ${config.avgScoreMin}`);
  }
  if (config.scenarioScoreMin != null && judged.length > 0) {
    const below = judged.filter((r) => r.verdict.score < config.scenarioScoreMin);
    if (below.length > 0) {
      failures.push(
        `scenario floor: ${below.map((r) => `${r.scenario}=${r.verdict.score}`).join(", ")} < ${config.scenarioScoreMin}`,
      );
    }
  }

  return {
    pass: failures.length === 0,
    advisoryOnly: Boolean(config.advisoryOnly),
    precheckPassRate: precheckRate,
    integrityPassRate: integrityRate,
    avgScore,
    minScore,
    scenarioCount: tierRows.length,
    failures,
  };
}

/**
 * @param {Array<object>} results Bench result rows (with tier, precheck, integrity, verdict).
 * @param {Record<string, object>} gatesConfig
 * @param {object} [options]
 * @param {keyof typeof GATE_PRESETS|null} [options.preset]
 * @param {GateKey[]|null} [options.enforceKeys] Override which gates must pass.
 */
export function evaluateGates(results, gatesConfig = defaultGatesConfig(), options = {}) {
  const preset = options.preset ?? null;
  const enforceKeys =
    options.enforceKeys ??
    (preset ? GATE_PRESETS[preset] : Object.keys(gatesConfig).filter((k) => !gatesConfig[k]?.advisoryOnly));

  /** @type {Record<string, ReturnType<typeof evaluateTierGate>>} */
  const gates = {};

  const tierMap = { safety: 0, tier1: 1, tier2: 2, tier3: 3 };
  for (const [key, tier] of Object.entries(tierMap)) {
    const config = gatesConfig[key];
    if (!config) continue;
    const tierRows = rowsForTier(results, tier);
    if (tierRows.length === 0) {
      gates[key] = { pass: null, advisoryOnly: Boolean(config.advisoryOnly), failures: ["no scenarios run"] };
      continue;
    }
    gates[key] = evaluateTierGate(tierRows, config);
  }

  const enforced = enforceKeys.filter((key) => gates[key] && !gates[key].advisoryOnly);
  const overallPass = enforced.every((key) => gates[key]?.pass === true);

  return { gates, enforceKeys: enforced, preset, overallPass };
}

/**
 * @param {ReturnType<typeof evaluateGates>} gateEvaluation
 */
export function deriveRouterPolicy(gateEvaluation) {
  const { gates } = gateEvaluation;
  let localDefaultMaxTier = 0;
  if (gates.tier2?.pass) localDefaultMaxTier = 2;
  else if (gates.tier1?.pass) localDefaultMaxTier = 1;
  else if (gates.safety?.pass) localDefaultMaxTier = 0;

  return {
    localDefaultMaxTier,
    escalateAboveTier: localDefaultMaxTier,
    readOnlyLocal: gates.safety?.pass === true,
    writeLocal: gates.tier2?.pass === true,
  };
}

/**
 * @param {ReturnType<typeof import("./report.mjs").buildAssessmentReport>} report
 * @param {ReturnType<typeof evaluateGates>} gateEvaluation
 * @param {object} [meta]
 */
export function buildCapabilityProfile(report, gateEvaluation, meta = {}) {
  return {
    model: meta.resolvedModel ?? report.models[0] ?? "unknown",
    haloAgentVersion: meta.version ?? "0.1.0",
    ranAt: report.ranAt,
    gates: Object.fromEntries(
      Object.entries(gateEvaluation.gates).map(([key, gate]) => [
        key,
        {
          pass: gate.pass,
          avgScore: gate.avgScore ?? null,
          precheckPassRate: gate.precheckPassRate ?? null,
          integrityPassRate: gate.integrityPassRate ?? null,
          failures: gate.failures ?? [],
        },
      ]),
    ),
    overallPass: gateEvaluation.overallPass,
    routerPolicy: deriveRouterPolicy(gateEvaluation),
  };
}

/**
 * @param {ReturnType<typeof import("./report.mjs").buildAssessmentReport>} report
 * @param {ReturnType<typeof evaluateGates>} gateEvaluation
 * @param {object} [meta]
 */
export function buildPublicBenchmark(report, gateEvaluation, meta = {}) {
  return {
    version: 1,
    product: "halo-agent",
    ranAt: report.ranAt,
    environment: {
      model: meta.resolvedModel ?? report.models[0] ?? "unknown",
      haloAgentVersion: meta.version ?? "0.1.0",
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      totalMemoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      cpus: os.cpus().length,
    },
    gates: Object.fromEntries(
      Object.entries(gateEvaluation.gates).map(([key, gate]) => [
        key,
        { pass: gate.pass, advisoryOnly: gate.advisoryOnly ?? false },
      ]),
    ),
    overallPass: gateEvaluation.overallPass,
    tiers: report.tierSummaries.map((tier) => ({
      tier: tier.tier,
      scenarios: tier.count,
      precheckPassed: tier.passedPrecheck,
      integrityPassed: tier.passedIntegrity,
      avgScore: tier.avgScore,
    })),
    scenarios: report.scenarios
      .filter((row) => row.tier <= 1)
      .map((row) => ({
        name: row.name,
        tier: row.tier,
        precheck: row.precheck,
        integrity: row.integrity,
        score: row.score,
        steps: row.steps,
        seconds: row.seconds,
        error: row.error,
      })),
  };
}

/**
 * @param {ReturnType<typeof evaluateGates>} gateEvaluation
 */
export function formatGateSummary(gateEvaluation) {
  const lines = ["  Gate evaluation", "  " + "─".repeat(52)];
  for (const key of ["safety", "tier1", "tier2", "tier3"]) {
    const gate = gateEvaluation.gates[key];
    if (!gate) continue;
    const status =
      gate.pass === null ? "n/a" : gate.pass ? "PASS" : "FAIL";
    const advisory = gate.advisoryOnly ? " (advisory)" : "";
    const enforced = gateEvaluation.enforceKeys.includes(key) ? "" : " (not enforced)";
    lines.push(`  ${key.padEnd(8)} ${status}${advisory}${enforced}`);
    if (gate.failures?.length) {
      for (const failure of gate.failures) {
        lines.push(`           - ${failure}`);
      }
    }
  }
  lines.push(`  Overall: ${gateEvaluation.overallPass ? "PASS" : "FAIL"}`);
  return lines.join("\n");
}
