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
    "no-checkpoints": true,
  });
  assert.deepEqual(errors, []);
  assert.equal(values.model, "llama3.2");
  assert.equal(values.baseUrl, "http://example:11434");
  assert.equal(values.maxSteps, 5);
  // Legacy spelling maps onto the current opt-in key.
  assert.equal(values.index, false);
  assert.equal(values.noCheckpoints, true);
});

test("index, scan, and scan-profile config keys", () => {
  const defaults = getBuiltinDefaults();
  assert.equal(defaults.index, false);
  assert.equal(defaults.scan, true);
  assert.equal(defaults.scanProfile, "auto");

  const { values, errors } = normalizeConfigValues({ index: true, scan: false, "scan-profile": "Base" });
  assert.deepEqual(errors, []);
  assert.equal(values.index, true);
  assert.equal(values.scan, false);
  assert.equal(values.scanProfile, "base");

  assert.ok(normalizeConfigValues({ scan: "yes" }).errors.some((e) => e.includes("scan")));
  assert.ok(normalizeConfigValues({ "scan-profile": "" }).errors.some((e) => e.includes("scan-profile")));
});

test("max-prompt-tokens and streak-nudge config keys", () => {
  const defaults = getBuiltinDefaults();
  assert.equal(defaults.maxPromptTokens, 0);
  assert.equal(defaults.streakNudge, 0);

  const { values, errors } = normalizeConfigValues({ "max-prompt-tokens": "400k", "streak-nudge": true });
  assert.deepEqual(errors, []);
  assert.equal(values.maxPromptTokens, 400000);
  assert.equal(values.streakNudge, 6);
  assert.equal(normalizeConfigValues({ "streak-nudge": 4 }).values.streakNudge, 4);
  assert.equal(normalizeConfigValues({ "streak-nudge": false }).values.streakNudge, 0);
  assert.equal(normalizeConfigValues({ "max-prompt-tokens": 250000 }).values.maxPromptTokens, 250000);
  assert.ok(normalizeConfigValues({ "max-prompt-tokens": -1 }).errors.some((e) => e.includes("max-prompt-tokens")));
  assert.ok(normalizeConfigValues({ "streak-nudge": "often" }).errors.some((e) => e.includes("streak-nudge")));
});

test("completion-guard config key defaults on and can be disabled", () => {
  assert.equal(getBuiltinDefaults().completionGuard, true);
  assert.equal(normalizeConfigValues({ "completion-guard": false }).values.completionGuard, false);
  assert.equal(normalizeConfigValues({ "no-completion-guard": true }).values.completionGuard, false);
  assert.ok(normalizeConfigValues({ "completion-guard": "maybe" }).errors.some((e) => e.includes("completion-guard")));
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

test("num-ctx defaults to auto and accepts auto or a positive integer", () => {
  assert.equal(getBuiltinDefaults().numCtx, "auto");
  assert.equal(normalizeConfigValues({ "num-ctx": "auto" }).values.numCtx, "auto");
  assert.equal(normalizeConfigValues({ "num-ctx": "AUTO" }).values.numCtx, "auto");
  assert.equal(normalizeConfigValues({ "num-ctx": 32768 }).values.numCtx, 32768);
  assert.ok(normalizeConfigValues({ "num-ctx": "lots" }).errors.some((e) => /num-ctx.*'auto'/.test(e)));
});

test("normalizeConfigValues accepts auto-approve policies", () => {
  assert.equal(normalizeConfigValues({ "auto-approve": true }).values.autoApprove, "all");
  assert.equal(normalizeConfigValues({ "auto-approve": "off" }).values.autoApprove, "off");
  assert.deepEqual(normalizeConfigValues({ "auto-approve": "write_file,edit_file" }).values.autoApprove, [
    "write_file",
    "edit_file",
  ]);
  assert.deepEqual(normalizeConfigValues({ "auto-approve": ["run_command"] }).values.autoApprove, ["run_command"]);
  assert.ok(normalizeConfigValues({ "auto-approve": "write file" }).errors.some((e) => e.includes("auto-approve")));
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
    assert.match(text, /Bitfield Ollama Agent user configuration/);
    assert.match(text, /base-url:/);
    assert.match(text, /no-checkpoints:/);
    assert.match(text, /completion-guard:/);
    assert.match(text, /instructions\.md/);

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
