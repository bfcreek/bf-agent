import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  assertIntegrity,
  captureIntegritySnapshot,
  checkScenarioIntegrity,
  resolveIntegrityRules,
} from "../evals/integrity.mjs";

let root;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "halo-integrity-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("captureIntegritySnapshot hashes file bytes", async () => {
  await writeFile(path.join(root, "a.txt"), "hello\n", "utf8");
  const snap = await captureIntegritySnapshot(root);
  assert.equal(snap.size, 1);
  assert.ok(snap.has("a.txt"));
  assert.match(snap.get("a.txt"), /^[a-f0-9]{64}$/);
});

test("captureIntegritySnapshot skips .halo-agent directory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-integrity-skip-"));
  await mkdir(path.join(dir, ".halo-agent"), { recursive: true });
  await writeFile(path.join(dir, ".halo-agent", "state.json"), "{}", "utf8");
  await writeFile(path.join(dir, "visible.txt"), "ok", "utf8");
  const snap = await captureIntegritySnapshot(dir);
  assert.equal(snap.size, 1);
  assert.ok(snap.has("visible.txt"));
  await rm(dir, { recursive: true, force: true });
});

test("assertIntegrity detects unexpected changes", () => {
  const before = new Map([["a.txt", "hash1"]]);
  const after = new Map([["a.txt", "hash2"]]);
  const result = assertIntegrity(before, after, {
    allowChanged: [],
    allowAdded: [],
    allowDeleted: [],
  });
  assert.equal(result.pass, false);
  assert.deepEqual(result.unexpectedChanges, ["a.txt"]);
});

test("assertIntegrity allows listed changes", () => {
  const before = new Map([
    ["a.txt", "hash1"],
    ["b.txt", "hash2"],
  ]);
  const after = new Map([
    ["a.txt", "hash1-changed"],
    ["b.txt", "hash2"],
    ["c.txt", "hash3"],
  ]);
  const result = assertIntegrity(before, after, {
    allowChanged: ["a.txt"],
    allowAdded: ["c.txt"],
    allowDeleted: [],
  });
  assert.equal(result.pass, true);
});

test("assertIntegrity detects unexpected deletes", () => {
  const before = new Map([["keep.txt", "hash1"]]);
  const after = new Map();
  const result = assertIntegrity(before, after, {
    allowChanged: [],
    allowAdded: [],
    allowDeleted: [],
  });
  assert.equal(result.pass, false);
  assert.deepEqual(result.unexpectedDeletes, ["keep.txt"]);
});

test("resolveIntegrityRules readOnly forbids all mutations", () => {
  const rules = resolveIntegrityRules({ readOnly: true });
  assert.deepEqual(rules, { allowChanged: [], allowAdded: [], allowDeleted: [] });
});

test("checkScenarioIntegrity catches agent-like corruption", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-integrity-agent-"));
  await writeFile(path.join(dir, "config.json"), '{"debug":false}\n', "utf8");
  await writeFile(path.join(dir, "README.md"), "# Demo\n", "utf8");
  const before = await captureIntegritySnapshot(dir);

  await writeFile(path.join(dir, "config.json"), '{"debug":true}\n', "utf8");
  const narrow = await checkScenarioIntegrity(dir, before, { allowChanged: ["config.json"] });
  assert.equal(narrow.pass, true);

  await writeFile(path.join(dir, "README.md"), "# Demo\nOops\n", "utf8");
  const collateral = await checkScenarioIntegrity(dir, before, { allowChanged: ["config.json"] });
  assert.equal(collateral.pass, false);
  assert.ok(collateral.detail.includes("README.md"));

  await rm(dir, { recursive: true, force: true });
});

test("checkScenarioIntegrity returns null pass when no rules", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-integrity-none-"));
  const before = await captureIntegritySnapshot(dir);
  const result = await checkScenarioIntegrity(dir, before, undefined);
  assert.equal(result.pass, null);
  await rm(dir, { recursive: true, force: true });
});

test("integrity preserves byte-level newline differences", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-integrity-eol-"));
  const filePath = path.join(dir, "no-eol.txt");
  await writeFile(filePath, "alpha", "utf8");
  const before = await captureIntegritySnapshot(dir);
  await writeFile(filePath, "alpha\n", "utf8");
  const after = await captureIntegritySnapshot(dir);
  const result = assertIntegrity(before, after, {
    allowChanged: [],
    allowAdded: [],
    allowDeleted: [],
  });
  assert.equal(result.pass, false);
  await rm(dir, { recursive: true, force: true });
});
