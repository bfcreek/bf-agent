import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  defaultConfig,
  loadBenchOptions,
  parseCliArgs,
  resolveBenchConfigPath,
} from "../evals/config.mjs";
import { buildAgentSpawn, buildJudgePrompt, buildJudgeRetryPrompt, parseJudgeResponse } from "../evals/judge.mjs";
import { buildAssessmentReport, formatReportConsole } from "../evals/report.mjs";
import { SCENARIOS, agentAnswerText, selectScenarios } from "../evals/scenarios.mjs";
import { captureWorkspaceSnapshot } from "../evals/workspace-snapshot.mjs";
import { removeWorkspaceDir } from "../evals/workspace-cleanup.mjs";

test("removeWorkspaceDir deletes a temp directory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-bench-rm-"));
  await writeFile(path.join(dir, "note.txt"), "hello");
  const result = await removeWorkspaceDir(dir, { settleMs: 0, attempts: 2, baseDelayMs: 10 });
  assert.equal(result.removed, true);
});

test("parseCliArgs merges file config and CLI overrides", () => {
  const file = defaultConfig();
  file.progression.enabled = true;
  file.progression.maxTier = 3;
  file.models = ["llama3.2"];

  const opts = parseCliArgs(["--tier", "2", "--flat", "--model", "qwen3-coder:30b"], file);
  assert.equal(opts.maxTier, 2);
  assert.equal(opts.progression, false);
  assert.deepEqual(opts.models, ["qwen3-coder:30b"]);
});

test("parseCliArgs enables progression from config by default", () => {
  const file = defaultConfig();
  const opts = parseCliArgs([], file);
  assert.equal(opts.progression, true);
  assert.equal(opts.stopBelowScore, 50);
});

test("resolveBenchConfigPath uses explicit --config when provided", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-bench-cfg-"));
  const custom = path.join(dir, "custom.json");
  await writeFile(custom, "{}");
  const resolved = await resolveBenchConfigPath(["--config", custom], dir);
  assert.equal(resolved.path, custom);
  assert.equal(resolved.explicit, true);
});

test("resolveBenchConfigPath prefers cwd bench.config.json over evals default", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-bench-cfg-"));
  const local = path.join(dir, "bench.config.json");
  await writeFile(local, "{}");
  const resolved = await resolveBenchConfigPath([], dir);
  assert.equal(resolved.path, local);
});

test("loadBenchOptions applies file defaults only when config exists", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-bench-cfg-"));
  const local = path.join(dir, "bench.config.json");
  await writeFile(
    local,
    JSON.stringify({ planning: true, judgeRetries: 5, progression: { maxTier: 2 } }),
  );
  const { options, configPath } = await loadBenchOptions(["--tier", "1"], dir);
  assert.equal(configPath, local);
  assert.equal(options.planning, true);
  assert.equal(options.judgeRetries, 5);
  assert.equal(options.maxTier, 1);
});

test("loadBenchOptions uses evals/bench.config.json when cwd has no local config", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-bench-cfg-"));
  const { options, configPath } = await loadBenchOptions([], dir);
  assert.match(configPath, /evals[\\/]bench\.config\.json$/);
  assert.equal(options.planning, false);
  assert.equal(options.judgeRetries, 2);
  assert.deepEqual(options.models, ["gpt-oss:20b"]);
  assert.equal(options.gates.safety.integrityMinPassRate, 1);
});

test("parseCliArgs loads single scenario from config file", () => {
  const file = defaultConfig();
  file.scenario = "greet-module";
  const opts = parseCliArgs([], file);
  assert.equal(opts.scenarioFilter, "greet-module");
});

test("parseCliArgs --scenario overrides config scenario", () => {
  const file = defaultConfig();
  file.scenario = "greet-module";
  const opts = parseCliArgs(["--scenario", "readme-port"], file);
  assert.equal(opts.scenarioFilter, "readme-port");
});

test("parseCliArgs --gate built-in enables enforcement", () => {
  const file = defaultConfig();
  const opts = parseCliArgs(["--gate", "built-in"], file);
  assert.equal(opts.gatePreset, "built-in");
  assert.equal(opts.enforceGates, true);
});

test("selectScenarios filters by tier when no explicit selection", () => {
  const selected = selectScenarios({ maxTier: 1 });
  assert.ok(selected.length > 0);
  assert.ok(selected.every((s) => s.tier <= 1));
  assert.ok(selected.some((s) => s.tier === 0));
});

test("selectScenarios honors explicit --scenario over tier cap", () => {
  const selected = selectScenarios({ scenarioFilter: "todo-cli", maxTier: 1 });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].name, "todo-cli");
  assert.equal(selected[0].tier, 3);
});

test("selectScenarios honors --scenarios list over tier cap", () => {
  const selected = selectScenarios({
    scenarioList: ["greet-module", "todo-cli"],
    maxTier: 1,
  });
  assert.deepEqual(
    selected.map((s) => s.name),
    ["greet-module", "todo-cli"],
  );
});

test("agentAnswerText tolerates missing or non-string text", () => {
  assert.equal(agentAnswerText({ text: "hello" }), "hello");
  assert.equal(agentAnswerText({ text: undefined }), "");
  assert.equal(agentAnswerText({}), "");
  assert.equal(agentAnswerText(null), "");
});

test("buildAssessmentReport aggregates tiers and recommendations", () => {
  const results = [
    {
      scenario: "a",
      tier: 1,
      model: "auto",
      precheck: { pass: true, detail: "ok" },
      agent: { steps: 3, stopReason: "completed" },
      seconds: 10,
      verdict: {
        score: 80,
        grade: "B",
        summary: "Good.",
        agentImprovements: [{ area: "tools", suggestion: "add retry", priority: "high" }],
      },
    },
    {
      scenario: "b",
      tier: 2,
      model: "auto",
      precheck: { pass: false, detail: "fail" },
      agent: { steps: 5, stopReason: "completed" },
      seconds: 20,
      verdict: {
        score: 60,
        grade: "D",
        summary: "Weak.",
        agentImprovements: [{ area: "tools", suggestion: "add retry", priority: "high" }],
      },
    },
  ];
  const report = buildAssessmentReport(results, {
    models: ["auto"],
    judgeModel: "auto",
    progression: true,
    stopReason: "Stopped after tier 2",
    stoppedAtTier: 2,
  });
  assert.equal(report.overall.judged, 2);
  assert.equal(report.overall.avgScore, 70);
  assert.equal(report.tierSummaries.length, 2);
  assert.equal(report.recommendations[0].count, 2);
  const text = formatReportConsole(report);
  assert.match(text, /assessment report/);
  assert.match(text, /Recommendations/);
  assert.match(text, /Stopped after tier 2/);
});

test("parseJudgeResponse accepts bare JSON", () => {
  const verdict = parseJudgeResponse(
    JSON.stringify({
      score: 82,
      grade: "B",
      summary: "Solid work.",
      criteria: [{ name: "tests", score: 8, max: 10, notes: "pass" }],
      strengths: ["ran tests"],
      weaknesses: ["verbose answer"],
      agentImprovements: [{ area: "system prompt", suggestion: "emphasize brevity", priority: "low" }],
    }),
  );
  assert.equal(verdict.score, 82);
  assert.equal(verdict.grade, "B");
  assert.equal(verdict.agentImprovements[0].priority, "low");
});

test("parseJudgeResponse extracts JSON from markdown fences", () => {
  const verdict = parseJudgeResponse('Here you go:\n```json\n{"score": 50, "grade": "C", "summary": "ok"}\n```');
  assert.equal(verdict.score, 50);
  assert.equal(verdict.summary, "ok");
});

test("parseJudgeResponse clamps score and handles garbage", () => {
  assert.equal(parseJudgeResponse("not json").score, 0);
  assert.equal(parseJudgeResponse('{"score": 150, "grade": "A"}').score, 100);
});

test("buildAgentSpawn routes through cmd.exe on Windows", () => {
  const { command, args } = buildAgentSpawn("agent", ["--print", "hi"]);
  if (process.platform === "win32") {
    assert.match(command.toLowerCase(), /cmd(\.exe)?$/);
    assert.equal(args[0], "/d");
    assert.equal(args[3], "agent");
    assert.equal(args[4], "--print");
  } else {
    assert.equal(command, "agent");
    assert.deepEqual(args, ["--print", "hi"]);
  }
});

test("buildJudgePrompt includes goal, rubric, and workspace", async () => {
  const scenario = SCENARIOS.find((s) => s.name === "greet-module");
  assert.ok(scenario);
  const snapshot = await captureWorkspaceSnapshot(process.cwd(), { maxFiles: 3 });
  const prompt = buildJudgePrompt({
    scenario,
    agentResult: { text: "done", stopReason: "completed", steps: [], messages: [] },
    snapshot,
  });
  assert.match(prompt, /greet\.mjs/);
  assert.match(prompt, /Rubric/);
  assert.match(prompt, /Workspace snapshot/);
});

test("buildJudgeRetryPrompt includes full grading context and step trace", async () => {
  const scenario = SCENARIOS.find((s) => s.name === "find-export");
  assert.ok(scenario);
  const snapshot = await captureWorkspaceSnapshot(process.cwd(), { maxFiles: 3 });
  const agentResult = {
    text: "lib/tax.mjs",
    stopReason: "completed",
    steps: [
      {
        index: 1,
        kind: "tool-calls",
        content: "",
        toolCalls: [{ name: "grep", args: { pattern: "computeTax" }, ok: true }],
      },
      {
        index: 2,
        kind: "final",
        content: "lib/tax.mjs",
        toolCalls: [],
      },
    ],
    messages: [],
  };
  const prompt = buildJudgeRetryPrompt({
    scenario,
    agentResult,
    snapshot,
    priorRaw: "not valid json",
  });
  assert.match(prompt, /invalid or incomplete/);
  assert.match(prompt, /lib\/tax\.mjs/);
  assert.match(prompt, /Rubric/);
  assert.match(prompt, /Workspace snapshot/);
  assert.match(prompt, /grep\(/);
  assert.match(prompt, /Previous invalid response/);
  assert.match(prompt, /not valid json/);
  assert.match(prompt, /## Agent steps \(2\):/);
});

test("buildJudgeRetryPrompt matches primary prompt grading sections", async () => {
  const scenario = SCENARIOS.find((s) => s.name === "edit-json-config");
  assert.ok(scenario);
  const snapshot = await captureWorkspaceSnapshot(process.cwd(), { maxFiles: 3 });
  const agentResult = {
    text: "updated config.json",
    stopReason: "completed",
    steps: [
      {
        index: 1,
        kind: "tool-calls",
        content: "",
        toolCalls: [{ name: "read_file", args: { path: "config.json" }, ok: true }],
      },
    ],
    messages: [],
  };
  const primary = buildJudgePrompt({ scenario, agentResult, snapshot });
  const retry = buildJudgeRetryPrompt({ scenario, agentResult, snapshot, priorRaw: "{bad}" });
  for (const section of ["## Task", "## Rubric", "## Agent final answer", "## Agent steps", "## Workspace snapshot"]) {
    assert.ok(primary.includes(section), `primary missing ${section}`);
    assert.ok(retry.includes(section), `retry missing ${section}`);
  }
});

test("every scenario has unique name, tier, goal, rubric, setup", () => {
  const names = SCENARIOS.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
  for (const scenario of SCENARIOS) {
    assert.ok(scenario.tier >= 0 && scenario.tier <= 5);
    assert.ok(scenario.goal.length > 20);
    assert.ok(scenario.rubric.length > 20);
    assert.equal(typeof scenario.setup, "function");
  }
});

test("tier 0 safety scenarios exist and skip judge", () => {
  const safety = SCENARIOS.filter((s) => s.tier === 0);
  assert.equal(safety.length, 6);
  for (const scenario of safety) {
    assert.equal(scenario.skipJudge, true);
    assert.ok(scenario.integrity);
  }
});

test("scenarios are ordered by increasing tier", () => {
  for (let i = 1; i < SCENARIOS.length; i++) {
    assert.ok(SCENARIOS[i].tier >= SCENARIOS[i - 1].tier, `${SCENARIOS[i].name} tier order`);
  }
});
