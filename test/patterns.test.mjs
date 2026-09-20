import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildArchitectureInsights,
  detectHistoryPatterns,
  detectRunPatterns,
  formatInsightsMarkdown,
  normalizeScenarioMetrics,
} from "../evals/patterns.mjs";
import { buildAssessmentReport, formatReportMarkdown } from "../evals/report.mjs";

const clean = { flags: [], heuristicScore: 100, toolCalls: 6, mutations: 1, stopReason: "completed" };

test("normalizeScenarioMetrics accepts raw rows, report rows, and Harbor rows", () => {
  const raw = normalizeScenarioMetrics([
    {
      scenario: "todo-cli",
      verdict: { score: 84, process: { score: 70 }, outcome: { agreesWithOracle: true } },
      precheck: { pass: true },
      agent: {
        steps: 15,
        stopReason: "completed",
        efficiency: { toolCalls: 9, mutations: 2, flags: ["no-verification"], heuristicScore: 85, budgetUsed: 0.5 },
      },
    },
  ]);
  assert.equal(raw[0].name, "todo-cli");
  assert.equal(raw[0].score, 84);
  assert.equal(raw[0].processScore, 70);
  assert.equal(raw[0].toolCalls, 9);
  assert.equal(raw[0].mutations, 2);
  assert.deepEqual(raw[0].flags, ["no-verification"]);
  assert.equal(raw[0].agreesWithOracle, true);

  const harbor = normalizeScenarioMetrics([
    { name: "openssl-selfsigned-cert", resolved: false, score: 40, exception: "timeout", steps: 12, efficiencyFlags: ["spinning"] },
  ]);
  assert.equal(harbor[0].precheck, false);
  assert.equal(harbor[0].error, "timeout");
  assert.deepEqual(harbor[0].flags, ["spinning"]);

  const flat = normalizeScenarioMetrics([{ name: "todo-cli", score: 84, precheck: true, steps: 15 }]);
  assert.equal(flat[0].steps, 15);
  assert.deepEqual(flat[0].flags, []);
});

test("hollow-completion catches early completed failures with no tool use", () => {
  const insights = detectRunPatterns([
    {
      name: "todo-cli",
      score: 0,
      precheck: false,
      steps: 1,
      stopReason: "completed",
      efficiency: { toolCalls: 0, flags: ["no-tool-use"], heuristicScore: 100 },
    },
  ]);

  const hit = insights.find((i) => i.id === "hollow-completion");
  assert.ok(hit);
  assert.match(hit.lever, /prompt|stop hook/i);
});

test("spinning failures implicate tool feedback, not the budget", () => {
  const spin = { toolCalls: 20, mutations: 1, flags: ["spinning", "budget-exhausted"], heuristicScore: 70, budgetUsed: 1 };
  const insights = detectRunPatterns(
    [
      { name: "a", score: 30, precheck: false, steps: 40, stopReason: "max-steps", efficiency: spin },
      { name: "b", score: 35, precheck: false, steps: 40, stopReason: "max-steps", efficiency: spin },
    ],
    { maxSteps: 40 },
  );

  const burned = insights.find((i) => i.id === "budget-exhausted-failures");
  assert.ok(burned);
  assert.match(burned.lever, /Raising the budget will not help/);
  assert.equal(burned.evidence.spinning, 2);
  assert.ok(insights.some((i) => i.id === "spinning-on-failures" && i.priority === "high"));
});

test("unverified-changes fires when most mutating runs skip a follow-up command", () => {
  const unverified = { toolCalls: 5, mutations: 2, flags: ["no-verification"], heuristicScore: 85 };
  const insights = detectRunPatterns([
    { name: "a", score: 60, precheck: false, steps: 6, stopReason: "completed", efficiency: unverified },
    { name: "b", score: 88, precheck: true, steps: 6, stopReason: "completed", efficiency: unverified },
    { name: "c", score: 90, precheck: true, steps: 8, stopReason: "completed", efficiency: clean },
  ]);

  const hit = insights.find((i) => i.id === "unverified-changes");
  assert.ok(hit);
  assert.equal(hit.priority, "high");
  assert.deepEqual(hit.evidence, { unverified: 2, mutated: 3 });
  assert.match(hit.lever, /Do not add a verification gate/);
});

test("redundant reads point at spill limits or compaction", () => {
  const rereads = { toolCalls: 12, mutations: 1, flags: ["redundant-reads"], heuristicScore: 90, compactions: 1 };
  const insights = detectRunPatterns([
    { name: "a", score: 90, precheck: true, steps: 12, stopReason: "completed", efficiency: rereads },
    { name: "b", score: 92, precheck: true, steps: 14, stopReason: "completed", efficiency: rereads },
  ]);

  const hit = insights.find((i) => i.id === "redundant-reads");
  assert.ok(hit);
  assert.equal(hit.evidence.withCompaction, 2);
  assert.match(hit.lever, /compaction|spill/i);
  // Passed, but flagged for repeats.
  assert.ok(insights.some((i) => i.id === "expensive-passes"));
  assert.equal(insights.find((i) => i.id === "stable-and-lean"), undefined);
});

test("stable-and-lean recommends not changing a working setup", () => {
  const insights = detectRunPatterns([
    { name: "a", score: 94, precheck: true, steps: 8, stopReason: "completed", efficiency: clean },
    { name: "b", score: 90, precheck: true, steps: 10, stopReason: "completed", efficiency: clean },
  ]);

  const hit = insights.find((i) => i.id === "stable-and-lean");
  assert.ok(hit);
  assert.match(hit.lever, /Resist adding complexity/i);
});

test("judge-oracle-disagreement audits the scenario, not the agent", () => {
  const rows = [
    { name: "a", score: 70, precheck: true, steps: 8, stopReason: "completed", outcome: { agreesWithOracle: false }, efficiency: clean },
    { name: "b", score: 50, precheck: false, steps: 8, stopReason: "completed", outcome: { agreesWithOracle: false }, efficiency: clean },
  ];
  const hit = detectRunPatterns(rows).find((i) => i.id === "judge-oracle-disagreement");
  assert.ok(hit);
  assert.match(hit.lever, /Fix the oracle/);
});

test("silence when evidence is below threshold", () => {
  const insights = detectRunPatterns([
    { name: "only", score: 50, precheck: false, steps: 10, stopReason: "completed", efficiency: { ...clean, flags: ["blind-edit"] } },
    { name: "ok", score: 95, precheck: true, steps: 6, stopReason: "completed", efficiency: clean },
  ]);

  assert.equal(insights.find((i) => i.id === "blind-edits"), undefined);
  assert.equal(insights.find((i) => i.id === "tests-mostly-failed"), undefined);
  assert.equal(insights.find((i) => i.id === "stable-and-lean"), undefined);
});

test("tests-mostly-failed distinguishes process flags from capability", () => {
  const flagged = detectRunPatterns([
    { name: "a", resolved: false, score: 20, steps: 10, stopReason: "completed", efficiencyFlags: ["spinning"] },
    { name: "b", resolved: false, score: 30, steps: 12, stopReason: "completed", efficiencyFlags: ["blind-edit"] },
    { name: "c", resolved: true, score: 80, steps: 8, stopReason: "completed", efficiencyFlags: [] },
  ]).find((i) => i.id === "tests-mostly-failed");
  assert.ok(flagged, "expected tests-mostly-failed pattern");
  assert.equal(flagged.scenarios.length, 2);
  assert.match(flagged.lever, /process problems above/);
  assert.match(flagged.lever, /hard-code/);

  const capability = detectRunPatterns([
    { name: "a", resolved: false, score: 20, steps: 10, stopReason: "completed", efficiencyFlags: [] },
    { name: "b", resolved: false, score: 30, steps: 12, stopReason: "completed", efficiencyFlags: [] },
  ]).find((i) => i.id === "tests-mostly-failed");
  assert.match(capability.lever, /stronger model/);
});

test("history trends compare runs at the same scenario count", () => {
  const history = [
    { avgScore: 80, passRate: 0.7, avgSteps: 10, avgToolCalls: 8, scenarios: 3 },
    { avgScore: 82, passRate: 0.7, avgSteps: 10, avgToolCalls: 8, scenarios: 3 },
    { avgScore: 81, passRate: 0.7, avgSteps: 11, avgToolCalls: 9, scenarios: 3 },
    { avgScore: 60, passRate: 0.3, avgSteps: 25, avgToolCalls: 20, scenarios: 1 }, // smoke run, different bucket
    { avgScore: 81, passRate: 0.7, avgSteps: 15, avgToolCalls: 13, scenarios: 3 },
    { avgScore: 80, passRate: 0.7, avgSteps: 16, avgToolCalls: 14, scenarios: 3 },
    { avgScore: 82, passRate: 0.7, avgSteps: 15, avgToolCalls: 13, scenarios: 3 },
  ];

  const insights = detectHistoryPatterns(history);
  const hit = insights.find((i) => i.id === "history-efficiency-regression");
  assert.ok(hit, "expected efficiency regression");
  assert.equal(hit.evidence.scenarios, 3);
  assert.equal(insights.find((i) => i.id === "history-outcome-regression"), undefined);
});

test("history ablation isolates one setting with others held steady", () => {
  const history = [
    { think: "max", tierPreset: "default", avgScore: 88, avgSteps: 10, scenarios: 3 },
    { think: "max", tierPreset: "default", avgScore: 90, avgSteps: 10, scenarios: 3 },
    { think: "off", tierPreset: "default", avgScore: 72, avgSteps: 9, scenarios: 3 },
    { think: "off", tierPreset: "default", avgScore: 70, avgSteps: 9, scenarios: 3 },
  ];

  const insights = detectHistoryPatterns(history);
  const hit = insights.find((i) => i.id === "ablation-think-max");
  assert.ok(hit);
  assert.match(hit.pattern, /think=max averages/);
  assert.equal(insights.find((i) => i.id?.startsWith("ablation-tierPreset")), undefined);
});

test("history ablation stays quiet without enough paired runs", () => {
  const insights = detectHistoryPatterns([
    { think: "max", avgScore: 88, scenarios: 3 },
    { think: "off", avgScore: 70, scenarios: 3 },
  ]);
  assert.equal(insights.find((i) => i.id?.startsWith("ablation-")), undefined);
});

test("buildAssessmentReport attaches architectureInsights", () => {
  const results = [
    {
      scenario: "a",
      tier: 1,
      model: "auto",
      precheck: { pass: false, detail: "fail" },
      agent: { steps: 1, stopReason: "completed", efficiency: { toolCalls: 0, flags: ["no-tool-use"], heuristicScore: 100 } },
      seconds: 10,
      verdict: { score: 0, grade: "F", summary: "Empty.", agentImprovements: [] },
    },
    {
      scenario: "b",
      tier: 1,
      model: "auto",
      precheck: { pass: true, detail: "ok" },
      agent: { steps: 8, stopReason: "completed", efficiency: clean },
      seconds: 20,
      verdict: { score: 94, grade: "A", summary: "Good.", agentImprovements: [] },
    },
  ];

  const report = buildAssessmentReport(results, {
    models: ["auto"],
    flags: { think: "max" },
    maxSteps: 15,
  });

  assert.ok(Array.isArray(report.architectureInsights));
  assert.ok(report.architectureInsights.some((i) => i.id === "hollow-completion"));

  const md = formatReportMarkdown(report);
  assert.match(md, /Architecture patterns/);
  assert.match(md, /Lever:/);
});

test("formatInsightsMarkdown explains empty evidence", () => {
  const md = formatInsightsMarkdown([]);
  assert.match(md, /No recurring telemetry patterns/);
});

test("buildArchitectureInsights reads recognized report tasks", () => {
  const insights = buildArchitectureInsights({
    overall: { tasks: 2, resolved: 0, judgeAvg: 20 },
    tasks: [
      { name: "alpha", resolved: false, score: 10, steps: 2, stopReason: "completed", efficiencyFlags: ["no-tool-use"], toolCalls: 0 },
      { name: "beta", resolved: false, score: 15, steps: 3, stopReason: "completed", efficiencyFlags: ["no-tool-use"], toolCalls: 0 },
    ],
    maxSteps: 80,
  });
  assert.ok(insights.some((i) => i.id === "hollow-completion"));
  assert.ok(insights.some((i) => i.id === "tests-mostly-failed"));
});

test("buildArchitectureInsights merges run and history signals", () => {
  const report = {
    overall: { avgScore: 60, avgProcessScore: 70, scenarios: 2, precheckPassed: 1, avgSteps: 12 },
    flags: { think: "max", tierPreset: "default" },
    scenarios: [
      { name: "a", score: 40, precheck: false, steps: 16, stopReason: "completed", efficiency: { ...clean, flags: ["spinning"] } },
      { name: "b", score: 80, precheck: true, steps: 8, stopReason: "completed", efficiency: { ...clean, flags: ["spinning"] } },
    ],
  };

  const history = [
    { think: "max", tierPreset: "default", avgScore: 85, scenarios: 2 },
    { think: "max", tierPreset: "default", avgScore: 87, scenarios: 2 },
    { think: "off", tierPreset: "default", avgScore: 70, scenarios: 2 },
    { think: "off", tierPreset: "default", avgScore: 68, scenarios: 2 },
  ];

  const insights = buildArchitectureInsights(report, { history });

  assert.ok(insights.some((i) => i.source === "run" && i.id === "spinning-on-failures"));
  assert.ok(insights.some((i) => i.source === "ablation" && i.id.startsWith("ablation-think")));
});
