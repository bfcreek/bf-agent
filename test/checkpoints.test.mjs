import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { CHECKPOINT_DIR, CheckpointStore } from "../src/checkpoints.mjs";
import { ToolRegistry } from "../src/tool-registry.mjs";
import { registerBuiltinTools } from "../src/tools/builtin.mjs";

let root;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "halo-agent-ckpt-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const exists = (p) => access(p).then(() => true, () => false);

test("snapshot keeps the first pre-edit state per file and restore puts it back", async () => {
  const store = new CheckpointStore({ workspaceRoot: root, runId: "run-a" });
  await writeFile(path.join(root, "a.txt"), "v1", "utf8");

  const first = await store.snapshot("a.txt", { tool: "edit_file" });
  assert.equal(first.existed, true);
  assert.equal(first.tool, "edit_file");
  await writeFile(path.join(root, "a.txt"), "v2", "utf8");
  assert.equal(await store.snapshot("a.txt"), null, "second snapshot of the same file is a no-op");
  await writeFile(path.join(root, "a.txt"), "v3", "utf8");

  const created = await store.snapshot("new/b.txt", { tool: "write_file" });
  assert.equal(created.existed, false);
  await mkdir(path.join(root, "new"), { recursive: true });
  await writeFile(path.join(root, "new", "b.txt"), "brand new", "utf8");

  const manifest = JSON.parse(await readFile(path.join(root, CHECKPOINT_DIR, "run-a", "manifest.json"), "utf8"));
  assert.equal(manifest.runId, "run-a");
  assert.deepEqual(manifest.files.map((f) => f.path), ["a.txt", "new/b.txt"]);

  const { restored, removed } = await CheckpointStore.restore(root, "run-a");
  assert.deepEqual(restored, ["a.txt"]);
  assert.deepEqual(removed, ["new/b.txt"]);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "v1");
  assert.equal(await exists(path.join(root, "new", "b.txt")), false);

  const runs = await CheckpointStore.list(root);
  assert.ok(runs.some((r) => r.runId === "run-a" && r.files.length === 2));
});

test("list returns [] when no checkpoints exist", async () => {
  const empty = await mkdtemp(path.join(os.tmpdir(), "halo-agent-ckpt-empty-"));
  try {
    assert.deepEqual(await CheckpointStore.list(empty), []);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("write_file and edit_file snapshot through the registry before changing the file", async () => {
  const store = new CheckpointStore({ workspaceRoot: root, runId: "run-tools" });
  const registry = registerBuiltinTools(new ToolRegistry(), { workspaceRoot: root, checkpoints: store });
  await writeFile(path.join(root, "c.txt"), "hello world\n", "utf8");

  const edit = await registry.execute("edit_file", { path: "c.txt", old_string: "world", new_string: "there" });
  assert.equal(edit.ok, true);
  const write = await registry.execute("write_file", { path: "d.txt", content: "fresh" });
  assert.equal(write.ok, true);

  assert.deepEqual(
    [...store.entries.values()].map((e) => [e.path, e.existed, e.tool]),
    [
      ["c.txt", true, "edit_file"],
      ["d.txt", false, "write_file"],
    ],
  );
  assert.equal(await readFile(path.join(root, CHECKPOINT_DIR, "run-tools", "files", "c.txt"), "utf8"), "hello world\n");
});

test("fetch_rule returns a listed rule body and names the known rules on a miss", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "halo-agent-rule-tool-"));
  try {
    await mkdir(path.join(ws, ".cursor", "rules"), { recursive: true });
    await writeFile(
      path.join(ws, ".cursor", "rules", "testing.mdc"),
      "---\ndescription: How to run tests\nalwaysApply: false\n---\n\nRun `npm test` before finishing.\n",
      "utf8",
    );
    const registry = registerBuiltinTools(new ToolRegistry(), { workspaceRoot: ws });

    const hit = await registry.execute("fetch_rule", { name: "testing" });
    assert.equal(hit.ok, true);
    assert.match(hit.result, /^Rule 'testing' \(\.cursor\/rules\/testing\.mdc\):/);
    assert.match(hit.result, /npm test/);

    const byExt = await registry.execute("fetch_rule", { name: "testing.mdc" });
    assert.equal(byExt.ok, true);

    const miss = await registry.execute("fetch_rule", { name: "nope" });
    assert.equal(miss.ok, false);
    assert.match(miss.error, /No rule named 'nope'\. Available rules: testing\./);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});
