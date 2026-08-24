import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  defaultConfig,
  loadBenchOptions,
  parseCliArgs,
  resolveBenchConfigPath,
} from "../evals/config.mjs";
import {
  buildCheckpointRecord,
  buildRunKey,
  checkpointMatchesRun,
  clearCheckpoint,
  describeRunSelection,
  loadCheckpoint,
  saveCheckpoint,
  shouldStopBench,
} from "../evals/checkpoint.mjs";
import { buildAgentSpawn, buildCursorAgentArgs, buildJudgeInvocationPrompt, buildJudgePrompt, buildJudgeRetryPrompt, isUsableVerdict, parseJudgeResponse } from "../evals/judge.mjs";
import {
  buildAgentArtifacts,
  formatStepSummary,
  persistAgentArtifacts,
} from "../evals/agent-artifacts.mjs";
import { buildAssessmentReport, formatReportConsole } from "../evals/report.mjs";
import { SCENARIOS, agentAnswerText, filterAvailableScenarios, runtimeAvailable, selectScenarios } from "../evals/scenarios.mjs";
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
  const file = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(options.planning, file.planning);
  assert.equal(options.judgeRetries, file.judgeRetries);
  assert.deepEqual(options.models, file.models);
  assert.equal(options.gates.safety.integrityMinPassRate, file.gates.safety.integrityMinPassRate);
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

test("buildCursorAgentArgs keeps invocation under Windows command-line limit", () => {
  const workspaceDir = "C:\\Users\\joe\\AppData\\Local\\Temp\\halo-bench-abcdefghijklmnop";
  const args = buildCursorAgentArgs({ workspaceDir, model: "auto" });
  const { command, args: spawnArgs } = buildAgentSpawn("agent", args);
  const cmdLine = [command, ...spawnArgs].join(" ");
  assert.ok(cmdLine.length < 8191, `cmd line ${cmdLine.length} chars exceeds Windows limit`);
  assert.ok(!args.at(-1).includes("## Workspace snapshot"), "full judge prompt must not be on argv");
  assert.match(args.at(-1), /judge-prompt\.txt/);
});

test("buildJudgeInvocationPrompt references artifact files", () => {
  const invocation = buildJudgeInvocationPrompt();
  assert.match(invocation, /\.halo-bench\/judge-prompt\.txt/);
  assert.match(invocation, /\.halo-bench\/agent-artifacts\.json/);
  assert.match(invocation, /JSON object/);
});

test("buildJudgePrompt includes goal, rubric, workspace, and step summary", async () => {
  const scenario = SCENARIOS.find((s) => s.name === "greet-module");
  assert.ok(scenario);
  const snapshot = await captureWorkspaceSnapshot(process.cwd(), { maxFiles: 3 });
  const agentResult = {
    text: "done",
    stopReason: "completed",
    steps: [
      {
        index: 1,
        kind: "tool-calls",
        content: "",
        toolCalls: [{ name: "write_file", args: { path: "greet.mjs" }, ok: true }],
      },
    ],
    messages: [],
  };
  const prompt = buildJudgePrompt({ scenario, agentResult, snapshot });
  assert.match(prompt, /greet\.mjs/);
  assert.match(prompt, /Rubric/);
  assert.match(prompt, /Workspace snapshot/);
  assert.match(prompt, /## Agent step summary/);
  assert.match(prompt, /write_file/);
  assert.match(prompt, /\.halo-bench\/agent-artifacts\.json/);
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
  for (const section of [
    "## Task",
    "## Rubric",
    "## Agent step summary",
    "## Agent final answer",
    "## Agent steps",
    "## Workspace snapshot",
  ]) {
    assert.ok(primary.includes(section), `primary missing ${section}`);
    assert.ok(retry.includes(section), `retry missing ${section}`);
  }
});

test("persistAgentArtifacts writes json and step trace files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-bench-art-"));
  const agentResult = {
    text: "lib/tax.mjs",
    stopReason: "completed",
    steps: [
      {
        index: 1,
        kind: "tool-calls",
        content: "",
        toolCalls: [{ name: "grep_search", args: { pattern: "computeTax" }, ok: true }],
      },
    ],
    messages: [],
  };
  const artifacts = await persistAgentArtifacts(dir, agentResult);
  assert.equal(artifacts.finalAnswer, "lib/tax.mjs");
  assert.deepEqual(artifacts.toolCallOrder, ["grep_search"]);
  assert.equal(formatStepSummary(agentResult), buildAgentArtifacts(agentResult).stepSummary);
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

test("python and csharp scenarios cover tiers 1-4", () => {
  const python = SCENARIOS.filter((s) => s.language === "python");
  const csharp = SCENARIOS.filter((s) => s.language === "csharp");
  assert.deepEqual(
    python.map((s) => `${s.tier}:${s.name}`),
    ["1:py-greet", "1:py-find-export", "2:py-fix-tests", "3:py-json-filter", "4:py-refactor"],
  );
  assert.deepEqual(
    csharp.map((s) => `${s.tier}:${s.name}`),
    ["1:cs-greet", "1:cs-find-export", "2:cs-fix-tests", "3:cs-json-filter", "4:cs-refactor"],
  );
  for (const scenario of [...python, ...csharp]) {
    assert.equal(typeof scenario.precheck, "function");
    if (scenario.name.endsWith("find-export")) {
      assert.equal(scenario.requires, undefined);
    } else {
      assert.ok(scenario.requires === "python" || scenario.requires === "dotnet");
    }
  }
});

test("filterAvailableScenarios drops missing runtimes unless explicitly selected", () => {
  const none = filterAvailableScenarios(SCENARIOS, { isAvailable: () => false });
  assert.equal(none.some((s) => s.requires), false);
  assert.ok(none.some((s) => s.name === "greet-module"));

  const explicit = filterAvailableScenarios(SCENARIOS, { explicit: true, isAvailable: () => false });
  assert.ok(explicit.some((s) => s.name === "py-greet"));
  assert.ok(explicit.some((s) => s.name === "cs-greet"));
});

test("py-greet precheck passes a correct solution", async () => {
  const scenario = SCENARIOS.find((s) => s.name === "py-greet");
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-py-greet-"));
  try {
    await scenario.setup(dir);
    await writeFile(
      path.join(dir, "greet.py"),
      "def greet(name):\n    return f'Hello, {name}!'\n",
      "utf8",
    );
    await writeFile(
      path.join(dir, "test.py"),
      "from greet import greet\nassert greet('World') == 'Hello, World!'\nprint('ok')\n",
      "utf8",
    );
    const result = await scenario.precheck(dir, { text: "ok" });
    if (!runtimeAvailable("python")) {
      assert.equal(result.pass, false);
      assert.match(result.detail, /python/i);
    } else {
      assert.equal(result.pass, true, result.detail);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cs-greet precheck passes a correct solution", { timeout: 120_000 }, async () => {
  const scenario = SCENARIOS.find((s) => s.name === "cs-greet");
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-cs-greet-"));
  try {
    await scenario.setup(dir);
    await writeFile(
      path.join(dir, "Program.cs"),
      [
        "string Greet(string name) => $\"Hello, {name}!\";",
        "if (Greet(\"World\") != \"Hello, World!\") Environment.Exit(1);",
        "Console.WriteLine(\"ok\");",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = await scenario.precheck(dir, { text: "ok" });
    if (!runtimeAvailable("dotnet")) {
      assert.equal(result.pass, false);
      assert.match(result.detail, /dotnet/i);
    } else {
      assert.equal(result.pass, true, result.detail);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("py-find-export and cs-find-export prechecks accept workspace-relative paths", async () => {
  const py = SCENARIOS.find((s) => s.name === "py-find-export");
  const cs = SCENARIOS.find((s) => s.name === "cs-find-export");
  const pyDir = await mkdtemp(path.join(os.tmpdir(), "halo-py-find-"));
  const csDir = await mkdtemp(path.join(os.tmpdir(), "halo-cs-find-"));
  try {
    await py.setup(pyDir);
    await cs.setup(csDir);
    assert.equal((await py.precheck(pyDir, { text: "lib/tax.py" })).pass, true);
    assert.equal((await py.precheck(pyDir, { text: "lib\\tax.py" })).pass, true);
    assert.equal((await py.precheck(pyDir, { text: "nope.py" })).pass, false);
    assert.equal((await cs.precheck(csDir, { text: "Lib/Tax.cs" })).pass, true);
    assert.equal((await cs.precheck(csDir, { text: "lib\\tax.cs" })).pass, true);
    assert.equal((await cs.precheck(csDir, { text: "Util.cs" })).pass, false);
  } finally {
    await rm(pyDir, { recursive: true, force: true });
    await rm(csDir, { recursive: true, force: true });
  }
});

test("buildRunKey changes when scenario set or core options differ", () => {
  const names = ["safety-read-only", "safety-read-value"];
  const base = parseCliArgs(["--tier", "0"], defaultConfig());
  const keyA = buildRunKey(names, base);
  const keyB = buildRunKey(["safety-read-only"], base);
  const keyC = buildRunKey(names, parseCliArgs(["--tier", "0", "--skip-judge"], defaultConfig()));
  assert.notEqual(keyA, keyB);
  assert.notEqual(keyA, keyC);
  assert.equal(buildRunKey(names, base), keyA);
});

test("describeRunSelection labels tier and scenario runs", () => {
  const names = ["safety-read-only"];
  assert.equal(
    describeRunSelection(names, parseCliArgs(["--tier", "0"], defaultConfig())),
    "tier ≤0 (progression)",
  );
  assert.equal(
    describeRunSelection(names, parseCliArgs(["--tier", "0", "--flat"], defaultConfig())),
    "tier ≤0 (flat)",
  );
  assert.equal(
    describeRunSelection(names, parseCliArgs(["--scenario", "safety-read-only"], defaultConfig())),
    "scenario safety-read-only",
  );
});

test("checkpoint save/load round-trip and clear", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-bench-cp-"));
  const checkpointPath = path.join(dir, "bench-checkpoint.json");
  const record = buildCheckpointRecord({
    runKey: "abc123",
    selectionLabel: "tier ≤0 (progression)",
    scenarioNames: ["a", "b"],
    completedNames: ["a"],
    results: [{ scenario: "a", tier: 0 }],
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  await saveCheckpoint(checkpointPath, record);
  const loaded = await loadCheckpoint(checkpointPath);
  assert.equal(loaded.runKey, "abc123");
  assert.deepEqual(loaded.completedNames, ["a"]);
  assert.ok(checkpointMatchesRun(loaded, "abc123", ["a", "b"]));
  assert.equal(checkpointMatchesRun(loaded, "other", ["a", "b"]), false);
  await clearCheckpoint(checkpointPath);
  assert.equal(await loadCheckpoint(checkpointPath), null);
});

test("parseCliArgs accepts --resume and --reset", () => {
  const opts = parseCliArgs(["--resume", "--reset", "--checkpoint", "tmp/checkpoint.json"], defaultConfig());
  assert.equal(opts.resume, true);
  assert.equal(opts.reset, true);
  assert.equal(opts.checkpointPath, "tmp/checkpoint.json");
});

test("isUsableVerdict rejects invalid judge JSON", () => {
  const bad = parseJudgeResponse("not json");
  assert.equal(isUsableVerdict(bad), false);
  const good = parseJudgeResponse('{"score": 80, "grade": "B", "summary": "ok"}');
  assert.equal(isUsableVerdict(good), true);
});

test("shouldStopBench stops on runner or judge errors only", () => {
  assert.equal(shouldStopBench({ error: "Cursor agent exited 1" }), true);
  assert.equal(
    shouldStopBench({ precheck: { pass: false }, integrity: { pass: false } }),
    false,
  );
  assert.equal(shouldStopBench({ verdict: { score: 0, grade: "F" } }), false);
});
