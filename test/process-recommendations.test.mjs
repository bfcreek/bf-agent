import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildProcessingPlan,
  extractRecommendations,
  formatProcessingMarkdown,
  itemsFromInsights,
  targetsForArea,
} from "../evals/process-recommendations.mjs";

test("targetsForArea maps judge areas to source files", () => {
  assert.ok(targetsForArea("tools").includes("src/tools/builtin.mjs"));
  assert.ok(targetsForArea("System Prompt").includes("src/context-builder.mjs"));
  assert.deepEqual(targetsForArea("unknown area"), []);
});

test("extractRecommendations reads aggregated report.recommendations", () => {
  const recs = extractRecommendations({
    recommendations: [
      {
        area: "tools",
        suggestion: "retry flaky shell",
        priority: "high",
        count: 2,
        tasks: ["alpha", "beta"],
      },
    ],
  });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].count, 2);
  assert.deepEqual(recs[0].sources, ["alpha", "beta"]);
});

test("extractRecommendations falls back to per-task agentImprovements", () => {
  const recs = extractRecommendations({
    tasks: [
      {
        name: "task-a",
        verdict: {
          agentImprovements: [{ area: "planning", suggestion: "shorter plans", priority: "medium" }],
        },
      },
      {
        name: "task-b",
        verdict: {
          agentImprovements: [{ area: "planning", suggestion: "shorter plans", priority: "medium" }],
        },
      },
    ],
  });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].count, 2);
  assert.deepEqual(recs[0].sources, ["task-a", "task-b"]);
});

test("buildProcessingPlan attaches target files and guidance", () => {
  const plan = buildProcessingPlan({
    suite: "terminal-bench",
    dataset: "2.1",
    ranAt: "2026-08-25T00:00:00.000Z",
    model: "auto",
    recommendations: [
      {
        area: "compaction",
        suggestion: "summarize tool output earlier",
        priority: "high",
        count: 1,
        tasks: ["openssl-selfsigned-cert"],
      },
    ],
  });
  assert.equal(plan.recommendationCount, 1);
  assert.equal(plan.items[0].targetFiles[0], "src/compaction.mjs");
  assert.equal(plan.items[0].status, "pending");
  const md = formatProcessingMarkdown(plan);
  assert.match(md, /compaction/);
  assert.match(md, /summarize tool output earlier/);
  assert.match(md, /src\/compaction\.mjs/);
});

test("formatProcessingMarkdown handles empty recommendations", () => {
  const md = formatProcessingMarkdown(
    buildProcessingPlan({ recommendations: [] }),
  );
  assert.match(md, /Nothing to implement/);
});

test("targetsForArea maps closed-loop areas", () => {
  assert.ok(targetsForArea("acceptance").includes("src/acceptance.mjs"));
  assert.ok(targetsForArea("escalation").includes("src/escalation.mjs"));
  assert.ok(targetsForArea("memory").includes("src/memory-store.mjs"));
});

test("patterns mode turns architecture insights into pending levers", () => {
  const plan = buildProcessingPlan(
    {
      suite: "terminal-bench",
      architectureInsights: [
        {
          id: "tests-mostly-failed",
          source: "run",
          priority: "high",
          pattern: "Ground-truth tests failed on most of this sample.",
          lever: "Prefer stronger deliverable + verify gating over task-specific hints.",
          scenarios: ["a", "b"],
        },
        {
          id: "stable-without-escalation",
          source: "run",
          priority: "low",
          pattern: "Strong scores with zero escalations.",
          lever: "Resist adding complexity here.",
          scenarios: ["c", "d"],
        },
      ],
      recommendations: [
        { area: "planning", suggestion: "add a hint for openssl-selfsigned-cert", priority: "high" },
      ],
    },
    { patterns: true },
  );
  assert.equal(plan.mode, "patterns");
  assert.equal(plan.recommendationCount, 1);
  const pending = plan.items.find((i) => i.status === "pending");
  assert.equal(pending.insightId, "tests-mostly-failed");
  assert.equal(pending.area, "acceptance");
  assert.ok(pending.targetFiles.includes("src/acceptance.mjs"));
  const skipped = plan.items.find((i) => i.status === "skip");
  assert.equal(skipped.insightId, "stable-without-escalation");
  assert.equal(plan.judgeNotes.length, 1);
  const md = formatProcessingMarkdown(plan);
  assert.match(md, /architecture patterns plan/i);
  assert.match(md, /Pattern:/);
  assert.match(md, /Judge notes/);
  assert.doesNotMatch(md, /### 1\. \[high\] planning/);
});

test("itemsFromInsights skips resist levers", () => {
  const items = itemsFromInsights([
    {
      id: "stable-without-escalation",
      priority: "low",
      pattern: "held",
      lever: "Resist adding complexity here.",
      scenarios: ["a"],
    },
  ]);
  assert.equal(items[0].status, "skip");
});
