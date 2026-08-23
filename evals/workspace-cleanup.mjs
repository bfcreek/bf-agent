/**
 * Best-effort temp workspace removal (Windows often keeps handles briefly).
 */

import { rm } from "node:fs/promises";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RETRYABLE = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"]);

/**
 * @param {string} dir
 * @param {object} [options]
 * @param {number} [options.attempts]
 * @param {number} [options.baseDelayMs]
 * @param {number} [options.settleMs] Extra wait before first attempt (Windows).
 * @returns {Promise<{removed: boolean, error?: Error}>}
 */
export async function removeWorkspaceDir(dir, options = {}) {
  const isWin = process.platform === "win32";
  const attempts = options.attempts ?? (isWin ? 12 : 4);
  const baseDelayMs = options.baseDelayMs ?? (isWin ? 300 : 100);
  const settleMs = options.settleMs ?? (isWin ? 500 : 0);

  if (settleMs > 0) {
    await sleep(settleMs);
  }

  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 0 });
      return { removed: true };
    } catch (err) {
      lastError = err;
      const code = err && typeof err === "object" && "code" in err ? err.code : "";
      if (!RETRYABLE.has(code) || attempt === attempts - 1) {
        return { removed: false, error: lastError };
      }
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }

  return { removed: false, error: lastError };
}
