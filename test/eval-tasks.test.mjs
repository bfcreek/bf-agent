/**
 * The eval harness itself must be trustworthy: for every task, the check
 * must pass on a correct outcome and fail on an untouched workspace.
 * (Running the tasks against a live model is evals/run.mjs's job.)
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TASKS } from "../evals/tasks.mjs";

const byName = Object.fromEntries(TASKS.map((t) => [t.name, t]));
const emptyResult = { text: "", stopReason: "completed", steps: [], messages: [] };
const textResult = (text) => ({ ...emptyResult, text });

async function withWorkspace(task, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-eval-test-"));
  try {
    await task.setup(dir);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("every task has a unique name, a goal, setup, and check", () => {
  const names = TASKS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const task of TASKS) {
    assert.ok(task.goal.length > 10, `${task.name} has a goal`);
    assert.equal(typeof task.setup, "function");
    assert.equal(typeof task.check, "function");
  }
});

test("all checks fail on an untouched workspace and empty answer", async () => {
  for (const task of TASKS) {
    await withWorkspace(task, async (dir) => {
      const verdict = await task.check(dir, emptyResult);
      assert.equal(verdict.pass, false, `${task.name} must fail with no agent action`);
      assert.ok(verdict.detail, `${task.name} explains the failure`);
    });
  }
});

test("answer-from-readme passes when the answer contains the port", async () => {
  await withWorkspace(byName["answer-from-readme"], async (dir) => {
    const verdict = await byName["answer-from-readme"].check(dir, textResult("It uses port 4711."));
    assert.equal(verdict.pass, true);
  });
});

test("create-file passes when hello.txt has the exact content", async () => {
  await withWorkspace(byName["create-file"], async (dir) => {
    await writeFile(path.join(dir, "hello.txt"), "hello evals\n");
    const verdict = await byName["create-file"].check(dir, emptyResult);
    assert.equal(verdict.pass, true);
  });
});

test("edit-json passes only when debug flipped and nothing else changed", async () => {
  const task = byName["edit-json"];
  await withWorkspace(task, async (dir) => {
    await writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({ name: "demo", debug: true, retries: 3 }, null, 2),
    );
    assert.equal((await task.check(dir, emptyResult)).pass, true);

    await writeFile(path.join(dir, "config.json"), JSON.stringify({ debug: true }));
    const clobbered = await task.check(dir, emptyResult);
    assert.equal(clobbered.pass, false);
    assert.match(clobbered.detail, /other keys/);
  });
});

test("find-definition accepts forward and backslash paths", async () => {
  const task = byName["find-definition"];
  await withWorkspace(task, async (dir) => {
    assert.equal((await task.check(dir, textResult("It is defined in lib/tax.mjs"))).pass, true);
    assert.equal((await task.check(dir, textResult("See lib\\tax.mjs"))).pass, true);
    assert.equal((await task.check(dir, textResult("index.mjs defines it"))).pass, false);
  });
});

test("run-command passes when the answer names this node version", async () => {
  const task = byName["run-command"];
  await withWorkspace(task, async (dir) => {
    const verdict = await task.check(dir, textResult(`The version is ${process.version}.`));
    assert.equal(verdict.pass, true);
  });
});

test("fix-failing-test passes once add.mjs is corrected", async () => {
  const task = byName["fix-failing-test"];
  await withWorkspace(task, async (dir) => {
    await writeFile(path.join(dir, "add.mjs"), "export function add(a, b) {\n  return a + b;\n}\n");
    const verdict = await task.check(dir, emptyResult);
    assert.equal(verdict.pass, true, verdict.detail);
  });
});
