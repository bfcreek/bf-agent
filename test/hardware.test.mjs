import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";

import {
  describeFitBudget,
  detectVramBytes,
  hostTotalMemBytes,
  resetHardwareProbe,
  resolveModelFitBudget,
  VRAM_FIT_FRACTION,
} from "../src/hardware.mjs";
import { suggestModel } from "../src/model-routing.mjs";

const GB = 1024 ** 3;

test("detectVramBytes sums the cards nvidia-smi reports", async () => {
  resetHardwareProbe();
  const execFileImpl = async () => ({ stdout: "24564\n24564\n" });

  const bytes = await detectVramBytes({ execFileImpl, env: {} });

  assert.equal(bytes, 2 * 24564 * 1024 ** 2);
});

test("detectVramBytes reports zero when there is no GPU tooling", async () => {
  resetHardwareProbe();
  const execFileImpl = async () => {
    throw new Error("ENOENT: nvidia-smi");
  };

  assert.equal(await detectVramBytes({ execFileImpl, env: {} }), 0);
});

test("HALO_VRAM_BYTES overrides the probe", async () => {
  resetHardwareProbe();
  const execFileImpl = async () => {
    throw new Error("should not be called");
  };

  const bytes = await detectVramBytes({ execFileImpl, env: { HALO_VRAM_BYTES: String(8 * GB) } });

  assert.equal(bytes, 8 * GB);
});

test("HALO_TOTAL_MEM_BYTES overrides the RAM probe (containerized agent, host Ollama)", () => {
  assert.equal(hostTotalMemBytes({ HALO_TOTAL_MEM_BYTES: String(64 * GB) }), 64 * GB);
  assert.equal(hostTotalMemBytes({ HALO_TOTAL_MEM_BYTES: "nonsense" }), os.totalmem());
  assert.equal(hostTotalMemBytes({}), os.totalmem());
});

test("VRAM caps the fit budget below what system RAM alone would allow", async () => {
  const budget = await resolveModelFitBudget({ totalMemBytes: 64 * GB, vramBytes: 24 * GB });

  assert.equal(budget.basis, "vram");
  assert.equal(budget.budgetBytes, 24 * GB * VRAM_FIT_FRACTION);
  assert.ok(budget.budgetBytes < 64 * GB * 0.5, "a 24 GB card must beat the 32 GB RAM rule");
  assert.match(describeFitBudget(budget), /VRAM/);
});

test("plenty of VRAM leaves the RAM rule in charge", async () => {
  const budget = await resolveModelFitBudget({ totalMemBytes: 16 * GB, vramBytes: 80 * GB });

  assert.equal(budget.basis, "ram");
  assert.equal(budget.budgetBytes, 8 * GB);
});

test("no GPU falls back to the RAM rule", async () => {
  const budget = await resolveModelFitBudget({ totalMemBytes: 32 * GB, vramBytes: 0 });

  assert.equal(budget.basis, "ram");
  assert.equal(budget.budgetBytes, 16 * GB);
});

test("auto routing skips a local model that cannot fit in VRAM", async () => {
  const models = [
    { name: "qwen3:14b", parameterSize: "14.8B", sizeBytes: 9 * GB },
    // Fits the 32 GB RAM rule, but not a 24 GB card: it would spill to CPU.
    { name: "qwen3:72b", parameterSize: "72B", sizeBytes: 28 * GB },
  ];
  const client = {
    async show() {
      return { capabilities: ["tools", "thinking"] };
    },
  };

  const withGpu = await suggestModel({ client, models, totalMemBytes: 64 * GB, vramBytes: 24 * GB });
  assert.equal(withGpu.model, "qwen3:14b");

  const ramOnly = await suggestModel({ client, models, totalMemBytes: 64 * GB, vramBytes: 0 });
  assert.equal(ramOnly.model, "qwen3:72b");
});

test("cloudOnly routing keeps only Ollama cloud models", async () => {
  const models = [
    { name: "qwen3:14b", parameterSize: "14.8B", sizeBytes: 9 * GB },
    { name: "glm-5.3:cloud", parameterSize: "753B", sizeBytes: 400 },
    { name: "kimi-k3:cloud", parameterSize: "2810B", sizeBytes: 400 },
  ];
  const client = {
    async show() {
      return { capabilities: ["tools", "thinking"] };
    },
  };

  const pick = await suggestModel({ client, models, totalMemBytes: 64 * GB, vramBytes: 24 * GB, cloudOnly: true });
  assert.equal(pick.model, "kimi-k3:cloud");
  assert.equal(pick.cloud, true);
});
