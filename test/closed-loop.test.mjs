import assert from "node:assert/strict";
import { test } from "node:test";

import { adaptPowerShellCommand } from "../src/tools/shell.mjs";
import { computeRunMetrics } from "../evals/scoreboard.mjs";

test("adaptPowerShellCommand replaces && with ; on Windows", () => {
  const { command, adapted } = adaptPowerShellCommand("dotnet build && dotnet test", {
    platform: "win32",
  });
  assert.equal(adapted, true);
  assert.equal(command, "dotnet build; dotnet test");
});

test("adaptPowerShellCommand leaves POSIX commands unchanged", () => {
  const { adapted } = adaptPowerShellCommand("make && make test", { platform: "linux" });
  assert.equal(adapted, false);
});

test("computeRunMetrics aggregates outcome, process, and efficiency", () => {
  const metrics = computeRunMetrics([
    {
      precheck: { pass: true },
      integrity: { pass: true },
      verdict: { score: 80, process: { score: 60 } },
      agent: {
        steps: 4,
        efficiency: { toolCalls: 3, flags: ["no-verification"], heuristicScore: 85, verifiedAfterLastMutation: false, tokens: { prompt: 1000 } },
      },
    },
    {
      precheck: { pass: true },
      integrity: { pass: true },
      verdict: { score: 90, process: { score: 80 } },
      agent: {
        steps: 6,
        efficiency: { toolCalls: 5, flags: [], heuristicScore: 100, verifiedAfterLastMutation: true, tokens: { prompt: 3000 } },
      },
    },
  ]);
  assert.equal(metrics.passRate, 1);
  assert.equal(metrics.avgSteps, 5);
  assert.equal(metrics.avgToolCalls, 4);
  assert.equal(metrics.avgProcessScore, 70);
  assert.equal(metrics.avgPromptTokens, 2000);
  assert.equal(metrics.verifiedRate, 0.5);
  assert.equal(metrics.avgHeuristicScore, 92.5);
  assert.deepEqual(metrics.flagCounts, { "no-verification": 1 });
  assert.equal("cloudRate" in metrics, false);
});
