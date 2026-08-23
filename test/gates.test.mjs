import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GATE_PRESETS,
  buildCapabilityProfile,
  buildPublicBenchmark,
  defaultGatesConfig,
  deriveRouterPolicy,
  evaluateGates,
  formatGateSummary,
} from "../evals/gates.mjs";
import { buildAssessmentReport } from "../evals/report.mjs";

function sampleResults() {
  return [
    {
      scenario: "safety-read-only",
      tier: 0,
      precheck: { pass: true, detail: "ok" },
      integrity: { pass: true, detail: "ok" },
      verdict: null,
    },
    {
      scenario: "readme-port",
      tier: 1,
      precheck: { pass: true, detail: "ok" },
      integrity: { pass: true, detail: "ok" },
      verdict: { score: 90, grade: "A-" },
    },
    {
      scenario: "greet-module",
      tier: 1,
      precheck: { pass: true, detail: "ok" },
      integrity: { pass: null, detail: "no integrity rules" },
      verdict: { score: 80, grade: "B" },
    },
    {
      scenario: "fix-failing-tests",
      tier: 2,
      precheck: { pass: true, detail: "ok" },
      integrity: { pass: true, detail: "ok" },
      verdict: { score: 78, grade: "C+" },
    },
  ];
}

test("evaluateGates passes built-in preset on strong results", () => {
  const evaluation = evaluateGates(sampleResults(), defaultGatesConfig(), { preset: "built-in" });
  assert.equal(evaluation.gates.safety.pass, true);
  assert.equal(evaluation.gates.tier1.pass, true);
  assert.equal(evaluation.gates.tier2.pass, true);
  assert.equal(evaluation.overallPass, true);
});

test("evaluateGates fails safety on integrity miss", () => {
  const results = sampleResults();
  results[0].integrity = { pass: false, detail: "unexpected adds: evil.txt" };
  const evaluation = evaluateGates(results, defaultGatesConfig(), { preset: "built-in" });
  assert.equal(evaluation.gates.safety.pass, false);
  assert.equal(evaluation.overallPass, false);
});

test("evaluateGates fails tier1 on scenario score floor", () => {
  const results = sampleResults();
  results[2].verdict.score = 65;
  const evaluation = evaluateGates(results, defaultGatesConfig(), { preset: "built-in" });
  assert.equal(evaluation.gates.tier1.pass, false);
  assert.match(evaluation.gates.tier1.failures.join(" "), /scenario floor/);
});

test("publish preset ignores tier2", () => {
  const results = sampleResults();
  results[3].verdict.score = 40;
  const evaluation = evaluateGates(results, defaultGatesConfig(), { preset: "publish" });
  assert.equal(evaluation.enforceKeys.join(","), "safety,tier1");
  assert.equal(evaluation.overallPass, true);
});

test("deriveRouterPolicy escalates when tier2 fails", () => {
  const evaluation = evaluateGates(sampleResults(), defaultGatesConfig(), { preset: "built-in" });
  assert.deepEqual(deriveRouterPolicy(evaluation), {
    localDefaultMaxTier: 2,
    escalateAboveTier: 2,
    readOnlyLocal: true,
    writeLocal: true,
  });

  const weak = sampleResults();
  weak[3].verdict.score = 50;
  const weakEval = evaluateGates(weak, defaultGatesConfig(), { preset: "built-in" });
  assert.equal(deriveRouterPolicy(weakEval).localDefaultMaxTier, 1);
  assert.equal(deriveRouterPolicy(weakEval).writeLocal, false);
});

test("buildCapabilityProfile includes router policy", () => {
  const results = sampleResults();
  const report = buildAssessmentReport(results, { models: ["gpt-oss:20b"] });
  const evaluation = evaluateGates(results, defaultGatesConfig(), { preset: "built-in" });
  const profile = buildCapabilityProfile(report, evaluation, {
    resolvedModel: "gpt-oss:20b",
    version: "0.1.0",
  });
  assert.equal(profile.model, "gpt-oss:20b");
  assert.equal(profile.gates.tier1.pass, true);
  assert.equal(profile.routerPolicy.writeLocal, true);
});

test("buildPublicBenchmark includes tier 0-1 scenarios only", () => {
  const results = sampleResults();
  const report = buildAssessmentReport(results, { models: ["gpt-oss:20b"] });
  const evaluation = evaluateGates(results, defaultGatesConfig(), { preset: "publish" });
  const pub = buildPublicBenchmark(report, evaluation, { resolvedModel: "gpt-oss:20b" });
  assert.equal(pub.version, 1);
  assert.ok(pub.scenarios.every((s) => s.tier <= 1));
  assert.equal(pub.environment.model, "gpt-oss:20b");
});

test("formatGateSummary lists failures", () => {
  const results = sampleResults();
  results[0].integrity = { pass: false, detail: "bad" };
  const evaluation = evaluateGates(results, defaultGatesConfig(), { preset: "built-in" });
  const text = formatGateSummary(evaluation);
  assert.match(text, /safety\s+FAIL/);
  assert.match(text, /integrity/);
});

test("GATE_PRESETS built-in and publish differ", () => {
  assert.deepEqual(GATE_PRESETS["built-in"], ["safety", "tier1", "tier2"]);
  assert.deepEqual(GATE_PRESETS.publish, ["safety", "tier1"]);
});
