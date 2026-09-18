import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseRecognizedArgs, defaultRecognizedConfig, loadRecognizedOptions } from "../evals/recognized/config.mjs";
import { buildHarborArgs, buildHarborEnv, ollamaUrlForContainer, toHarborTaskFilter } from "../evals/recognized/harbor.mjs";
import { findInstructionField, loadTrialAgentMetrics, loadTrialJudgeInput } from "../evals/recognized/judge.mjs";
import { latestReportPaths, recognizedRoot, runDirectory, timestampRunId } from "../evals/recognized/layout.mjs";
import { parseHarborJob, summarizeTasks } from "../evals/recognized/parse.mjs";
import { buildRecognizedReport, formatRecognizedMarkdown } from "../evals/recognized/report.mjs";
import { listSuites, resolveDataset, resolveSuite } from "../evals/recognized/registry.mjs";
import {
  loadTaskCatalog,
  pickRandomTasks,
  resolveSampledIncludes,
} from "../evals/recognized/terminal-bench/sample.mjs";
import { buildJudgePrompt } from "../evals/judge.mjs";
import { defaultBenchmarkRoot } from "../evals/workspace-layout.mjs";

test("terminal-bench is the ready suite; swe-bench is planned", () => {
  const tb = resolveSuite("tb");
  assert.equal(tb?.id, "terminal-bench");
  assert.equal(tb?.status, "ready");
  assert.equal(resolveSuite("swe-bench")?.status, "planned");
  assert.ok(listSuites().some((s) => s.id === "terminal-bench"));
});

test("resolveDataset accepts aliases and raw Harbor ids", () => {
  const suite = resolveSuite("terminal-bench");
  assert.equal(resolveDataset(suite, "2.1").id, "terminal-bench/terminal-bench-2-1");
  assert.equal(resolveDataset(suite, "terminal-bench/custom@9").id, "terminal-bench/custom@9");
  assert.throws(() => resolveDataset(suite, "nope"), /Unknown dataset/);
});

test("parseRecognizedArgs keeps judging on by default and accepts includes", () => {
  const opts = parseRecognizedArgs(
    ["terminal-bench", "--include", "openssl-selfsigned-cert,hello-world", "--model", "gpt-oss:20b"],
    defaultRecognizedConfig(),
  );
  assert.equal(opts.suite, "terminal-bench");
  assert.equal(opts.skipJudge, false);
  assert.deepEqual(opts.includeTaskNames, ["openssl-selfsigned-cert", "hello-world"]);
  assert.equal(opts.model, "gpt-oss:20b");
});

test("parseRecognizedArgs inherits cloud-max tier preset", () => {
  const opts = parseRecognizedArgs(["terminal-bench"], defaultRecognizedConfig());
  assert.equal(opts.tierPreset, "cloud-max");
  assert.equal(opts.model, "auto");
});

test("loadRecognizedOptions resolves auto + cloud-max to the hard-band model", async () => {
  const { options } = await loadRecognizedOptions(["terminal-bench"]);
  assert.equal(options.tierPreset, "cloud-max");
  assert.equal(options.model, "kimi-k3:cloud");
});

test("loadRecognizedOptions honors explicit --model over the preset", async () => {
  const { options } = await loadRecognizedOptions(["terminal-bench", "--model", "gpt-oss:20b"]);
  assert.equal(options.model, "gpt-oss:20b");
  assert.equal(options.tierPreset, "cloud-max");
});

test("parseRecognizedArgs --skip-judge and --from-job", () => {
  const opts = parseRecognizedArgs(["tb", "--skip-judge", "--from-job", "jobs/run"], defaultRecognizedConfig());
  assert.equal(opts.skipJudge, true);
  assert.equal(opts.fromJob, "jobs/run");
});

test("parseRecognizedArgs --sample and --seed", () => {
  const opts = parseRecognizedArgs(["tb", "--sample", "5", "--seed", "42"], defaultRecognizedConfig());
  assert.equal(opts.sample, 5);
  assert.equal(opts.seed, 42);
});

test("TB 2.1 catalog has 89 unique task names", async () => {
  const tasks = await loadTaskCatalog("2.1");
  assert.equal(tasks.length, 89);
  assert.equal(new Set(tasks).size, 89);
  assert.ok(tasks.includes("openssl-selfsigned-cert"));
});

test("pickRandomTasks is deterministic for a seed", () => {
  const names = ["a", "b", "c", "d", "e", "f", "g"];
  const a = pickRandomTasks(names, { count: 3, seed: 42 });
  const b = pickRandomTasks(names, { count: 3, seed: 42 });
  assert.deepEqual(a.tasks, b.tasks);
  assert.equal(a.seed, 42);
  assert.equal(a.count, 3);
  const c = pickRandomTasks(names, { count: 3, seed: 99 });
  assert.notDeepEqual(a.tasks, c.tasks);
});

test("resolveSampledIncludes draws from include list when provided", async () => {
  const picked = await resolveSampledIncludes({
    sample: 2,
    seed: 1,
    includeTaskNames: ["alpha", "beta", "gamma"],
    dataset: "2.1",
  });
  assert.equal(picked.count, 2);
  assert.equal(picked.fromInclude, true);
  for (const name of picked.tasks) {
    assert.ok(["alpha", "beta", "gamma"].includes(name));
  }
});

test("resolveSampledIncludes draws 5 from the 2.1 catalog", async () => {
  const picked = await resolveSampledIncludes({ sample: 5, seed: 7, dataset: "2.1" });
  assert.equal(picked.count, 5);
  assert.equal(picked.poolSize, 89);
  assert.equal(picked.fromInclude, false);
  assert.equal(new Set(picked.tasks).size, 5);
});

test("buildHarborEnv forces UTF-8 so Harbor does not crash on Windows cp1252", () => {
  const env = buildHarborEnv({
    repoRoot: "C:\\repo",
    agentVersion: "0.1.0",
    model: "auto",
    containerBaseUrl: "http://host.docker.internal:11434",
  });
  assert.equal(env.PYTHONUTF8, "1");
  assert.equal(env.PYTHONIOENCODING, "utf-8");
  assert.equal(env.HALO_AGENT_REPO, "C:\\repo");
});

test("buildHarborArgs uses custom halo-agent import and downloads /app for the judge", () => {
  const args = buildHarborArgs({
    datasetId: "terminal-bench/terminal-bench-2-1",
    model: "gpt-oss:20b",
    jobsDir: "C:\\out",
    jobName: "harbor",
    repoRoot: "C:\\repo",
    containerBaseUrl: "http://host.docker.internal:11434",
    includeTaskNames: ["openssl-selfsigned-cert"],
  });
  assert.ok(args.includes("halo_agent:HaloAgent"));
  assert.ok(args.includes("--artifact"));
  assert.ok(args.includes("/app"));
  assert.ok(args.includes("--include-task-name"));
  assert.ok(args.includes("*/openssl-selfsigned-cert"));
  assert.equal(args[args.indexOf("-d") + 1], "terminal-bench/terminal-bench-2-1");
});

test("toHarborTaskFilter prefixes bare names so Harbor fnmatch can match package ids", () => {
  assert.equal(toHarborTaskFilter("build-pmars"), "*/build-pmars");
  assert.equal(toHarborTaskFilter("terminal-bench/build-pmars"), "terminal-bench/build-pmars");
  assert.equal(toHarborTaskFilter("*/openssl*"), "*/openssl*");
});

test("recognized layout sits under the sibling benchmark folder", () => {
  const repo = path.resolve(".");
  assert.equal(recognizedRoot(repo), path.join(defaultBenchmarkRoot(repo), "recognized"));
  assert.ok(runDirectory("terminal-bench", "run-1", { repoRoot: repo }).endsWith(path.join("recognized", "terminal-bench", "run-1")));
  assert.ok(timestampRunId("2026-08-25T04:00:00.000Z").includes("2026-08-25T04-00-00"));
  assert.ok(latestReportPaths("terminal-bench", { repoRoot: repo }).json.endsWith(path.join("terminal-bench", "latest.json")));
});

test("parseHarborJob reads trial_results and computes resolve rate", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-tb-job-"));
  const trialName = "openssl-selfsigned-cert__halo-agent__attempt-1";
  const trialDir = path.join(dir, trialName);
  await mkdir(trialDir, { recursive: true });
  await writeFile(
    path.join(dir, "result.json"),
    JSON.stringify({
      n_total_trials: 2,
      stats: { n_completed_trials: 2, n_errored_trials: 1 },
      trial_results: [
        {
          task_name: "openssl-selfsigned-cert",
          trial_name: trialName,
          verifier_result: { rewards: { reward: 1 } },
          started_at: "2026-08-25T00:00:00Z",
          finished_at: "2026-08-25T00:02:00Z",
        },
        {
          task_name: "build-linux-kernel-qemu",
          trial_name: "build-linux-kernel-qemu__halo-agent__attempt-1",
          verifier_result: { rewards: { reward: 0 } },
          exception_info: { exception_type: "AgentTimeoutError", exception_message: "timed out" },
          started_at: "2026-08-25T00:00:00Z",
          finished_at: "2026-08-25T00:30:00Z",
        },
      ],
    }),
    "utf8",
  );
  await writeFile(path.join(trialDir, "result.json"), JSON.stringify({ task_name: "openssl-selfsigned-cert" }), "utf8");

  const parsed = await parseHarborJob(dir);
  assert.equal(parsed.tasks.length, 2);
  const openssl = parsed.tasks.find((t) => t.name === "openssl-selfsigned-cert");
  assert.equal(openssl.resolved, true);
  assert.equal(openssl.reward, 1);
  assert.equal(openssl.seconds, 120);
  const kernel = parsed.tasks.find((t) => t.name === "build-linux-kernel-qemu");
  assert.equal(kernel.resolved, false);
  assert.match(kernel.exception, /AgentTimeoutError/);

  const summary = summarizeTasks(parsed.tasks);
  assert.equal(summary.resolved, 1);
  assert.equal(summary.errors, 1);
  assert.equal(summary.resolveRate, 0.5);
});

test("markdown report includes Harbor rate and Cursor judge scores", () => {
  const report = buildRecognizedReport({
    suite: "terminal-bench",
    suiteTitle: "Terminal-Bench",
    dataset: "terminal-bench/terminal-bench-2-1",
    datasetLabel: "Terminal-Bench 2.1",
    model: "gpt-oss:20b",
    judgeModel: "auto",
    overall: { tasks: 2, resolved: 1, errors: 0, resolveRate: 0.5, judged: 2, judgeAvg: 55, totalSeconds: 90 },
    tasks: [
      {
        name: "openssl-selfsigned-cert",
        resolved: true,
        reward: 1,
        seconds: 40,
        verdict: { score: 80, grade: "B", summary: "Tests passed; a few wasted steps." },
      },
      {
        name: "hello-world",
        resolved: false,
        reward: 0,
        seconds: 50,
        verdict: { score: 30, grade: "F", summary: "Did not write the required file." },
      },
    ],
  });
  const md = formatRecognizedMarkdown(report);
  assert.match(md, /Harbor resolve rate:\*\* 1\/2 \(50\.0%\)/);
  assert.match(md, /Cursor judge average:\*\* 55\.0\/100/);
  assert.match(md, /openssl-selfsigned-cert/);
  assert.match(md, /\| 80 \| B \|/);
});

test("recognized report attaches architecture insights from task telemetry", () => {
  const report = buildRecognizedReport({
    suite: "terminal-bench",
    suiteTitle: "Terminal-Bench",
    dataset: "terminal-bench/terminal-bench-2-1",
    overall: { tasks: 2, resolved: 0, errors: 0, resolveRate: 0, judged: 2, judgeAvg: 20, totalSeconds: 90 },
    maxSteps: 80,
    tasks: [
      {
        name: "alpha",
        resolved: false,
        reward: 0,
        score: 10,
        steps: 2,
        stopReason: "completed",
        verificationPassed: false,
        verdict: { score: 10, grade: "F", summary: "Hollow.", agentImprovements: [] },
      },
      {
        name: "beta",
        resolved: false,
        reward: 0,
        score: 15,
        steps: 3,
        stopReason: "completed",
        verificationPassed: false,
        verdict: { score: 15, grade: "F", summary: "Hollow.", agentImprovements: [] },
      },
    ],
  });
  assert.ok(Array.isArray(report.architectureInsights));
  assert.ok(
    report.architectureInsights.some((i) => i.id === "hollow-completion" || i.id === "tests-mostly-failed"),
  );
  const md = formatRecognizedMarkdown(report);
  assert.match(md, /Architecture patterns/);
});

test("loadTrialJudgeInput uses Harbor reward in the rubric and session steps", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-tb-trial-"));
  await mkdir(path.join(dir, "agent"), { recursive: true });
  await mkdir(path.join(dir, "verifier"), { recursive: true });
  await writeFile(path.join(dir, "agent", "instruction.txt"), "Create /app/hello.txt with hello world.", "utf8");
  await writeFile(
    path.join(dir, "agent", "session.json"),
    JSON.stringify({
      messages: [{ role: "assistant", content: "done" }],
      steps: [{ index: 1, kind: "tool", content: "", toolCalls: [{ name: "write_file", args: { path: "hello.txt" }, ok: true }] }],
      stopReason: "completed",
      escalationCount: 1,
      cloudUsed: false,
      verification: { passed: true },
    }),
    "utf8",
  );
  await writeFile(path.join(dir, "verifier", "reward.txt"), "1\n", "utf8");

  const packed = await loadTrialJudgeInput({
    name: "hello-world",
    trialDir: dir,
    resolved: true,
    reward: 1,
    exception: null,
  });
  assert.match(packed.scenario.goal, /hello world/);
  assert.match(packed.scenario.rubric, /Harbor verifier reward: 1/);
  assert.match(packed.preamble, /Terminal-Bench/);
  assert.equal(packed.agentResult.steps.length, 1);

  const metrics = await loadTrialAgentMetrics({ trialDir: dir });
  assert.equal(metrics.stepCount, 1);
  assert.equal(metrics.escalationCount, 1);
  assert.equal(metrics.verificationPassed, true);

  const prompt = buildJudgePrompt({
    scenario: packed.scenario,
    agentResult: packed.agentResult,
    snapshot: { root: dir, fileCount: 0, files: [] },
    preamble: packed.preamble,
  });
  assert.match(prompt, /hidden tests/);
  assert.match(prompt, /You are grading Bitfield Agent on a Terminal-Bench task/);
});

test("findInstructionField walks nested Harbor config", () => {
  assert.equal(
    findInstructionField({ task: { instruction: "Fix the server" } }),
    "Fix the server",
  );
});
