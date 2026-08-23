import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { changedFilesFromSteps, SessionStore } from "../src/session-store.mjs";

let root;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "halo-agent-sessions-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const runResult = (messages, steps) => ({ messages, steps });

test("loading a missing session returns null", async () => {
  const store = new SessionStore({ workspaceRoot: root });
  assert.equal(await store.load("nope"), null);
});

test("save/load round-trips a merged session", async () => {
  const store = new SessionStore({ workspaceRoot: root });
  const result = runResult(
    [
      { role: "system", content: "S" },
      { role: "user", content: "do it" },
      { role: "assistant", content: "done" },
    ],
    [{ index: 1, kind: "final", content: "done", toolCalls: [] }],
  );

  const merged = store.merge("task-one", null, result);
  await store.save("task-one", merged);
  const loaded = await store.load("task-one");

  assert.equal(loaded.name, "task-one");
  assert.equal(loaded.messages.length, 3);
  assert.equal(loaded.steps.length, 1);
  assert.ok(loaded.createdAt);
  assert.deepEqual(loaded.changedFiles, []);
});

test("merge accumulates steps and changed files across runs", async () => {
  const store = new SessionStore({ workspaceRoot: root });
  const firstRun = runResult(
    [{ role: "system", content: "S" }],
    [
      {
        index: 1,
        kind: "tool-calls",
        content: "",
        toolCalls: [
          { name: "write_file", args: { path: "a.txt" }, ok: true, result: { path: "a.txt" } },
        ],
      },
    ],
  );
  const first = store.merge("multi", null, firstRun);

  const secondRun = runResult(
    [{ role: "system", content: "S" }, { role: "user", content: "more" }],
    [
      {
        index: 1,
        kind: "tool-calls",
        content: "",
        toolCalls: [
          { name: "edit_file", args: { path: "b.txt" }, ok: true, result: { path: "b.txt" } },
          { name: "write_file", args: { path: "a.txt" }, ok: true, result: { path: "a.txt" } },
          { name: "read_file", args: { path: "c.txt" }, ok: true, result: "text" },
        ],
      },
    ],
  );
  const second = store.merge("multi", first, secondRun);

  assert.equal(second.steps.length, 2);
  assert.deepEqual(second.changedFiles, ["a.txt", "b.txt"]);
  assert.equal(second.createdAt, first.createdAt);
  // Messages are the latest full transcript, not an accumulation.
  assert.equal(second.messages.length, 2);
});

test("failed write calls do not count as changed files", () => {
  const files = changedFilesFromSteps([
    {
      toolCalls: [
        { name: "write_file", args: { path: "bad.txt" }, ok: false, error: "denied" },
        { name: "run_command", args: { command: "x" }, ok: true, result: {} },
      ],
    },
  ]);
  assert.deepEqual(files, []);
});

test("list returns saved session names", async () => {
  const store = new SessionStore({ dir: path.join(root, "list-test") });
  assert.deepEqual(await store.list(), []);
  await store.save("beta", store.merge("beta", null, runResult([], [])));
  await store.save("alpha", store.merge("alpha", null, runResult([], [])));
  assert.deepEqual(await store.list(), ["alpha", "beta"]);
});

test("session names are sanitized to filename-safe forms", async () => {
  const store = new SessionStore({ workspaceRoot: root });
  const merged = store.merge("fix bug #42 / retry", null, runResult([], []));
  assert.equal(merged.name, "fix-bug-42-retry");
  assert.throws(() => store.merge("..", null, runResult([], [])), /not a usable session name/);
});
