/**
 * Hardware probing for model-fit decisions.
 *
 * Fit used to be judged against system RAM alone, which overstates what a GPU
 * machine can actually run. A model larger than VRAM still "fits" in RAM, but
 * Ollama then spills layers to the CPU and the model runs several times
 * slower — slow enough that escalating to it is worse than not escalating at
 * all. On a 64 GB box with a 24 GB card, the RAM rule admits 32 GB models that
 * the card cannot hold.
 *
 * NVIDIA is probed via nvidia-smi. Anything else (Apple unified memory, AMD,
 * CPU-only) reports no VRAM and falls back to the RAM rule, which is the right
 * answer for unified memory and harmless for CPU-only.
 */

import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Share of VRAM a model file may occupy. The rest covers the KV cache for the
 * context window, the embedding model used for memory and project indexing,
 * and Ollama's own overhead — all of which live in VRAM alongside the weights.
 */
export const VRAM_FIT_FRACTION = 0.8;

/** Below this, a reading is an integrated or virtual adapter, not a usable GPU. */
const MIN_USEFUL_VRAM_BYTES = 2 * 1024 ** 3;

const PROBE_TIMEOUT_MS = 5000;

/** @type {number|undefined} */
let cachedVramBytes;

/** Clear the memoized probe. Tests and long-lived processes only. */
export function resetHardwareProbe() {
  cachedVramBytes = undefined;
}

/**
 * Total VRAM in bytes, or 0 when there is no discoverable GPU.
 *
 * Multi-GPU readings are summed because Ollama will split a model across
 * cards rather than refuse to load it.
 *
 * @param {object} [options]
 * @param {Function} [options.execFileImpl] Injectable for tests.
 * @param {Record<string, string|undefined>} [options.env]
 * @returns {Promise<number>}
 */
export async function detectVramBytes({ execFileImpl = execFileAsync, env = process.env } = {}) {
  const override = Number(env.HALO_VRAM_BYTES);
  if (Number.isFinite(override) && override >= 0) return override;

  if (cachedVramBytes !== undefined) return cachedVramBytes;

  let total = 0;
  try {
    const { stdout } = await execFileImpl(
      "nvidia-smi",
      ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      { timeout: PROBE_TIMEOUT_MS },
    );
    for (const line of String(stdout).split(/\r?\n/)) {
      const mib = Number.parseFloat(line.trim());
      if (Number.isFinite(mib) && mib > 0) total += mib * 1024 ** 2;
    }
  } catch {
    // No NVIDIA driver tooling on PATH: treat as "unknown", not "none".
    total = 0;
  }

  cachedVramBytes = total;
  return total;
}

/**
 * Largest model file size that should run locally on this machine.
 *
 * @param {object} [options]
 * @param {number} [options.totalMemBytes]
 * @param {number} [options.vramBytes] Pass 0 to ignore the GPU, omit to probe.
 * @param {number} [options.memoryFitFraction]
 * @returns {Promise<{budgetBytes: number, vramBytes: number, basis: "vram"|"ram"}>}
 */
export async function resolveModelFitBudget({
  totalMemBytes = os.totalmem(),
  vramBytes,
  memoryFitFraction,
} = {}) {
  const { MEMORY_FIT_FRACTION } = await import("./model-routing.mjs");
  const fraction = memoryFitFraction ?? MEMORY_FIT_FRACTION;
  const ramBudget = totalMemBytes * fraction;
  const vram = vramBytes === undefined ? await detectVramBytes() : vramBytes;

  if (!vram || vram < MIN_USEFUL_VRAM_BYTES) {
    return { budgetBytes: ramBudget, vramBytes: vram || 0, basis: "ram" };
  }

  const vramBudget = vram * VRAM_FIT_FRACTION;
  return vramBudget < ramBudget
    ? { budgetBytes: vramBudget, vramBytes: vram, basis: "vram" }
    : { budgetBytes: ramBudget, vramBytes: vram, basis: "ram" };
}

/**
 * Human-readable hardware summary for startup warnings.
 * @param {{budgetBytes: number, vramBytes: number, basis: string}} budget
 * @returns {string}
 */
export function describeFitBudget(budget) {
  const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return budget.basis === "vram"
    ? `model fit capped at ${gb(budget.budgetBytes)} by ${gb(budget.vramBytes)} of VRAM`
    : `model fit capped at ${gb(budget.budgetBytes)} by system RAM`;
}
