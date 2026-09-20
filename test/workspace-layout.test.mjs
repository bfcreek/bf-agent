import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { defaultConfig, parseCliArgs } from "../evals/config.mjs";
import { LOCAL_DIRNAME, localBenchRoot, localPaths } from "../evals/local-layout.mjs";
import {
  DEFAULT_BENCHMARK_DIRNAME,
  defaultBenchmarkRoot,
  isInsideDir,
  languageFolder,
  prepareScenarioWorkspace,
  resetSequenceWorkspaces,
  sanitizePathSegment,
  scenarioWorkspacePath,
  sequenceWorkspacePaths,
} from "../evals/workspace-layout.mjs";

test("defaultBenchmarkRoot is a sibling named halo-agent-benchmark", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  assert.equal(defaultBenchmarkRoot(), path.resolve(repoRoot, "..", DEFAULT_BENCHMARK_DIRNAME));
});

test("localPaths nest under halo-agent-benchmark/local", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const paths = localPaths(repoRoot);
  assert.equal(localBenchRoot(repoRoot), path.join(defaultBenchmarkRoot(repoRoot), LOCAL_DIRNAME));
  assert.equal(path.basename(path.dirname(paths.json)), LOCAL_DIRNAME);
  assert.equal(path.basename(paths.json), "latest.json");
  assert.equal(path.basename(paths.recommendationsMd), "recommendations-plan.md");
  assert.equal(path.basename(paths.scoreboard), "scoreboard-history.jsonl");
  const cfg = defaultConfig();
  assert.equal(cfg.report.json, paths.json);
});

test("scenarioWorkspacePath nests language / t<tier> / name", () => {
  const root = path.join("C:", "bench-root");
  const dir = scenarioWorkspacePath(
    { name: "py-fix-tests", tier: 2, language: "python" },
    root,
  );
  assert.equal(path.relative(root, dir), path.join("python", "t2", "py-fix-tests"));
  assert.equal(languageFolder({}), "js");
  assert.equal(languageFolder({ language: "py" }), "python");
  assert.equal(sanitizePathSegment("weird name!"), "weird-name");
});

test("prepareScenarioWorkspace deletes an existing scenario folder then recreates it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "halo-bench-out-"));
  try {
    const scenario = { name: "py-greet", tier: 1, language: "python" };
    const dir = scenarioWorkspacePath(scenario, root);
    await mkdir(dir, { recursive: true });
    const stale = path.join(dir, "stale.txt");
    await writeFile(stale, "old");
    const prepared = await prepareScenarioWorkspace(scenario, { root });
    assert.equal(prepared, dir);
    await assert.rejects(readFile(stale, "utf8"), { code: "ENOENT" });
    await writeFile(path.join(dir, "fresh.txt"), "ok");
    const again = await prepareScenarioWorkspace(scenario, { root });
    assert.equal(again, dir);
    await assert.rejects(readFile(path.join(dir, "fresh.txt"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resetSequenceWorkspaces deletes only the selected language tree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "halo-bench-seq-"));
  try {
    const py = { name: "py-greet", tier: 1, language: "python" };
    const cs = { name: "cs-greet", tier: 1, language: "csharp" };
    await prepareScenarioWorkspace(py, { root });
    await writeFile(path.join(scenarioWorkspacePath(py, root), "keep-check.txt"), "py");
    await prepareScenarioWorkspace(cs, { root });
    await writeFile(path.join(scenarioWorkspacePath(cs, root), "keep-check.txt"), "cs");

    await resetSequenceWorkspaces(["python"], { root });
    await assert.rejects(
      readFile(path.join(scenarioWorkspacePath(py, root), "keep-check.txt"), "utf8"),
      { code: "ENOENT" },
    );
    assert.equal(
      await readFile(path.join(scenarioWorkspacePath(cs, root), "keep-check.txt"), "utf8"),
      "cs",
    );

    await resetSequenceWorkspaces(null, { root });
    await assert.rejects(
      readFile(path.join(scenarioWorkspacePath(cs, root), "keep-check.txt"), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isInsideDir rejects paths that escape the root", () => {
  const root = path.resolve("C:", "bench-root");
  assert.equal(isInsideDir(root, path.join(root, "python", "t1", "py-greet")), true);
  assert.equal(isInsideDir(root, path.join(root, "..", "other")), false);
});

test("sequenceWorkspacePaths with no language filter targets the whole tree", () => {
  const root = path.resolve("/tmp/bench-root");
  assert.deepEqual(sequenceWorkspacePaths(null, root), [root]);
  assert.deepEqual(sequenceWorkspacePaths(["python", "csharp"], root), [
    path.join(root, "python"),
    path.join(root, "csharp"),
  ]);
});

test("parseCliArgs accepts --benchmark-root", () => {
  const opts = parseCliArgs(["--benchmark-root", "D:\\tmp\\halo-out"], defaultConfig());
  assert.equal(opts.benchmarkRoot, "D:\\tmp\\halo-out");
});
