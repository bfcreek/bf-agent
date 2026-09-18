import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  applyConfigToDefaults,
  ensureConfigFile,
  getBuiltinDefaults,
  loadUserConfig,
  normalizeConfigValues,
  parseSimpleYaml,
} from "../src/user-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("parseSimpleYaml reads scalars, booleans, numbers, and lists", () => {
  const parsed = parseSimpleYaml(`
# comment
model: qwen3-coder:30b
max-steps: 20
quiet: true
mcp:
  - "npx -y foo"
  - npx -y bar
quoted: "hello # world"
`);
  assert.equal(parsed.model, "qwen3-coder:30b");
  assert.equal(parsed["max-steps"], 20);
  assert.equal(parsed.quiet, true);
  assert.deepEqual(parsed.mcp, ["npx -y foo", "npx -y bar"]);
  assert.equal(parsed.quoted, "hello # world");
});

test("parseCliArgs loads single scenario from config file", () => {
  const { values, errors } = normalizeConfigValues({
    model: "llama3.2",
    "base-url": "http://example:11434",
    "max-steps": 5,
    "no-index": true,
    "show-plan": true,
  });
  assert.deepEqual(errors, []);
  assert.equal(values.model, "llama3.2");
  assert.equal(values.baseUrl, "http://example:11434");
  assert.equal(values.maxSteps, 5);
  assert.equal(values.noIndex, true);
  assert.equal(values.showPlan, true);
});

test("normalizeConfigValues reports invalid values", () => {
  const { errors } = normalizeConfigValues({
    "max-steps": 0,
    mode: "yolo",
    unknown: true,
  });
  assert.ok(errors.some((e) => e.includes("max-steps")));
  assert.ok(errors.some((e) => e.includes("mode")));
  assert.ok(errors.some((e) => e.includes("unknown")));
});

test("applyConfigToDefaults merges without mutating the base defaults", () => {
  const defaults = getBuiltinDefaults();
  const merged = applyConfigToDefaults(defaults, { model: "from-config", mcp: ["a"] });
  assert.equal(defaults.model, "auto");
  assert.deepEqual(defaults.mcp, []);
  assert.equal(merged.model, "from-config");
  assert.deepEqual(merged.mcp, ["a"]);
});

test("ensureConfigFile creates a commented template", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-agent-config-"));
  const configPath = path.join(dir, "config.yaml");
  const previous = { ...process.env };
  process.env.HALO_AGENT_CONFIG = configPath;
  try {
    const created = await ensureConfigFile();
    assert.equal(created, configPath);
    const text = await readFile(configPath, "utf8");
    assert.match(text, /Bitfield Agent user configuration/);
    assert.match(text, /base-url:/);
    assert.match(text, /show-plan:/);

    await ensureConfigFile();
    const again = await readFile(configPath, "utf8");
    assert.equal(text, again);
  } finally {
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadUserConfig reads values from HALO_AGENT_CONFIG", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-agent-config-"));
  const configPath = path.join(dir, "config.yaml");
  const previous = { ...process.env };
  process.env.HALO_AGENT_CONFIG = configPath;
  try {
    await writeFile(
      configPath,
      `model: custom-model
max-steps: 7
`,
      "utf8",
    );
    const loaded = await loadUserConfig();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.values.model, "custom-model");
    assert.equal(loaded.values.maxSteps, 7);
  } finally {
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
