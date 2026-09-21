import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ensureModelsConfigFile,
  loadModelsConfig,
  normalizeModelsConfigValues,
  resolveCliModel,
} from "../src/models-config.mjs";
import { getTierPresetBands, PINNED_MODELS } from "../src/tier-models.mjs";

test("normalizeModelsConfigValues accepts preset, default-tier, and bands", () => {
  const { values, errors } = normalizeModelsConfigValues({
    preset: "cloud",
    "default-tier": 3,
    bands: [
      { "through-tier": 1, model: "glm-4.6:cloud", vision: "kimi-k2.6:cloud" },
      { model: "kimi-k2.7-code:cloud" },
    ],
  });
  assert.deepEqual(errors, []);
  assert.equal(values.tierPreset, "cloud");
  assert.equal(values.defaultTier, 3);
  assert.equal(values.tierModels[0].throughTier, 1);
  assert.equal(values.tierModels[0].vision, "kimi-k2.6:cloud");
});

test("normalizeModelsConfigValues accepts cloud-max preset", () => {
  const { values, errors } = normalizeModelsConfigValues({ preset: "cloud-max" });
  assert.deepEqual(errors, []);
  assert.equal(values.tierPreset, "cloud-max");
});

test("ensureModelsConfigFile creates models.yaml template", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-models-config-"));
  const configPath = path.join(dir, "models.yaml");
  const previous = { ...process.env };
  process.env.HALO_MODELS_CONFIG = configPath;
  try {
    const created = await ensureModelsConfigFile();
    assert.equal(created, configPath);
    const text = await readFile(configPath, "utf8");
    assert.match(text, /preset: auto/);
    assert.match(text, /cloud-max/);
    assert.match(text, /default-tier:/);
    assert.match(text, /vision:/);
  } finally {
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadModelsConfig reads HALO_MODELS_CONFIG", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-models-config-"));
  const configPath = path.join(dir, "models.yaml");
  const previous = { ...process.env };
  process.env.HALO_MODELS_CONFIG = configPath;
  try {
    await writeFile(configPath, "preset: hybrid\ndefault-tier: 1\n", "utf8");
    const loaded = await loadModelsConfig();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.exists, true);
    assert.equal(loaded.values.tierPreset, "hybrid");
    assert.equal(loaded.values.defaultTier, 1);
  } finally {
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveCliModel uses tier bands when models.yaml exists and model is auto", async () => {
  const client = {
    async listModelsDetailed() {
      return [{ name: "glm-4.6:cloud", sizeBytes: 1, parameterSize: "1T" }];
    },
    async show() {
      return { capabilities: ["tools", "thinking"] };
    },
  };
  const modelsConfig = normalizeModelsConfigValues({ preset: "cloud" }).values;
  const routed = await resolveCliModel(
    { model: "auto", baseUrl: "http://127.0.0.1:11434", tierPreset: null, taskTier: 1 },
    client,
    modelsConfig,
    true,
  );
  assert.equal(routed.model, "glm-4.6:cloud");
});

test("resolveCliModel honors explicit --model over tier routing", async () => {
  const client = {
    async listModelsDetailed() {
      return [{ name: "llama3.2", sizeBytes: 2e9, parameterSize: "3B" }];
    },
    async show() {
      return { capabilities: ["tools", "thinking"] };
    },
  };
  const routed = await resolveCliModel(
    { model: "llama3.2", baseUrl: "http://127.0.0.1:11434", tierPreset: "cloud", taskTier: 1 },
    client,
    normalizeModelsConfigValues({ preset: "cloud" }).values,
    true,
  );
  assert.equal(routed.model, "llama3.2");
});

test("resolveCliModel --tier-preset overrides models.yaml bands", async () => {
  const client = {
    async listModelsDetailed() {
      return [{ name: PINNED_MODELS.local, sizeBytes: 18e9, parameterSize: "30.5B" }];
    },
    async show() {
      return { capabilities: ["tools"] };
    },
  };
  const routed = await resolveCliModel(
    {
      model: "tier",
      baseUrl: "http://127.0.0.1:11434",
      tierPreset: "hybrid",
      taskTier: 1,
    },
    client,
    normalizeModelsConfigValues({ preset: "cloud" }).values,
    true,
  );
  assert.equal(routed.model, PINNED_MODELS.local);
  assert.deepEqual(getTierPresetBands("hybrid")[0].model, PINNED_MODELS.local);
});

test("resolveCliModel requireVision uses the band vision model", async () => {
  const client = {
    async listModelsDetailed() {
      return [
        { name: "qwen3-coder:14b", sizeBytes: 9e9, parameterSize: "14B" },
        { name: "devstral-small-2:latest", sizeBytes: 15e9, parameterSize: "24B" },
      ];
    },
    async show({ model }) {
      if (model.startsWith("devstral")) {
        return { capabilities: ["tools", "vision"] };
      }
      return { capabilities: ["tools", "thinking"] };
    },
  };
  const routed = await resolveCliModel(
    {
      model: "tier",
      baseUrl: "http://127.0.0.1:11434",
      tierPreset: "hybrid",
      taskTier: 1,
      requireVision: true,
    },
    client,
    normalizeModelsConfigValues({}).values,
    false,
  );
  assert.equal(routed.model, "devstral-small-2:latest");
});

test("resolveCliModel cloud-only preset prefers an installed cloud model over local auto-select", async () => {
  const client = {
    async listModelsDetailed() {
      return [
        { name: "gpt-oss:20b", sizeBytes: 14e9, parameterSize: "21B" },
        { name: "kimi-k2.6:cloud", sizeBytes: 1, parameterSize: "1T" },
      ];
    },
    async show() {
      return { capabilities: ["tools", "thinking"] };
    },
  };
  const routed = await resolveCliModel(
    { model: "tier-preset cloud-max", baseUrl: "http://127.0.0.1:11434", taskTier: 2 },
    client,
    normalizeModelsConfigValues({}).values,
    false,
  );
  assert.equal(routed.model, "kimi-k2.6:cloud");
  assert.ok(routed.warnings.some((w) => /cloud-only preset|strongest installed cloud/i.test(w)));
});
