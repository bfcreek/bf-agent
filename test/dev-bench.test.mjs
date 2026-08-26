import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  defaultConfig,
  loadBenchOptions,
  parseCliArgs,
  parseLanguageFilter,
  resolveBenchConfigPath,
} from "../evals/config.mjs";
import {
  buildCheckpointRecord,
  buildRunKey,
  checkpointRelForLanguage,
  checkpointMatchesRun,
  clearAllCheckpoints,
  clearCheckpoint,
  describeRunSelection,
  isJudgeJsonError,
  isScenarioTimeoutError,
  isTransientProviderError,
  languageFilterFromCheckpoint,
  listCheckpoints,
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

/** @param {string} dir @param {Record<string, string>} files */
async function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
}

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

test("parseCliArgs accepts --tier-preset", () => {
  const opts = parseCliArgs(["--tier-preset", "hybrid"], defaultConfig());
  assert.equal(opts.tierPreset, "hybrid");
});

test("parseCliArgs rejects unknown --tier-preset", () => {
  assert.throws(
    () => parseCliArgs(["--tier-preset", "yolo"], defaultConfig()),
    /--tier-preset|Unknown tier preset/,
  );
});

test("loadBenchOptions resolves tier models from models config when bench omits them", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-bench-user-tier-"));
  const modelsConfigPath = path.join(dir, "models.yaml");
  const benchConfigPath = path.join(dir, "bench.config.json");
  const previous = { ...process.env };
  process.env.HALO_MODELS_CONFIG = modelsConfigPath;
  try {
    await writeFile(
      modelsConfigPath,
      `preset: cloud
`,
      "utf8",
    );
    await writeFile(
      benchConfigPath,
      JSON.stringify({ models: ["auto"], progression: { enabled: false, maxTier: 5 } }),
      "utf8",
    );
    const { options } = await loadBenchOptions(["--config", benchConfigPath, "--flat"]);
    assert.ok(options.tierModels?.length);
    assert.ok(options.tierModels.every((band) => band.model.includes(":cloud")));
  } finally {
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadBenchOptions --tier-preset overrides models config bands", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-bench-cli-tier-"));
  const modelsConfigPath = path.join(dir, "models.yaml");
  const benchConfigPath = path.join(dir, "bench.config.json");
  const previous = { ...process.env };
  process.env.HALO_MODELS_CONFIG = modelsConfigPath;
  try {
    await writeFile(
      modelsConfigPath,
      `bands:
  - model: user-only
`,
      "utf8",
    );
    await writeFile(
      benchConfigPath,
      JSON.stringify({ models: ["auto"], progression: { enabled: false, maxTier: 5 } }),
      "utf8",
    );
    const { options } = await loadBenchOptions([
      "--config",
      benchConfigPath,
      "--flat",
      "--tier-preset",
      "cloud",
    ]);
    assert.ok(options.tierModels?.every((band) => band.model.includes(":cloud")));
  } finally {
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  }
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

test("parseLanguageFilter normalizes aliases", () => {
  assert.deepEqual(parseLanguageFilter("cs"), ["csharp"]);
  assert.deepEqual(parseLanguageFilter("python,csharp"), ["python", "csharp"]);
  assert.deepEqual(parseLanguageFilter(["js", "javascript"]), ["js"]);
  assert.throws(() => parseLanguageFilter("ruby"), /Unknown language/);
});

test("parseCliArgs --language filters the scenario set", () => {
  const opts = parseCliArgs(["--language", "csharp"], defaultConfig());
  assert.deepEqual(opts.languageFilter, ["csharp"]);
  assert.match(opts.checkpointPath.replaceAll("\\", "/"), /bench-checkpoint-csharp\.json$/);
  assert.equal(opts.checkpointExplicit, false);
  const selected = selectScenarios(opts);
  assert.ok(selected.length > 0);
  assert.ok(selected.every((s) => s.language === "csharp"));
  assert.ok(selected.some((s) => s.name === "cs-catalog-cli"));
});

test("parseCliArgs --language uses a per-language checkpoint unless --checkpoint is set", () => {
  const python = parseCliArgs(["--language", "python"], defaultConfig());
  const csharp = parseCliArgs(["--language", "csharp"], defaultConfig());
  const js = parseCliArgs(["--language", "js"], defaultConfig());
  const explicit = parseCliArgs(["--language", "csharp", "--checkpoint", "tmp/custom.json"], defaultConfig());
  const all = parseCliArgs([], defaultConfig());
  assert.notEqual(python.checkpointPath, csharp.checkpointPath);
  assert.notEqual(python.checkpointPath, js.checkpointPath);
  assert.notEqual(python.checkpointPath, all.checkpointPath);
  assert.equal(explicit.checkpointPath, "tmp/custom.json");
  assert.equal(explicit.checkpointExplicit, true);
});

test("selectScenarios languageFilter keeps js scenarios without a language field", () => {
  const selected = selectScenarios({ languageFilter: ["js"], maxTier: 1 });
  assert.ok(selected.some((s) => s.name === "greet-module"));
  assert.ok(selected.every((s) => (s.language ?? "js") === "js"));
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
  const artifacts = await persistAgentArtifacts(dir, agentResult, {
    goal: "Which file exports computeTax?",
    rubric: "Answer identifies lib/tax.mjs.",
  });
  assert.equal(artifacts.finalAnswer, "lib/tax.mjs");
  assert.equal(artifacts.task, "Which file exports computeTax?");
  assert.equal(artifacts.rubric, "Answer identifies lib/tax.mjs.");
  assert.deepEqual(artifacts.toolCallOrder, ["grep_search"]);
  assert.equal(formatStepSummary(agentResult), buildAgentArtifacts(agentResult).stepSummary);
});

test("every scenario has unique name, tier, goal, rubric, setup", () => {
  const names = SCENARIOS.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
  for (const scenario of SCENARIOS) {
    assert.ok(scenario.tier >= 0 && scenario.tier <= 6);
    assert.ok(scenario.goal.length > 20);
    assert.ok(scenario.rubric.length > 20);
    assert.equal(typeof scenario.setup, "function");
    if (scenario.tier === 6) {
      assert.ok(String(scenario.followUp ?? "").length > 20, `${scenario.name} needs a follow-up`);
    }
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

test("python and csharp scenarios cover tiers 1-6", () => {
  const python = SCENARIOS.filter((s) => s.language === "python");
  const csharp = SCENARIOS.filter((s) => s.language === "csharp");
  const jsTier5 = SCENARIOS.filter((s) => s.tier === 5 && (s.language ?? "js") === "js").map((s) => s.name);
  assert.deepEqual(
    python.map((s) => `${s.tier}:${s.name}`),
    ["1:py-greet", "1:py-find-export", "2:py-fix-tests", "3:py-json-filter", "4:py-refactor", "5:py-timesheet", "5:py-budget", "6:py-warehouse", "6:py-flags"],
  );
  assert.deepEqual(
    csharp.map((s) => `${s.tier}:${s.name}`),
    [
      "1:cs-greet",
      "1:cs-find-export",
      "2:cs-fix-tests",
      "3:cs-json-filter",
      "4:cs-refactor",
      "5:cs-catalog-cli",
      "5:cs-invoice-tests",
      "5:cs-kanban",
      "5:cs-booking",
      "6:cs-tickets",
      "6:cs-payroll",
    ],
  );
  assert.ok(jsTier5.includes("js-job-queue"));
  assert.ok(jsTier5.includes("js-task-dag"));
  const jsTier6 = SCENARIOS.filter((s) => s.tier === 6 && (s.language ?? "js") === "js").map((s) => s.name);
  assert.ok(jsTier6.includes("js-library"));
  assert.ok(jsTier6.includes("js-kvstore"));
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

test("cs-catalog-cli precheck compiles and checks CLI output", { timeout: 120_000 }, async () => {
  const scenario = SCENARIOS.find((s) => s.name === "cs-catalog-cli");
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-cs-catalog-"));
  try {
    await scenario.setup(dir);
    await writeFile(
      path.join(dir, "Catalog.cs"),
      [
        "using System.Text.Json;",
        "public sealed record Item(string Sku, string Name, string Category, int Qty, decimal Price);",
        "public static class Catalog {",
        "  public static List<Item> Load(string path) {",
        "    using var doc = JsonDocument.Parse(File.ReadAllText(path));",
        "    var items = new List<Item>();",
        "    foreach (var el in doc.RootElement.EnumerateArray()) {",
        "      items.Add(new Item(",
        "        el.GetProperty(\"sku\").GetString()!,",
        "        el.GetProperty(\"name\").GetString()!,",
        "        el.GetProperty(\"category\").GetString()!,",
        "        el.GetProperty(\"qty\").GetInt32(),",
        "        el.GetProperty(\"price\").GetDecimal()));",
        "    }",
        "    items.Sort((a, b) => string.CompareOrdinal(a.Sku, b.Sku));",
        "    return items;",
        "  }",
        "  public static string Format(Item i) => $\"{i.Sku}  {i.Name}  qty={i.Qty}  ${i.Price:0.00}\";",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(dir, "Program.cs"),
      [
        "var items = Catalog.Load(Path.Combine(\"data\", \"catalog.json\"));",
        "if (args.Length == 0) Usage();",
        "switch (args[0]) {",
        "  case \"list\":",
        "    foreach (var i in items) Console.WriteLine(Catalog.Format(i));",
        "    break;",
        "  case \"find\":",
        "    if (args.Length < 2) Usage();",
        "    var found = items.Find(i => i.Sku == args[1]);",
        "    Console.WriteLine(found is null ? \"not found\" : Catalog.Format(found));",
        "    break;",
        "  case \"total\":",
        "    Console.WriteLine($\"total: {items.Sum(i => i.Qty * i.Price):0.00}\");",
        "    break;",
        "  case \"low\": {",
        "    int? th = null;",
        "    for (var i = 1; i < args.Length; i++) {",
        "      if (args[i] == \"--threshold\" && i + 1 < args.Length) th = int.Parse(args[++i]);",
        "    }",
        "    if (th is null) Usage();",
        "    foreach (var i in items.Where(x => x.Qty <= th.Value)) Console.WriteLine(Catalog.Format(i));",
        "    break;",
        "  }",
        "  case \"category\":",
        "    if (args.Length < 2) Usage();",
        "    foreach (var i in items.Where(x => x.Category == args[1])) Console.WriteLine(Catalog.Format(i));",
        "    break;",
        "  default:",
        "    Usage();",
        "    break;",
        "}",
        "void Usage() {",
        "  Console.WriteLine(\"usage: list | find <sku> | total | low --threshold <n> | category <name>\");",
        "  Environment.Exit(1);",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = await scenario.precheck(dir);
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

test("cs-invoice-tests precheck compiles, tests, and checks CLI output", { timeout: 180_000 }, async () => {
  const scenario = SCENARIOS.find((s) => s.name === "cs-invoice-tests");
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-cs-invoice-"));
  try {
    await scenario.setup(dir);
    const appDir = path.join(dir, "Invoice");
    const testDir = path.join(dir, "Invoice.Tests");
    await mkdir(appDir, { recursive: true });
    await mkdir(testDir, { recursive: true });

    await writeFile(
      path.join(appDir, "Invoice.csproj"),
      [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <PropertyGroup>",
        "    <OutputType>Exe</OutputType>",
        "    <TargetFramework>net8.0</TargetFramework>",
        "    <ImplicitUsings>enable</ImplicitUsings>",
        "    <Nullable>enable</Nullable>",
        "    <RollForward>LatestMajor</RollForward>",
        "  </PropertyGroup>",
        "</Project>",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(appDir, "Ledger.cs"),
      [
        "public sealed record InvoiceLine(string Description, int Qty, decimal UnitPrice);",
        "",
        "public sealed class Invoice {",
        "  public List<InvoiceLine> Lines { get; } = new();",
        "  public decimal Subtotal => Lines.Sum(l => l.Qty * l.UnitPrice);",
        "  public decimal Tax => Math.Round(Subtotal * 0.10m, 2, MidpointRounding.AwayFromZero);",
        "  public decimal GrandTotal => Subtotal + Tax;",
        "  public void Add(string description, int qty, decimal unitPrice) {",
        "    if (qty <= 0 || unitPrice < 0) throw new ArgumentOutOfRangeException();",
        "    Lines.Add(new InvoiceLine(description, qty, unitPrice));",
        "  }",
        "}",
        "",
        "public static class InvoiceStore {",
        "  public static Invoice Load(string path) {",
        "    var invoice = new Invoice();",
        "    if (!File.Exists(path)) return invoice;",
        "    using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(path));",
        "    if (!doc.RootElement.TryGetProperty(\"lines\", out var lines)) return invoice;",
        "    foreach (var el in lines.EnumerateArray()) {",
        "      invoice.Add(",
        "        el.GetProperty(\"desc\").GetString() ?? \"\",",
        "        el.GetProperty(\"qty\").GetInt32(),",
        "        el.GetProperty(\"price\").GetDecimal());",
        "    }",
        "    return invoice;",
        "  }",
        "  public static void Save(string path, Invoice invoice) {",
        "    var payload = new {",
        "      lines = invoice.Lines.Select(l => new { desc = l.Description, qty = l.Qty, price = l.UnitPrice }).ToArray()",
        "    };",
        "    File.WriteAllText(path, System.Text.Json.JsonSerializer.Serialize(payload));",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(appDir, "Program.cs"),
      [
        "using System.Globalization;",
        "var store = Path.Combine(Directory.GetCurrentDirectory(), \"invoice.json\");",
        "var invoice = InvoiceStore.Load(store);",
        "if (args.Length == 0) { Usage(); return; }",
        "switch (args[0]) {",
        "  case \"add\": {",
        "    if (args.Length < 4) { Usage(); return; }",
        "    if (!int.TryParse(args[2], out var qty) ||",
        "        !decimal.TryParse(args[3], NumberStyles.Number, CultureInfo.InvariantCulture, out var price)) {",
        "      Usage(); return;",
        "    }",
        "    try { invoice.Add(args[1], qty, price); }",
        "    catch { Environment.Exit(1); return; }",
        "    InvoiceStore.Save(store, invoice);",
        "    Console.WriteLine($\"added: {invoice.Lines.Count}\");",
        "    break;",
        "  }",
        "  case \"lines\":",
        "    foreach (var line in invoice.Lines)",
        "      Console.WriteLine($\"{line.Qty} x {line.Description} @ {line.UnitPrice:0.00}\");",
        "    break;",
        "  case \"summary\":",
        "    Console.WriteLine($\"subtotal: {invoice.Subtotal:0.00}\");",
        "    Console.WriteLine($\"tax: {invoice.Tax:0.00}\");",
        "    Console.WriteLine($\"total: {invoice.GrandTotal:0.00}\");",
        "    break;",
        "  default:",
        "    Usage();",
        "    break;",
        "}",
        "void Usage() {",
        "  Console.Error.WriteLine(\"usage: add <desc> <qty> <price> | lines | summary\");",
        "  Environment.Exit(1);",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(testDir, "Invoice.Tests.csproj"),
      [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <PropertyGroup>",
        "    <TargetFramework>net8.0</TargetFramework>",
        "    <ImplicitUsings>enable</ImplicitUsings>",
        "    <Nullable>enable</Nullable>",
        "    <IsPackable>false</IsPackable>",
        "    <RollForward>LatestMajor</RollForward>",
        "  </PropertyGroup>",
        "  <ItemGroup>",
        '    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />',
        '    <PackageReference Include="xunit" Version="2.9.2" />',
        '    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />',
        '    <ProjectReference Include="..\\Invoice\\Invoice.csproj" />',
        "  </ItemGroup>",
        "</Project>",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(testDir, "LedgerTests.cs"),
      [
        "using Xunit;",
        "public class LedgerTests {",
        "  [Fact]",
        "  public void WidgetTotals() {",
        "    var invoice = new Invoice();",
        "    invoice.Add(\"Widget\", 2, 5.00m);",
        "    Assert.Equal(10.00m, invoice.Subtotal);",
        "    Assert.Equal(1.00m, invoice.Tax);",
        "    Assert.Equal(11.00m, invoice.GrandTotal);",
        "  }",
        "  [Fact]",
        "  public void RoundsTaxAwayFromZero() {",
        "    var invoice = new Invoice();",
        "    invoice.Add(\"Item\", 3, 1.25m);",
        "    Assert.Equal(3.75m, invoice.Subtotal);",
        "    Assert.Equal(0.38m, invoice.Tax);",
        "    Assert.Equal(4.13m, invoice.GrandTotal);",
        "  }",
        "  [Fact]",
        "  public void RejectsZeroQty() {",
        "    Assert.ThrowsAny<Exception>(() => new Invoice().Add(\"Bad\", 0, 1m));",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await scenario.precheck(dir);
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

test("js-job-queue precheck accepts a correct two-file CLI", async () => {
  const scenario = SCENARIOS.find((s) => s.name === "js-job-queue");
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-js-queue-"));
  try {
    await scenario.setup(dir);
    await writeTree(dir, {
      "jobs.mjs": [
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
        "const FILE = 'queue.json';",
        "export function load() {",
        "  if (!existsSync(FILE)) return { nextId: 1, jobs: [] };",
        "  return JSON.parse(readFileSync(FILE, 'utf8'));",
        "}",
        "export function save(state) { writeFileSync(FILE, JSON.stringify(state)); }",
        "export function format(job) { return `${job.id}  ${job.name}  ${job.status}`; }",
        "",
      ].join("\n"),
      "queue.mjs": [
        "import { format, load, save } from './jobs.mjs';",
        "function usage() { console.error('usage: enqueue|list|claim|complete|fail|retry'); process.exit(1); }",
        "const [cmd, a] = process.argv.slice(2);",
        "if (!cmd) usage();",
        "const state = load();",
        "const byId = (id) => state.jobs.find((j) => j.id === id);",
        "if (cmd === 'enqueue') {",
        "  if (!a) usage();",
        "  const job = { id: state.nextId++, name: a, status: 'queued' };",
        "  state.jobs.push(job); save(state); console.log(`queued: ${job.id}`);",
        "} else if (cmd === 'list') {",
        "  for (const job of state.jobs) console.log(format(job));",
        "} else if (cmd === 'claim') {",
        "  const job = state.jobs.find((j) => j.status === 'queued');",
        "  if (!job) { console.log('idle'); }",
        "  else { job.status = 'running'; save(state); console.log(format(job)); }",
        "} else if (cmd === 'complete' || cmd === 'fail' || cmd === 'retry') {",
        "  const id = Number(a);",
        "  const job = byId(id);",
        "  if (!Number.isInteger(id) || !job) usage();",
        "  if (cmd === 'complete') { if (job.status !== 'running') usage(); job.status = 'done'; save(state); console.log(`completed: ${id}`); }",
        "  else if (cmd === 'fail') { if (job.status !== 'running') usage(); job.status = 'failed'; save(state); console.log(`failed: ${id}`); }",
        "  else { if (job.status !== 'failed') usage(); job.status = 'queued'; save(state); console.log(`queued: ${id}`); }",
        "} else usage();",
        "",
      ].join("\n"),
      "test.mjs": [
        "import { spawnSync } from 'node:child_process';",
        "import { existsSync, unlinkSync } from 'node:fs';",
        "if (existsSync('queue.json')) unlinkSync('queue.json');",
        "function run(...args) { return spawnSync(process.execPath, ['queue.mjs', ...args], { encoding: 'utf8' }); }",
        "let r = run('enqueue', 'wash'); if (r.status !== 0 || !r.stdout.includes('queued: 1')) process.exit(1);",
        "r = run('claim'); if (!r.stdout.includes('1  wash  running')) process.exit(1);",
        "r = run('complete', '1'); if (!r.stdout.includes('completed: 1')) process.exit(1);",
        "r = run('complete', '1'); if (r.status === 0) process.exit(1);",
        "console.log('ok');",
        "",
      ].join("\n"),
    });
    const result = await scenario.precheck(dir);
    assert.equal(result.pass, true, result.detail);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("js-task-dag precheck accepts a correct two-file CLI", async () => {
  const scenario = SCENARIOS.find((s) => s.name === "js-task-dag");
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-js-dag-"));
  try {
    await scenario.setup(dir);
    await writeTree(dir, {
      "graph.mjs": [
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
        "export function loadTasks() { return JSON.parse(readFileSync('data/tasks.json', 'utf8')); }",
        "export function loadDone() {",
        "  if (!existsSync('progress.json')) return new Set();",
        "  return new Set(JSON.parse(readFileSync('progress.json', 'utf8')).done ?? []);",
        "}",
        "export function saveDone(done) { writeFileSync('progress.json', JSON.stringify({ done: [...done] })); }",
        "export function kahn(tasks) {",
        "  const remaining = new Set(tasks.map((t) => t.id));",
        "  const deps = new Map(tasks.map((t) => [t.id, [...t.deps]]));",
        "  const order = [];",
        "  while (remaining.size) {",
        "    const ready = [...remaining].filter((id) => deps.get(id).every((d) => !remaining.has(d))).sort();",
        "    if (!ready.length) throw new Error('cycle');",
        "    remaining.delete(ready[0]);",
        "    order.push(ready[0]);",
        "  }",
        "  return order;",
        "}",
        "export function kind(task, done) {",
        "  if (done.has(task.id)) return 'done';",
        "  if (task.deps.every((d) => done.has(d))) return 'ready';",
        "  return 'pending';",
        "}",
        "",
      ].join("\n"),
      "dag.mjs": [
        "import { kahn, kind, loadDone, loadTasks, saveDone } from './graph.mjs';",
        "function usage() { console.error('usage: order|ready|run|status|reset'); process.exit(1); }",
        "const [cmd, id] = process.argv.slice(2);",
        "if (!cmd) usage();",
        "const tasks = loadTasks();",
        "const done = loadDone();",
        "if (cmd === 'order') { for (const item of kahn(tasks)) console.log(item); }",
        "else if (cmd === 'ready') {",
        "  for (const task of tasks.filter((t) => kind(t, done) === 'ready').sort((a, b) => a.id.localeCompare(b.id))) console.log(task.id);",
        "} else if (cmd === 'run') {",
        "  const task = tasks.find((t) => t.id === id);",
        "  if (!task || kind(task, done) !== 'ready') usage();",
        "  done.add(id); saveDone(done); console.log(`ran: ${id}`);",
        "} else if (cmd === 'status') {",
        "  for (const task of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) console.log(`${task.id}  ${kind(task, done)}`);",
        "} else if (cmd === 'reset') { saveDone(new Set()); console.log('reset'); }",
        "else usage();",
        "",
      ].join("\n"),
      "test.mjs": [
        "import { spawnSync } from 'node:child_process';",
        "import { existsSync, unlinkSync } from 'node:fs';",
        "if (existsSync('progress.json')) unlinkSync('progress.json');",
        "function run(...args) { return spawnSync(process.execPath, ['dag.mjs', ...args], { encoding: 'utf8' }); }",
        "const order = run('order').stdout.trim().split(/\\r?\\n/);",
        "if (order.join(',') !== 'fetch,parse,index,report,publish') process.exit(1);",
        "if (run('ready').stdout.trim() !== 'fetch') process.exit(1);",
        "if (run('run', 'index').status === 0) process.exit(1);",
        "console.log('ok');",
        "",
      ].join("\n"),
    });
    const result = await scenario.precheck(dir);
    assert.equal(result.pass, true, result.detail);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("py-timesheet precheck accepts a correct two-file CLI", async () => {
  const scenario = SCENARIOS.find((s) => s.name === "py-timesheet");
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-py-time-"));
  try {
    await scenario.setup(dir);
    await writeTree(dir, {
      "store.py": [
        "import json, os",
        "FILE = 'timesheet.json'",
        "def load():",
        "    if not os.path.exists(FILE):",
        "        return {'open': {}, 'minutes': {}}",
        "    with open(FILE, encoding='utf-8') as f:",
        "        return json.load(f)",
        "def save(state):",
        "    with open(FILE, 'w', encoding='utf-8') as f:",
        "        json.dump(state, f)",
        "def parse_hhmm(text):",
        "    h, m = text.split(':')",
        "    h, m = int(h), int(m)",
        "    if not (0 <= h <= 23 and 0 <= m <= 59):",
        "        raise ValueError('bad time')",
        "    return h * 60 + m, f'{h:02d}:{m:02d}'",
        "def fmt_hours(total):",
        "    return f'{total // 60}:{total % 60:02d}'",
        "",
      ].join("\n"),
      "timesheet.py": [
        "import sys",
        "from store import fmt_hours, load, parse_hhmm, save",
        "def usage():",
        "    print('usage: in|out|hours|open|overtime', file=sys.stderr)",
        "    sys.exit(1)",
        "args = sys.argv[1:]",
        "if not args: usage()",
        "cmd, rest = args[0], args[1:]",
        "state = load()",
        "try:",
        "    if cmd == 'in':",
        "        who, raw = rest[0], rest[1]",
        "        if who in state['open']: usage()",
        "        mins, label = parse_hhmm(raw)",
        "        state['open'][who] = {'mins': mins, 'label': label}",
        "        save(state)",
        "        print(f'in: {who} {label}')",
        "    elif cmd == 'out':",
        "        who, raw = rest[0], rest[1]",
        "        if who not in state['open']: usage()",
        "        end, _ = parse_hhmm(raw)",
        "        start = state['open'][who]['mins']",
        "        if end <= start: usage()",
        "        delta = end - start",
        "        state['minutes'][who] = state['minutes'].get(who, 0) + delta",
        "        del state['open'][who]",
        "        save(state)",
        "        print(f'out: {who} {delta}')",
        "    elif cmd == 'hours':",
        "        who = rest[0]",
        "        print(f\"hours: {fmt_hours(state['minutes'].get(who, 0))}\")",
        "    elif cmd == 'open':",
        "        for who in sorted(state['open']):",
        "            print(f\"{who}  since {state['open'][who]['label']}\")",
        "    elif cmd == 'overtime':",
        "        who = rest[0]",
        "        if '--threshold' not in rest: usage()",
        "        threshold = int(rest[rest.index('--threshold') + 1])",
        "        extra = max(0, state['minutes'].get(who, 0) - threshold)",
        "        print(f'overtime: {extra}')",
        "    else:",
        "        usage()",
        "except (IndexError, ValueError, KeyError):",
        "    usage()",
        "",
      ].join("\n"),
      "test.py": [
        "import os, subprocess, sys",
        "if os.path.exists('timesheet.json'): os.remove('timesheet.json')",
        "def run(*args):",
        "    return subprocess.run([sys.executable, 'timesheet.py', *args], capture_output=True, text=True)",
        "r = run('in', 'Ada', '09:00')",
        "assert r.returncode == 0 and 'in: Ada 09:00' in r.stdout",
        "assert run('in', 'Ada', '09:05').returncode != 0",
        "r = run('out', 'Ada', '10:30')",
        "assert r.returncode == 0 and 'out: Ada 90' in r.stdout",
        "print('ok')",
        "",
      ].join("\n"),
    });
    const result = await scenario.precheck(dir);
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

test("py-budget precheck accepts a correct two-file CLI", async () => {
  const scenario = SCENARIOS.find((s) => s.name === "py-budget");
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-py-budget-"));
  try {
    await scenario.setup(dir);
    await writeTree(dir, {
      "envelopes.py": [
        "import json, os",
        "def load_envelopes():",
        "    with open(os.path.join('data', 'envelopes.json'), encoding='utf-8') as f:",
        "        return {row['name']: int(row['limit']) for row in json.load(f)}",
        "def load_spent():",
        "    if not os.path.exists('spend.json'):",
        "        return {}",
        "    with open('spend.json', encoding='utf-8') as f:",
        "        return json.load(f)",
        "def save_spent(spent):",
        "    with open('spend.json', 'w', encoding='utf-8') as f:",
        "        json.dump(spent, f)",
        "def line(name, limit, spent):",
        "    return f'{name}  limit={limit}  spent={spent}  left={limit - spent}'",
        "",
      ].join("\n"),
      "budget.py": [
        "import sys",
        "from envelopes import line, load_envelopes, load_spent, save_spent",
        "def usage():",
        "    print('usage: envelopes|spend|left|over|reset', file=sys.stderr)",
        "    sys.exit(1)",
        "args = sys.argv[1:]",
        "if not args: usage()",
        "cmd, rest = args[0], args[1:]",
        "limits = load_envelopes()",
        "spent = load_spent()",
        "def get(name):",
        "    if name not in limits:",
        "        print('not found')",
        "        sys.exit(1)",
        "    return spent.get(name, 0)",
        "if cmd == 'envelopes':",
        "    for name in sorted(limits):",
        "        print(line(name, limits[name], spent.get(name, 0)))",
        "elif cmd == 'spend':",
        "    name, raw = rest[0], rest[1]",
        "    amount = int(raw)",
        "    if amount <= 0: usage()",
        "    total = get(name) + amount",
        "    spent[name] = total",
        "    save_spent(spent)",
        "    print(f'spent: {name} {total}')",
        "elif cmd == 'left':",
        "    name = rest[0]",
        "    print(f'left: {limits[name] - get(name)}')",
        "elif cmd == 'over':",
        "    rows = [line(name, limits[name], spent.get(name, 0)) for name in sorted(limits) if spent.get(name, 0) > limits[name]]",
        "    print('\\n'.join(rows) if rows else 'none')",
        "elif cmd == 'reset':",
        "    name = rest[0]",
        "    get(name)",
        "    spent[name] = 0",
        "    save_spent(spent)",
        "    print(f'reset: {name}')",
        "else:",
        "    usage()",
        "",
      ].join("\n"),
      "test.py": [
        "import os, subprocess, sys",
        "if os.path.exists('spend.json'): os.remove('spend.json')",
        "def run(*args):",
        "    return subprocess.run([sys.executable, 'budget.py', *args], capture_output=True, text=True)",
        "assert 'groceries  limit=100  spent=0  left=100' in run('envelopes').stdout",
        "r = run('spend', 'groceries', '30')",
        "assert r.returncode == 0 and 'spent: groceries 30' in r.stdout",
        "print('ok')",
        "",
      ].join("\n"),
    });
    const result = await scenario.precheck(dir);
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

test("cs-kanban precheck compiles and checks CLI output", { timeout: 120_000 }, async () => {
  const scenario = SCENARIOS.find((s) => s.name === "cs-kanban");
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-cs-kanban-"));
  try {
    await scenario.setup(dir);
    await writeTree(dir, {
      "Board.cs": [
        "using System.Text.Json;",
        "public sealed record Card(int Id, string Col, string Title);",
        "public sealed class Board {",
        "  static readonly HashSet<string> Cols = new(StringComparer.Ordinal) { \"todo\", \"doing\", \"done\" };",
        "  public int NextId { get; set; } = 1;",
        "  public List<Card> Cards { get; set; } = new();",
        "  public static bool ValidCol(string col) => Cols.Contains(col);",
        "  public static Board Load(string path) {",
        "    if (!File.Exists(path)) return new Board();",
        "    using var doc = JsonDocument.Parse(File.ReadAllText(path));",
        "    var board = new Board { NextId = doc.RootElement.GetProperty(\"nextId\").GetInt32() };",
        "    foreach (var el in doc.RootElement.GetProperty(\"cards\").EnumerateArray()) {",
        "      board.Cards.Add(new Card(el.GetProperty(\"id\").GetInt32(), el.GetProperty(\"col\").GetString()!, el.GetProperty(\"title\").GetString()!));",
        "    }",
        "    return board;",
        "  }",
        "  public void Save(string path) {",
        "    var payload = new { nextId = NextId, cards = Cards.Select(c => new { id = c.Id, col = c.Col, title = c.Title }) };",
        "    File.WriteAllText(path, JsonSerializer.Serialize(payload));",
        "  }",
        "  public static string Format(Card c) => $\"{c.Id}  {c.Col}  {c.Title}\";",
        "}",
        "",
      ].join("\n"),
      "Program.cs": [
        "var store = \"board.json\";",
        "var board = Board.Load(store);",
        "if (args.Length == 0) Usage();",
        "switch (args[0]) {",
        "  case \"add\":",
        "    if (args.Length < 3 || !Board.ValidCol(args[1])) Usage();",
        "    board.Cards.Add(new Card(board.NextId, args[1], args[2]));",
        "    Console.WriteLine($\"added: {board.NextId}\");",
        "    board.NextId++;",
        "    board.Save(store);",
        "    break;",
        "  case \"list\": {",
        "    IEnumerable<Card> cards = board.Cards.OrderBy(c => c.Id);",
        "    if (args.Length > 1) {",
        "      if (!Board.ValidCol(args[1])) Usage();",
        "      cards = cards.Where(c => c.Col == args[1]);",
        "    }",
        "    foreach (var c in cards) Console.WriteLine(Board.Format(c));",
        "    break;",
        "  }",
        "  case \"move\": {",
        "    if (args.Length < 3) Usage();",
        "    int moveId;",
        "    if (!int.TryParse(args[1], out moveId) || !Board.ValidCol(args[2])) Usage();",
        "    var idx = board.Cards.FindIndex(c => c.Id == moveId);",
        "    if (idx < 0) Usage();",
        "    board.Cards[idx] = board.Cards[idx] with { Col = args[2] };",
        "    board.Save(store);",
        "    Console.WriteLine($\"moved: {moveId} {args[2]}\");",
        "    break;",
        "  }",
        "  case \"find\":",
        "    if (args.Length < 2) Usage();",
        "    foreach (var c in board.Cards.Where(c => c.Title.Contains(args[1], StringComparison.OrdinalIgnoreCase)).OrderBy(c => c.Id))",
        "      Console.WriteLine(Board.Format(c));",
        "    break;",
        "  case \"done\":",
        "    foreach (var c in board.Cards.Where(c => c.Col == \"done\").OrderBy(c => c.Id)) Console.WriteLine(Board.Format(c));",
        "    break;",
        "  default:",
        "    Usage();",
        "    break;",
        "}",
        "void Usage() { Console.WriteLine(\"usage: add|list|move|find|done\"); Environment.Exit(1); }",
        "",
      ].join("\n"),
    });
    const result = await scenario.precheck(dir);
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

test("cs-booking precheck compiles and checks CLI output", { timeout: 120_000 }, async () => {
  const scenario = SCENARIOS.find((s) => s.name === "cs-booking");
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-cs-book-"));
  try {
    await scenario.setup(dir);
    await writeTree(dir, {
      "Bookings.cs": [
        "using System.Text.Json;",
        "public sealed record Room(string Id, string Name);",
        "public sealed record Booking(int Id, string Room, string Date, int Slot);",
        "public sealed class BookingStore {",
        "  public int NextId { get; set; } = 1;",
        "  public List<Booking> Bookings { get; set; } = new();",
        "  public static List<Room> LoadRooms(string path) {",
        "    using var doc = JsonDocument.Parse(File.ReadAllText(path));",
        "    return doc.RootElement.EnumerateArray()",
        "      .Select(el => new Room(el.GetProperty(\"id\").GetString()!, el.GetProperty(\"name\").GetString()!))",
        "      .OrderBy(r => r.Id, StringComparer.Ordinal).ToList();",
        "  }",
        "  public static BookingStore Load(string path) {",
        "    if (!File.Exists(path)) return new BookingStore();",
        "    using var doc = JsonDocument.Parse(File.ReadAllText(path));",
        "    var store = new BookingStore { NextId = doc.RootElement.GetProperty(\"nextId\").GetInt32() };",
        "    foreach (var el in doc.RootElement.GetProperty(\"bookings\").EnumerateArray()) {",
        "      store.Bookings.Add(new Booking(el.GetProperty(\"id\").GetInt32(), el.GetProperty(\"room\").GetString()!, el.GetProperty(\"date\").GetString()!, el.GetProperty(\"slot\").GetInt32()));",
        "    }",
        "    return store;",
        "  }",
        "  public void Save(string path) {",
        "    var payload = new { nextId = NextId, bookings = Bookings.Select(b => new { id = b.Id, room = b.Room, date = b.Date, slot = b.Slot }) };",
        "    File.WriteAllText(path, JsonSerializer.Serialize(payload));",
        "  }",
        "}",
        "",
      ].join("\n"),
      "Program.cs": [
        "var rooms = BookingStore.LoadRooms(Path.Combine(\"data\", \"rooms.json\"));",
        "var storePath = \"bookings.json\";",
        "var store = BookingStore.Load(storePath);",
        "if (args.Length == 0) Usage();",
        "switch (args[0]) {",
        "  case \"rooms\":",
        "    foreach (var room in rooms) Console.WriteLine($\"{room.Id}  {room.Name}\");",
        "    break;",
        "  case \"book\": {",
        "    if (args.Length < 4) Usage();",
        "    var roomId = args[1];",
        "    var date = args[2];",
        "    int slot;",
        "    if (!int.TryParse(args[3], out slot) || slot < 1 || slot > 8) Usage();",
        "    if (!rooms.Any(r => r.Id == roomId)) { Console.WriteLine(\"not found\"); Environment.Exit(1); }",
        "    if (store.Bookings.Any(b => b.Room == roomId && b.Date == date && b.Slot == slot)) { Console.WriteLine(\"taken\"); Environment.Exit(1); }",
        "    store.Bookings.Add(new Booking(store.NextId, roomId, date, slot));",
        "    Console.WriteLine($\"booked: {store.NextId}\");",
        "    store.NextId++;",
        "    store.Save(storePath);",
        "    break;",
        "  }",
        "  case \"cancel\": {",
        "    if (args.Length < 2) Usage();",
        "    int cancelId;",
        "    if (!int.TryParse(args[1], out cancelId)) Usage();",
        "    var found = store.Bookings.Find(b => b.Id == cancelId);",
        "    if (found is null) { Console.WriteLine(\"not found\"); Environment.Exit(1); }",
        "    store.Bookings.Remove(found);",
        "    store.Save(storePath);",
        "    Console.WriteLine($\"canceled: {cancelId}\");",
        "    break;",
        "  }",
        "  case \"agenda\":",
        "    if (args.Length < 2) Usage();",
        "    foreach (var b in store.Bookings.Where(b => b.Date == args[1]).OrderBy(b => b.Room, StringComparer.Ordinal).ThenBy(b => b.Slot))",
        "      Console.WriteLine($\"{b.Room}  slot={b.Slot}  booking={b.Id}\");",
        "    break;",
        "  case \"free\": {",
        "    if (args.Length < 3) Usage();",
        "    if (!rooms.Any(r => r.Id == args[1])) { Console.WriteLine(\"not found\"); Environment.Exit(1); }",
        "    var used = store.Bookings.Count(b => b.Room == args[1] && b.Date == args[2]);",
        "    Console.WriteLine($\"free: {8 - used}\");",
        "    break;",
        "  }",
        "  default:",
        "    Usage();",
        "    break;",
        "}",
        "void Usage() { Console.WriteLine(\"usage: rooms|book|cancel|agenda|free\"); Environment.Exit(1); }",
        "",
      ].join("\n"),
    });
    const result = await scenario.precheck(dir);
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
  assert.equal(
    describeRunSelection(names, parseCliArgs(["--language", "csharp"], defaultConfig())),
    "language csharp, tier ≤5 (progression)",
  );
});

test("checkpointRelForLanguage isolates js, python, and csharp files", () => {
  assert.equal(checkpointRelForLanguage(null), ".halo-agent/bench-checkpoint.json");
  assert.equal(checkpointRelForLanguage(["csharp"]), ".halo-agent/bench-checkpoint-csharp.json");
  assert.equal(checkpointRelForLanguage(["python"]), ".halo-agent/bench-checkpoint-python.json");
  assert.equal(checkpointRelForLanguage(["js"]), ".halo-agent/bench-checkpoint-js.json");
  assert.equal(
    checkpointRelForLanguage(["csharp", "python"]),
    ".halo-agent/bench-checkpoint-csharp+python.json",
  );
});

test("languageFilterFromCheckpoint reads stored filter or selection label", () => {
  assert.deepEqual(languageFilterFromCheckpoint({ languageFilter: ["python"] }), ["python"]);
  assert.deepEqual(
    languageFilterFromCheckpoint({ selectionLabel: "language csharp, tier ≤5 (progression)" }),
    ["csharp"],
  );
  assert.equal(languageFilterFromCheckpoint({ selectionLabel: "tier ≤5 (progression)" }), null);
});

test("listCheckpoints and clearAllCheckpoints keep language files independent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-bench-langs-"));
  try {
    const pythonPath = path.join(dir, "bench-checkpoint-python.json");
    const csharpPath = path.join(dir, "bench-checkpoint-csharp.json");
    await saveCheckpoint(
      pythonPath,
      buildCheckpointRecord({
        runKey: "py",
        selectionLabel: "language python, tier ≤5 (progression)",
        scenarioNames: ["py-greet"],
        completedNames: ["py-greet"],
        results: [],
        startedAt: "2026-01-01T00:00:00.000Z",
        languageFilter: ["python"],
      }),
    );
    await saveCheckpoint(
      csharpPath,
      buildCheckpointRecord({
        runKey: "cs",
        selectionLabel: "language csharp, tier ≤5 (progression)",
        scenarioNames: ["cs-greet"],
        completedNames: [],
        results: [],
        startedAt: "2026-01-01T00:00:00.000Z",
        languageFilter: ["csharp"],
      }),
    );
    const listed = await listCheckpoints(dir);
    assert.equal(listed.length, 2);
    assert.ok(listed.some((item) => item.languageFilter?.[0] === "python"));
    assert.ok(listed.some((item) => item.languageFilter?.[0] === "csharp"));
    await clearCheckpoint(pythonPath);
    assert.equal(await loadCheckpoint(pythonPath), null);
    assert.equal((await loadCheckpoint(csharpPath)).runKey, "cs");
    const cleared = await clearAllCheckpoints(dir);
    assert.ok(cleared.some((p) => p.endsWith("bench-checkpoint-csharp.json")));
    assert.equal(await loadCheckpoint(csharpPath), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  assert.equal(opts.checkpointExplicit, true);
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
  assert.equal(shouldStopBench({ error: "This operation was aborted" }), false);
  assert.equal(shouldStopBench({ error: "The operation was aborted" }), false);
  assert.equal(isScenarioTimeoutError("This operation was aborted"), true);
  assert.equal(shouldStopBench({ error: "Judge response was not valid JSON." }), false);
  assert.equal(isJudgeJsonError("Judge response was not valid JSON."), true);
  assert.equal(
    shouldStopBench({ error: "Ollama /api/chat returned 500: Internal Server Error" }),
    false,
  );
  assert.equal(
    isTransientProviderError("Ollama /api/chat returned 500: Internal Server Error"),
    true,
  );
  assert.equal(shouldStopBench({ error: "Cursor agent exited 1" }), true);
});
