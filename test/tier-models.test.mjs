import assert from "node:assert/strict";
import { test } from "node:test";

import { isLikelyToolCapable } from "../src/model-routing.mjs";
import {
  applyTierPresetPolicy,
  coerceTierPresetModel,
  detectAutoTierPreset,
  getTierPresetBands,
  getTierPresetPolicy,
  normalizeTierModels,
  parseTierPresetArg,
  resolveEffectiveTierModels,
  resolveTierModel,
  resolveTierPreset,
  TIER_PRESET_HELP,
  TIER_PRESETS,
  PINNED_MODELS,
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

test("resolveTierModel uses band vision models when requireVision", () => {
  const bands = [
    { throughTier: 1, model: "small", vision: "small-vl" },
    { throughTier: 3, model: "medium", vision: "medium-vl" },
    { model: "kimi-k2.7-code:cloud", vision: "kimi-k2.7-code:cloud" },
  ];
  assert.equal(resolveTierModel(0, bands, "fallback", { requireVision: true }), "small-vl");
  assert.equal(resolveTierModel(2, bands, "fallback", { requireVision: true }), "medium-vl");
  assert.equal(resolveTierModel(5, bands, "fallback", { requireVision: true }), "kimi-k2.7-code:cloud");
  // No vision on a band → fall back to primary model.
  assert.equal(
    resolveTierModel(0, [{ throughTier: 1, model: "text-only" }], "fallback", { requireVision: true }),
    "text-only",
  );
});

test("uniqueTierModels includes vision models without duplicates", () => {
  const bands = [
    { throughTier: 1, model: "small", vision: "vl" },
    { throughTier: 3, model: "medium", vision: "vl" },
    { model: "medium" },
  ];
  assert.deepEqual(uniqueTierModels(bands), ["small", "vl", "medium"]);
});

test("normalizeTierModels accepts vision from user YAML", () => {
  const bands = normalizeTierModels([
    { "through-tier": 1, model: "qwen3-coder:14b", vision: "devstral-small-2" },
    { model: "kimi-k2.7-code:cloud" },
  ]);
  assert.equal(bands[0].throughTier, 1);
  assert.equal(bands[0].vision, "devstral-small-2");
  assert.equal(bands[1].vision, undefined);
});

test("TIER_PRESETS include vision models on every band", () => {
  for (const [name, bands] of Object.entries(TIER_PRESETS)) {
    for (const band of bands) {
      assert.ok(band.vision, `${name} band missing vision: ${JSON.stringify(band)}`);
    }
  }
});

test("TIER_PRESETS primary and vision models are all tool-capable", () => {
  for (const [name, bands] of Object.entries(TIER_PRESETS)) {
    for (const band of bands) {
      for (const key of ["model", "vision"]) {
        const model = band[key];
        if (!model) continue;
        assert.equal(
          isLikelyToolCapable(model),
          true,
          `${name} ${key} '${model}' must be a known tool-capable family`,
        );
      }
    }
  }
  assert.equal(isLikelyToolCapable(PINNED_MODELS.local), true);
  assert.equal(isLikelyToolCapable(PINNED_MODELS.cloud), true);
  assert.equal(isLikelyToolCapable(PINNED_MODELS.cloudMax), true);
});

test("parseTierPresetArg accepts cloud-max and lists it in help", () => {
  assert.equal(parseTierPresetArg("cloud-max"), "cloud-max");
  assert.equal(parseTierPresetArg("CLOUD-MAX"), "cloud-max");
  assert.match(TIER_PRESET_HELP, /cloud-max/);
  assert.throws(() => parseTierPresetArg("yolo"), /cloud-max/);
});

test("getTierPresetBands returns cloud-first routing without local models", () => {
  const cloud = getTierPresetBands("cloud");
  assert.ok(cloud.every((band) => band.model.includes(":cloud")));
  assert.deepEqual(
    cloud.map((band) => band.model),
    TIER_PRESETS.cloud.map((band) => band.model),
  );
});

test("cloud-max policy enables max think and cloud-only routing", () => {
  const policy = getTierPresetPolicy("cloud-max");
  assert.equal(policy.think, "max");
  assert.equal(policy.cloudOnly, true);
  assert.equal(getTierPresetPolicy("cloud").cloudOnly, false);

  const applied = applyTierPresetPolicy({ think: "auto" }, "cloud-max");
  assert.equal(applied.think, "max");
  assert.equal(applied.cloudOnly, true);

  const kept = applyTierPresetPolicy({ think: "low" }, "cloud-max", { thinkExplicit: true });
  assert.equal(kept.think, "low");
});

test("coerceTierPresetModel treats Harbor's model string as a preset", () => {
  const options = { model: "tier-preset cloud-max" };
  coerceTierPresetModel(options);
  assert.equal(options.model, "auto");
  assert.equal(options.tierPreset, "cloud-max");

  const kept = { model: "tier-preset cloud-max", tierPreset: "hybrid" };
  coerceTierPresetModel(kept);
  assert.equal(kept.model, "auto");
  assert.equal(kept.tierPreset, "hybrid", "an explicit --tier-preset must win");

  const ordinary = { model: "gpt-oss:20b" };
  coerceTierPresetModel(ordinary);
  assert.equal(ordinary.model, "gpt-oss:20b");
});

test("cloud-max preset is the quality cloud pin at every band", () => {
  const bands = getTierPresetBands("cloud-max");
  assert.equal(bands.length, 1);
  assert.equal(bands[0].model, PINNED_MODELS.cloudMax);
  assert.equal(bands[0].vision, PINNED_MODELS.cloudMax);
  assert.notEqual(PINNED_MODELS.cloudMax, PINNED_MODELS.cloud);
  assert.equal(resolveTierModel(0, bands, "fallback"), PINNED_MODELS.cloudMax);
  assert.equal(resolveTierModel(6, bands, "fallback", { requireVision: true }), PINNED_MODELS.cloudMax);
  assert.deepEqual(
    bands.map((band) => band.model),
    TIER_PRESETS["cloud-max"].map((band) => band.model),
  );
});

test("cloud and hybrid hard band use the value cloud pin", () => {
  assert.equal(getTierPresetBands("cloud")[0].model, PINNED_MODELS.cloud);
  const hybrid = getTierPresetBands("hybrid");
  assert.equal(hybrid[0].model, PINNED_MODELS.local);
  assert.equal(hybrid.at(-1).model, PINNED_MODELS.cloud);
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
