import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectAutoTierPreset,
  getTierPresetBands,
  normalizeTierModels,
  resolveEffectiveTierModels,
  resolveTierModel,
  resolveTierPreset,
  TIER_PRESETS,
  uniqueTierModels,
} from "../src/tier-models.mjs";

test("resolveTierModel maps scenario tiers to configured bands", () => {
  const bands = [
    { throughTier: 1, model: "small" },
    { throughTier: 3, model: "medium" },
    { model: "kimi-k2.7-code:cloud" },
  ];
  assert.equal(resolveTierModel(0, bands, "fallback"), "small");
  assert.equal(resolveTierModel(4, bands, "fallback"), "kimi-k2.7-code:cloud");
  assert.equal(resolveTierModel(2, null, "fallback"), "fallback");
});

test("uniqueTierModels preserves band order without duplicates", () => {
  const bands = [
    { throughTier: 1, model: "small" },
    { throughTier: 3, model: "medium" },
    { model: "medium" },
  ];
  assert.deepEqual(uniqueTierModels(bands), ["small", "medium"]);
});

test("normalizeTierModels accepts through-tier from user YAML", () => {
  const bands = normalizeTierModels([
    { "through-tier": 1, model: "glm-4.6:cloud" },
    { model: "kimi-k2.7-code:cloud" },
  ]);
  assert.equal(bands[0].throughTier, 1);
  assert.equal(bands[1].model, "kimi-k2.7-code:cloud");
});

test("getTierPresetBands returns cloud-first routing without local models", () => {
  const cloud = getTierPresetBands("cloud");
  assert.ok(cloud.every((band) => band.model.includes(":cloud")));
  assert.deepEqual(
    cloud.map((band) => band.model),
    TIER_PRESETS.cloud.map((band) => band.model),
  );
});

test("detectAutoTierPreset picks hybrid when a local model qualifies", async () => {
  const client = {
    async listModelsDetailed() {
      return [{ name: "qwen3-coder:30b", sizeBytes: 20e9, parameterSize: "30B" }];
    },
    async show() {
      return { capabilities: ["tools", "thinking"] };
    },
  };
  assert.equal(await detectAutoTierPreset({ client }), "hybrid");
});

test("detectAutoTierPreset falls back to cloud when only cloud models qualify", async () => {
  const client = {
    async listModelsDetailed() {
      return [{ name: "kimi-k2.7-code:cloud", sizeBytes: 1, parameterSize: "1T" }];
    },
    async show() {
      return { capabilities: ["tools", "thinking"] };
    },
  };
  assert.equal(await detectAutoTierPreset({ client }), "cloud");
});

test("resolveEffectiveTierModels prefers CLI preset over user tier models", async () => {
  const userBands = [{ model: "user-only" }];
  const resolved = await resolveEffectiveTierModels({
    cliTierPreset: "cloud",
    userTierModels: userBands,
    userTierPreset: "local",
  });
  assert.deepEqual(resolved, getTierPresetBands("cloud"));
});

test("resolveEffectiveTierModels prefers bench override, then user bands, then preset", async () => {
  const benchBands = [{ model: "bench-only" }];
  const userBands = [{ model: "user-only" }];
  const resolvedBench = await resolveEffectiveTierModels({
    benchTierModels: benchBands,
    benchTierModelsExplicit: true,
    userTierModels: userBands,
    userTierPreset: "cloud",
  });
  assert.deepEqual(resolvedBench, benchBands);

  const resolvedUser = await resolveEffectiveTierModels({
    benchTierModelsExplicit: false,
    userTierModels: userBands,
    userTierPreset: "cloud",
  });
  assert.deepEqual(resolvedUser, userBands);

  const resolvedPreset = await resolveEffectiveTierModels({
    benchTierModelsExplicit: false,
    userTierPreset: "cloud",
  });
  assert.deepEqual(resolvedPreset, getTierPresetBands("cloud"));
});

test("resolveTierPreset resolves auto via detectAutoTierPreset", async () => {
  const client = {
    async listModelsDetailed() {
      return [{ name: "qwen3:14b", sizeBytes: 9e9, parameterSize: "14B" }];
    },
    async show() {
      return { capabilities: ["tools", "thinking"] };
    },
  };
  const bands = await resolveTierPreset("auto", { client });
  assert.deepEqual(bands, getTierPresetBands("hybrid"));
});
