import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeFitBudget,
  detectVramBytes,
  resetHardwareProbe,
  resolveModelFitBudget,
  VRAM_FIT_FRACTION,
} from "../src/hardware.mjs";
import { buildModelLadder } from "../src/escalation.mjs";

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

test("the ladder drops a local model that cannot fit in VRAM", async () => {
  const client = {
    async listModelsDetailed() {
      return [
        { name: "qwen3:14b", parameterSize: "14.8B", sizeBytes: 9 * GB },
        // Fits the 32 GB RAM rule, but not a 24 GB card: it would spill to CPU.
        { name: "qwen3:72b", parameterSize: "72B", sizeBytes: 28 * GB },
      ];
    },
    async show() {
      return { capabilities: ["tools", "thinking"] };
    },
  };

  const withGpu = await buildModelLadder({ client, totalMemBytes: 64 * GB, vramBytes: 24 * GB });
  assert.deepEqual(
    withGpu.map((m) => m.name),
    ["qwen3:14b"],
  );

  const ramOnly = await buildModelLadder({ client, totalMemBytes: 64 * GB, vramBytes: 0 });
  assert.deepEqual(
    ramOnly.map((m) => m.name),
    ["qwen3:14b", "qwen3:72b"],
  );
});
