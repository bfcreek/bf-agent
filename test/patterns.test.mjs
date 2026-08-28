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

test("normalizeScenarioMetrics accepts raw rows and report rows", () => {
  const raw = normalizeScenarioMetrics([
    {
      scenario: "todo-cli",
      verdict: { score: 84 },
      precheck: { pass: true },
      agent: { steps: 15, escalationCount: 0, cloudUsed: false, verificationPassed: true },
    },
  ]);
  assert.equal(raw[0].name, "todo-cli");
  assert.equal(raw[0].score, 84);
  assert.equal(raw[0].verificationPassed, true);

  const harbor = normalizeScenarioMetrics([
    { name: "openssl-selfsigned-cert", resolved: false, score: 40, exception: "timeout", steps: 12 },
  ]);
  assert.equal(harbor[0].precheck, false);
  assert.equal(harbor[0].error, "timeout");

  const flat = normalizeScenarioMetrics([
    { name: "todo-cli", score: 84, precheck: true, steps: 15, verificationPassed: true },
  ]);
  assert.equal(flat[0].steps, 15);
});

test("verified-but-weak-score fires when the gate and judge disagree", () => {
  const insights = detectRunPatterns([
    {
      name: "a",
      score: 55,
      precheck: true,
      verificationPassed: true,
      steps: 10,
      stopReason: "completed",
    },
    {
      name: "b",
      score: 60,
      precheck: true,
      verificationPassed: true,
      steps: 12,
      stopReason: "completed",
    },
  ]);

  const hit = insights.find((i) => i.id === "verified-but-weak-score");
  assert.ok(hit, "expected verified-but-weak-score pattern");
  assert.match(hit.lever, /acceptance|contract/i);
  assert.equal(hit.scenarios.length, 2);
});

test("hollow-completion catches early completed failures with no verification", () => {
  const insights = detectRunPatterns([
    {
      name: "todo-cli",
      score: 0,
      precheck: false,
      verificationPassed: false,
      steps: 3,
      stopReason: "completed",
      escalationCount: 0,
    },
  ]);

  const hit = insights.find((i) => i.id === "hollow-completion");
  assert.ok(hit);
  assert.match(hit.lever, /empty acceptance|refuse/i);
});

test("costly-escalation-still-failed implicates loop stop conditions over model size", () => {
  const insights = detectRunPatterns(
    [
      {
        name: "a",
        score: 40,
        precheck: false,
        verificationPassed: false,
        steps: 16,
        escalationCount: 2,
        cloudUsed: true,
        stopReason: "completed",
      },
    ],
    { flags: { escalationCloud: true } },
  );

  assert.ok(insights.some((i) => i.id === "costly-escalation-still-failed"));
  assert.ok(insights.some((i) => i.id === "escalation-became-cloud"));
});

test("stable-without-escalation recommends not changing working approach", () => {
  const insights = detectRunPatterns([
    {
      name: "a",
      score: 94,
      precheck: true,
      verificationPassed: true,
      steps: 8,
      escalationCount: 0,
      cloudUsed: false,
      stopReason: "completed",
    },
    {
      name: "b",
      score: 90,
      precheck: true,
      verificationPassed: true,
      steps: 10,
      escalationCount: 0,
      cloudUsed: false,
      stopReason: "completed",
    },
  ]);

  const hit = insights.find((i) => i.id === "stable-without-escalation");
  assert.ok(hit);
  assert.match(hit.lever, /Resist adding complexity/i);
});

test("silence when evidence is below threshold", () => {
  // A single quiet failure is not yet a cross-scenario pattern.
  const insights = detectRunPatterns(
    [
      {
        name: "only",
        score: 50,
        precheck: false,
        verificationPassed: false,
        steps: 10,
        escalationCount: 0,
        stopReason: "completed",
      },
      {
        name: "ok",
        score: 95,
        precheck: true,
        verificationPassed: true,
        steps: 6,
        escalationCount: 0,
        stopReason: "completed",
      },
    ],
    { flags: { escalation: true } },
  );

  assert.equal(
    insights.find((i) => i.id === "failed-without-escalation"),
    undefined,
  );
});

test("history ablation detects memory helping across comparable runs", () => {
  // Other flags held steady so the delta can be attributed to memory alone.
  const history = [
    { memory: true, acceptance: true, critique: true, escalation: true, planning: true, avgScore: 88, scenarios: 3, cloudRate: 0 },
    { memory: true, acceptance: true, critique: true, escalation: true, planning: true, avgScore: 90, scenarios: 3, cloudRate: 0 },
    { memory: false, acceptance: true, critique: true, escalation: true, planning: true, avgScore: 72, scenarios: 3, cloudRate: 0 },
    { memory: false, acceptance: true, critique: true, escalation: true, planning: true, avgScore: 70, scenarios: 3, cloudRate: 0 },
  ];

  const insights = detectHistoryPatterns(history);
  const hit = insights.find((i) => i.id === "ablation-memory-helps");
  assert.ok(hit);
  assert.match(hit.pattern, /memory on/i);
  assert.match(hit.lever, /Episodic memory/i);
  // Must not falsely attribute the same delta to every flag.
  assert.equal(insights.find((i) => i.id === "ablation-acceptance-helps"), undefined);
});

test("bundled flag flips report a package effect, not per-flag credit", () => {
  const history = [
    { memory: true, acceptance: true, critique: true, escalation: true, planning: true, avgScore: 88, scenarios: 3, cloudRate: 0 },
    { memory: true, acceptance: true, critique: true, escalation: true, planning: true, avgScore: 86, scenarios: 3, cloudRate: 0 },
    { memory: false, acceptance: false, critique: false, escalation: false, planning: true, avgScore: 60, scenarios: 3, cloudRate: 0 },
    { memory: false, acceptance: false, critique: false, escalation: false, planning: true, avgScore: 58, scenarios: 3, cloudRate: 0 },
  ];

  const insights = detectHistoryPatterns(history);
  assert.ok(insights.some((i) => i.id === "ablation-closed-loop-helps"));
  assert.equal(insights.find((i) => i.id === "ablation-memory-helps"), undefined);
  assert.match(
    insights.find((i) => i.id === "ablation-closed-loop-helps").pattern,
    /package signal/i,
  );
});

test("history ablation stays quiet without enough paired runs", () => {
  const insights = detectHistoryPatterns([
    { memory: true, avgScore: 88, scenarios: 3 },
    { memory: false, avgScore: 70, scenarios: 3 },
  ]);
  assert.equal(insights.find((i) => i.id?.startsWith("ablation-memory")), undefined);
});

test("buildAssessmentReport attaches architectureInsights", () => {
  const results = [
    {
      scenario: "a",
      tier: 1,
      model: "auto",
      precheck: { pass: false, detail: "fail" },
      agent: {
        steps: 3,
        stopReason: "completed",
        escalationCount: 0,
        cloudUsed: false,
        verificationPassed: false,
      },
      seconds: 10,
      verdict: { score: 0, grade: "F", summary: "Empty.", agentImprovements: [] },
    },
    {
      scenario: "b",
      tier: 1,
      model: "auto",
      precheck: { pass: true, detail: "ok" },
      agent: {
        steps: 8,
        stopReason: "completed",
        escalationCount: 0,
        cloudUsed: false,
        verificationPassed: true,
      },
      seconds: 20,
      verdict: { score: 94, grade: "A", summary: "Good.", agentImprovements: [] },
    },
  ];

  const report = buildAssessmentReport(results, {
    models: ["auto"],
    flags: { acceptance: true, escalation: true },
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

test("tests-mostly-failed fires on a Harbor-style sample majority", () => {
  const insights = detectRunPatterns([
    { name: "a", resolved: false, score: 20, steps: 10, stopReason: "completed" },
    { name: "b", resolved: false, score: 30, steps: 12, stopReason: "completed" },
    { name: "c", resolved: true, score: 80, steps: 8, stopReason: "completed" },
  ]);
  const hit = insights.find((i) => i.id === "tests-mostly-failed");
  assert.ok(hit, "expected tests-mostly-failed pattern");
  assert.equal(hit.scenarios.length, 2);
  assert.match(hit.lever, /task-specific|hard-code/i);
});

test("buildArchitectureInsights reads recognized report tasks", () => {
  const insights = buildArchitectureInsights({
    overall: { tasks: 2, resolved: 0, judgeAvg: 20, cloudRate: 0, avgEscalations: 0 },
    tasks: [
      { name: "alpha", resolved: false, score: 10, steps: 2, stopReason: "completed", verificationPassed: false },
      { name: "beta", resolved: false, score: 15, steps: 3, stopReason: "completed", verificationPassed: false },
    ],
    maxSteps: 80,
  });
  assert.ok(insights.some((i) => i.id === "hollow-completion" || i.id === "tests-mostly-failed"));
});

test("buildArchitectureInsights merges run and history signals", () => {
  const report = {
    overall: { avgScore: 60, cloudRate: 0.5, avgEscalations: 1, scenarios: 2, precheckPassed: 1 },
    scenarios: [
      {
        name: "a",
        score: 40,
        precheck: false,
        verificationPassed: false,
        steps: 16,
        escalationCount: 2,
        cloudUsed: true,
        stopReason: "completed",
      },
      {
        name: "b",
        score: 80,
        precheck: true,
        verificationPassed: true,
        steps: 8,
        escalationCount: 0,
        cloudUsed: false,
        stopReason: "completed",
      },
    ],
  };

  const history = [
    { memory: true, acceptance: true, critique: true, escalation: true, avgScore: 85, scenarios: 2, cloudRate: 0.1 },
    { memory: true, acceptance: true, critique: true, escalation: true, avgScore: 87, scenarios: 2, cloudRate: 0.1 },
    { memory: false, acceptance: false, critique: false, escalation: false, avgScore: 70, scenarios: 2, cloudRate: 0.1 },
    { memory: false, acceptance: false, critique: false, escalation: false, avgScore: 68, scenarios: 2, cloudRate: 0.1 },
  ];

  const insights = buildArchitectureInsights(report, {
    history,
    flags: { escalationCloud: true, memory: true },
  });

  assert.ok(insights.some((i) => i.source === "run"));
  assert.ok(insights.some((i) => i.id === "ablation-closed-loop-helps"));
});
