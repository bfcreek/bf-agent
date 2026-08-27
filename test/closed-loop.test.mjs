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

test("computeRunMetrics aggregates pass rate and steps", () => {
  const metrics = computeRunMetrics([
    { precheck: { pass: true }, integrity: { pass: true }, verdict: { score: 80 }, agent: { steps: 4, cloudUsed: false, escalationCount: 0 } },
    { precheck: { pass: true }, integrity: { pass: true }, verdict: { score: 90 }, agent: { steps: 6, cloudUsed: true, escalationCount: 1 } },
  ]);
  assert.equal(metrics.passRate, 1);
  assert.equal(metrics.avgSteps, 5);
  assert.equal(metrics.cloudRate, 0.5);
  assert.equal(metrics.avgEscalations, 0.5);
});
