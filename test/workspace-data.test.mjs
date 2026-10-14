import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  AGENT_DATA_DIR,
  LEGACY_AGENT_DATA_DIR,
  ensureAgentDataDir,
  migrateAgentDataDir,
} from "../src/workspace-data.mjs";

/** @type {string[]} */
const temps = [];

afterEach(async () => {
  while (temps.length) {
    await rm(temps.pop(), { recursive: true, force: true });
  }
});

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "halo-agent-data-"));
  temps.push(root);
  return root;
}

test("migrateAgentDataDir renames .halo-agent to .bf/bf-agent", async () => {
  const root = await tempRoot();
  await mkdir(path.join(root, LEGACY_AGENT_DATA_DIR, "sessions"), { recursive: true });
  await writeFile(path.join(root, LEGACY_AGENT_DATA_DIR, "sessions", "a.json"), '{"name":"a"}', "utf8");

  const result = await migrateAgentDataDir(root);
  assert.deepEqual(result, { migrated: true, merged: false });
  assert.equal(
    await readFile(path.join(root, AGENT_DATA_DIR, "sessions", "a.json"), "utf8"),
    '{"name":"a"}',
  );
  await assert.rejects(() => readFile(path.join(root, LEGACY_AGENT_DATA_DIR, "sessions", "a.json")), {
    code: "ENOENT",
  });
});

test("migrateAgentDataDir merges when both directories exist", async () => {
  const root = await tempRoot();
  await mkdir(path.join(root, LEGACY_AGENT_DATA_DIR, "sessions"), { recursive: true });
  await mkdir(path.join(root, AGENT_DATA_DIR, "sessions"), { recursive: true });
  await writeFile(path.join(root, LEGACY_AGENT_DATA_DIR, "sessions", "old.json"), '{"name":"old"}', "utf8");
  await writeFile(path.join(root, AGENT_DATA_DIR, "sessions", "new.json"), '{"name":"new"}', "utf8");
  await writeFile(path.join(root, LEGACY_AGENT_DATA_DIR, "sessions", "clash.json"), '{"from":"legacy"}', "utf8");
  await writeFile(path.join(root, AGENT_DATA_DIR, "sessions", "clash.json"), '{"from":"next"}', "utf8");

  const result = await migrateAgentDataDir(root);
  assert.deepEqual(result, { migrated: true, merged: true });
  assert.equal(
    await readFile(path.join(root, AGENT_DATA_DIR, "sessions", "old.json"), "utf8"),
    '{"name":"old"}',
  );
  assert.equal(
    await readFile(path.join(root, AGENT_DATA_DIR, "sessions", "new.json"), "utf8"),
    '{"name":"new"}',
  );
  assert.equal(
    await readFile(path.join(root, AGENT_DATA_DIR, "sessions", "clash.json"), "utf8"),
    '{"from":"next"}',
  );
});

test("migrateAgentDataDir renames bitfield/bf-agent to .bf/bf-agent", async () => {
  const root = await tempRoot();
  const previous = path.join(root, "bitfield", "bf-agent", "sessions");
  await mkdir(previous, { recursive: true });
  await writeFile(path.join(previous, "b.json"), '{"name":"b"}', "utf8");

  const result = await migrateAgentDataDir(root);
  assert.deepEqual(result, { migrated: true, merged: false });
  assert.equal(
    await readFile(path.join(root, AGENT_DATA_DIR, "sessions", "b.json"), "utf8"),
    '{"name":"b"}',
  );
});

test("ensureAgentDataDir creates .bf/bf-agent", async () => {
  const root = await tempRoot();
  const dir = await ensureAgentDataDir(root);
  assert.equal(dir, path.join(root, AGENT_DATA_DIR));
  await writeFile(path.join(dir, "marker.txt"), "ok", "utf8");
  assert.equal(await readFile(path.join(root, ".bf", "bf-agent", "marker.txt"), "utf8"), "ok");
});
