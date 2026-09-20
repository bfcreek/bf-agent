import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CheckpointStore } from "../src/checkpoints.mjs";
import { collectChangeSet, formatChangeSetForPrompt, unifiedDiff } from "../evals/change-set.mjs";

test("unifiedDiff produces hunks with context and correct ranges", () => {
  const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
  const after = ["a", "b", "c", "D", "e", "f", "g", "h", "i"].join("\n");
  const diff = unifiedDiff(before, after, "x.txt");
  assert.match(diff, /^--- a\/x\.txt\n\+\+\+ b\/x\.txt\n/);
  assert.match(diff, /@@ -1,8 \+1,9 @@/);
  assert.match(diff, /\n-d\n\+D\n/);
  assert.match(diff, /\n\+i$/);
  assert.equal(diff.split("\n").filter((l) => l.startsWith("@@")).length, 1, "nearby changes share one hunk");
});

test("unifiedDiff handles whole-file add and delete", () => {
  const added = unifiedDiff("", "one\ntwo\n", "new.txt", { beforeLabel: "/dev/null" });
  assert.match(added, /^--- \/dev\/null/);
  assert.match(added, /@@ -1,0 \+1,2 @@\n\+one\n\+two$/);
  const removed = unifiedDiff("one\n", "", "old.txt", { afterLabel: "/dev/null" });
  assert.match(removed, /\+\+\+ \/dev\/null/);
  assert.match(removed, /-one$/);
  assert.equal(unifiedDiff("", "", "empty"), "--- a/empty\n+++ b/empty");
});

test("collectChangeSet pairs checkpoint snapshots with the current workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "halo-changeset-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "keep.mjs"), "export const a = 1;\n", "utf8");
    await writeFile(path.join(root, "src", "gone.mjs"), "bye\n", "utf8");
    await writeFile(path.join(root, "same.txt"), "same\n", "utf8");

    const store = new CheckpointStore({ workspaceRoot: root, runId: "run-1" });
    await store.snapshot("src/keep.mjs", { tool: "edit_file" });
    await store.snapshot("src/new.mjs", { tool: "write_file" });
    await store.snapshot("src/gone.mjs", { tool: "write_file" });
    await store.snapshot("same.txt", { tool: "write_file" });

    // The agent's actual changes:
    await writeFile(path.join(root, "src", "keep.mjs"), "export const a = 2;\nexport const b = 3;\n", "utf8");
    await writeFile(path.join(root, "src", "new.mjs"), "export default 42;\n", "utf8");
    await rm(path.join(root, "src", "gone.mjs"));
    // same.txt rewritten with identical content → unchanged.

    const set = await collectChangeSet(root);
    assert.equal(set.source, "checkpoints");
    assert.deepEqual(set.runIds, ["run-1"]);
    const byPath = Object.fromEntries(set.files.map((f) => [f.path, f]));
    assert.equal(byPath["src/keep.mjs"].status, "modified");
    assert.match(byPath["src/keep.mjs"].diff, /-export const a = 1;\n\+export const a = 2;/);
    assert.equal(byPath["src/keep.mjs"].tool, "edit_file");
    assert.equal(byPath["src/new.mjs"].status, "added");
    assert.match(byPath["src/new.mjs"].diff, /--- \/dev\/null[\s\S]*\+export default 42;/);
    assert.equal(byPath["src/gone.mjs"].status, "deleted");
    assert.match(byPath["src/gone.mjs"].diff, /\+\+\+ \/dev\/null/);
    assert.equal(byPath["same.txt"].status, "unchanged");

    const text = formatChangeSetForPrompt(set);
    assert.match(text, /Files touched by write_file\/edit_file: 4 \(1 added, 1 modified, 1 deleted, 1 no net change\)/);
    assert.match(text, /--- src\/keep\.mjs \[modified, via edit_file\] ---/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collectChangeSet keeps the earliest snapshot across multiple runs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "halo-changeset-"));
  try {
    await writeFile(path.join(root, "f.txt"), "v1\n", "utf8");
    const first = new CheckpointStore({ workspaceRoot: root, runId: "2026-01-01T00-00-00" });
    await first.snapshot("f.txt");
    await writeFile(path.join(root, "f.txt"), "v2\n", "utf8");
    const second = new CheckpointStore({ workspaceRoot: root, runId: "2026-01-01T00-05-00" });
    await second.snapshot("f.txt");
    await writeFile(path.join(root, "f.txt"), "v3\n", "utf8");

    const set = await collectChangeSet(root);
    assert.equal(set.files.length, 1);
    assert.equal(set.files[0].before, "v1\n");
    assert.equal(set.files[0].after, "v3\n");

    const onlySecond = await collectChangeSet(root, { runIds: ["2026-01-01T00-05-00"] });
    assert.equal(onlySecond.files[0].before, "v2\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collectChangeSet reports none when there are no checkpoints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "halo-changeset-"));
  try {
    const set = await collectChangeSet(root);
    assert.equal(set.source, "none");
    assert.equal(set.files.length, 0);
    assert.match(formatChangeSetForPrompt(set), /did not write or edit any files/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("formatChangeSetForPrompt respects the character budget", () => {
  const files = Array.from({ length: 5 }, (_, i) => ({
    path: `f${i}.txt`,
    status: "modified",
    before: "",
    after: "",
    diff: "x".repeat(500),
    truncated: false,
    tool: "write_file",
  }));
  const text = formatChangeSetForPrompt({ source: "checkpoints", root: "/", runIds: [], files }, { maxTotalChars: 1400 });
  assert.match(text, /--- f0\.txt/);
  assert.match(text, /--- f1\.txt/);
  assert.match(text, /3 more file\(s\) omitted/);
});
