/**
 * Struggle detection and mid-run model escalation.
 * Escalates to stronger installed models only when the loop shows signs of struggle.
 */

import os from "node:os";

import {
  detectCapabilities,
  isCloudModel,
  parseParamsBillions,
  MIN_EFFECTIVE_PARAMS_B,
} from "./model-routing.mjs";
import { resolveModelFitBudget } from "./hardware.mjs";
import { configureClientModel, resolveThinkSetting } from "./prompt-enhancements.mjs";

/** Default struggle score threshold before escalating. */
export const DEFAULT_ESCALATION_THRESHOLD = 4;

/** Weight table for struggle signals. */
const SIGNAL_WEIGHTS = {
  repeatedStep: 2,
  consecutiveEmpty: 2,
  toolNudge: 1,
  parseRecovery: 2,
  editMiss: 1,
  searchLoop: 2,
  budgetPressure: 2,
  budgetCritical: 4,
  hollowCompletion: 4,
  failedCommands: 4,
};

/** Fraction of the step budget spent before outstanding work counts as struggle. */
export const BUDGET_PRESSURE_RATIO = 0.6;
/** Fraction at which outstanding work alone justifies escalating. */
export const BUDGET_CRITICAL_RATIO = 0.85;

/**
 * @typedef {object} StruggleState
 * @property {number} repeatedCount
 * @property {number} consecutiveEmpty
 * @property {number} toolNudgeCount
 * @property {number} parseRecoveries
 * @property {boolean} editMissLoop
 * @property {boolean} searchLoop
 * @property {number} [budgetPressure] Fraction of the step budget consumed.
 * @property {boolean} [workOutstanding] Acceptance contract still unsatisfied.
 * @property {boolean} [hollowCompletion] Work goal with no substantive tools yet.
 * @property {number} [paidSteps] Paid model turns so far.
 * @property {number} [consecutiveFailedRuns] Trailing non-diagnostic command failures.
 * @property {boolean} [verifyOutstandingOnly] Only named verify/work commands remain.
 */

/**
 * Compute a struggle score from loop counters.
 * @param {StruggleState} state
 * @returns {number}
 */
export function computeStruggleScore(state) {
  let score = 0;
  if (state.repeatedCount >= 2) score += SIGNAL_WEIGHTS.repeatedStep;
  if (state.consecutiveEmpty >= 1) score += SIGNAL_WEIGHTS.consecutiveEmpty;
  if (state.toolNudgeCount >= 2) score += SIGNAL_WEIGHTS.toolNudge;
  if (state.parseRecoveries >= 1) score += SIGNAL_WEIGHTS.parseRecovery;
  if (state.editMissLoop) score += SIGNAL_WEIGHTS.editMiss;
  if (state.searchLoop) score += SIGNAL_WEIGHTS.searchLoop;

  // Burning through the step budget with contract work still outstanding is the
  // clearest sign the current model will not finish. Skip when the only gap is
  // a missing verify step — climbing the ladder will not invent that tool call;
  // the acceptance nudge is the right lever.
  if (state.workOutstanding && !state.verifyOutstandingOnly) {
    const pressure = state.budgetPressure ?? 0;
    if (pressure >= BUDGET_CRITICAL_RATIO) score += SIGNAL_WEIGHTS.budgetCritical;
    else if (pressure >= BUDGET_PRESSURE_RATIO) score += SIGNAL_WEIGHTS.budgetPressure;
  }
  // Calmly producing nothing is more valuable to escalate than a visible loop.
  // Wait for at least one empty reply or two paid steps so turn 1 can still try.
  if (
    state.hollowCompletion &&
    ((state.paidSteps ?? 0) >= 2 || (state.consecutiveEmpty ?? 0) >= 1)
  ) {
    score += SIGNAL_WEIGHTS.hollowCompletion;
  }
  // Tools that keep failing are "calmly producing nothing" — escalate rather
  // than waiting for the step budget to drain.
  if (state.workOutstanding && (state.consecutiveFailedRuns ?? 0) >= 2) {
    score += SIGNAL_WEIGHTS.failedCommands;
  }
  return score;
}

/**
 * Best-effort parameter count from a model tag ("qwen3:14b" -> 14).
 * @param {string} modelName
 * @returns {number} Parameters in billions, 0 when the tag carries no size.
 */
export function paramsBOf(modelName) {
  const match = /[:\-_]?(\d+(?:\.\d+)?)\s*([bmt])\b/i.exec(String(modelName ?? ""));
  return match ? parseParamsBillions(`${match[1]}${match[2]}`) : 0;
}

/**
 * Build an escalation ladder: locals ascending by params, then cloud models.
 *
 * Tool calling is the hard requirement. Thinking is only a tie-breaker, not a
 * filter: strong non-thinking coder models are legitimate escalation targets,
 * and excluding them makes the first escalation jump to a paid cloud model
 * while a larger local model sits unused.
 *
 * Local rungs must fit the accelerator, not just system RAM: a model that
 * spills out of VRAM runs slow enough that escalating to it loses to simply
 * staying put.
 *
 * @param {object} options
 * @param {{show?: Function, listModelsDetailed: Function}} options.client
 * @param {number} [options.totalMemBytes]
 * @param {number} [options.vramBytes] Pass 0 to ignore the GPU, omit to probe.
 * @returns {Promise<Array<{name: string, paramsB: number, cloud: boolean, thinking: boolean}>>}
 */
export async function buildModelLadder({ client, totalMemBytes = os.totalmem(), vramBytes }) {
  const { budgetBytes: memoryBudget } = await resolveModelFitBudget({ totalMemBytes, vramBytes });
  const models = await client.listModelsDetailed();
  const locals = [];
  const clouds = [];

  for (const entry of models ?? []) {
    const { tools, thinking } = await detectCapabilities(client, entry.name);
    if (tools !== true) continue;
    const paramsB = parseParamsBillions(entry.parameterSize ?? "", entry.sizeBytes ?? 0);
    if (paramsB < MIN_EFFECTIVE_PARAMS_B) continue;
    const rung = { name: entry.name, paramsB, cloud: isCloudModel(entry.name), thinking: thinking === true };
    if (rung.cloud) {
      clouds.push(rung);
    } else if (!entry.sizeBytes || entry.sizeBytes <= memoryBudget) {
      locals.push(rung);
    }
  }

  // Parameter count is the capability proxy; thinking breaks ties at equal size.
  const byParams = (a, b) =>
    a.paramsB - b.paramsB ||
    Number(a.thinking) - Number(b.thinking) ||
    a.name.localeCompare(b.name);
  locals.sort(byParams);
  clouds.sort(byParams);
  return [...locals, ...clouds];
}

/**
 * Pick the weakest suitable local model for initial routing (escalation-first).
 * @param {object} options
 * @param {{show?: Function, listModelsDetailed: Function}} options.client
 * @param {number} [options.totalMemBytes]
 * @param {number} [options.vramBytes]
 * @returns {Promise<{model: string, paramsB: number, cloud: boolean, reason: string}|null>}
 */
export async function suggestWeakestLocalModel({ client, totalMemBytes = os.totalmem(), vramBytes }) {
  const ladder = await buildModelLadder({ client, totalMemBytes, vramBytes });
  const locals = ladder.filter((m) => !m.cloud);
  // Start on a thinking model where one exists — the ladder carries stronger
  // non-thinking models for escalation, but they make a weaker first attempt.
  const local = locals.find((m) => m.thinking) ?? locals[0];
  if (!local) return null;
  return {
    model: local.name,
    paramsB: local.paramsB,
    cloud: false,
    reason: `weakest local ${local.thinking ? "thinking " : ""}model with tools (>=${MIN_EFFECTIVE_PARAMS_B}B) — escalate on struggle`,
  };
}

/**
 * Manage mid-run model escalation.
 */
export class EscalationController {
  /**
   * @param {object} options
   * @param {import("./ollama-client.mjs").OllamaClient} options.client
   * @param {Array<{name: string, paramsB: number, cloud: boolean}>} options.ladder
   * @param {number} [options.threshold]
   * @param {number} [options.maxEscalations]
   * @param {boolean} [options.allowCloud] Permit paid cloud rungs. Off by
   *   default: on a machine whose largest local model is already in use,
   *   every escalation would otherwise silently become a paid call.
   */
  constructor({
    client,
    ladder,
    threshold = DEFAULT_ESCALATION_THRESHOLD,
    maxEscalations = 2,
    allowCloud = false,
  }) {
    this.client = client;
    this.ladder = ladder ?? [];
    this.threshold = threshold;
    this.maxEscalations = maxEscalations;
    this.allowCloud = allowCloud;
    this._escalationCount = 0;
    this._intensified = false;
    /** @type {string|null} Why the last escalation attempt did nothing. */
    this.lastBlockedReason = null;
    const onLadder = this.ladder.find((m) => m.name === client?.model);
    // Off-ladder models (user-pinned, or filtered out by capability detection)
    // still need a size to escalate away from, so fall back to the model tag.
    this.currentParamsB = onLadder?.paramsB ?? paramsBOf(client?.model);
  }

  /**
   * Next rung that is genuinely stronger than the current model. Escalating by
   * ladder position alone can move to a smaller model, because locals are
   * ordered ahead of clouds regardless of size.
   * @returns {{name: string, paramsB: number, cloud: boolean}|null}
   */
  nextRung() {
    return (
      this.ladder.find(
        (m) =>
          m.paramsB > this.currentParamsB &&
          m.name !== this.client?.model &&
          (this.allowCloud || !m.cloud),
      ) ?? null
    );
  }

  /**
   * Raise reasoning effort on the model already loaded.
   *
   * Swapping models costs a full unload and reload — tens of seconds for a
   * large model, and unavoidable on a card that only holds one at a time. When
   * the current model can simply think harder, that is strictly cheaper.
   *
   * The context window is deliberately left alone: growing it grows the KV
   * cache, which is exactly the VRAM pressure this tier exists to avoid.
   *
   * @returns {{from: string|boolean|undefined, to: string|boolean}|null} Null when
   *   nothing would change, so the caller can fall through to a model swap.
   */
  intensifyCurrentModel() {
    if (this._intensified) return null;
    if (this.client?.thinkingCapable !== true) return null;

    const current = resolveThinkSetting({
      think: this.client.think,
      thinkingCapable: true,
      model: this.client.model,
      paramsB: this.currentParamsB,
    });
    if (current === "high" || current === "max" || current === true) return null;

    this.client.think = "high";
    this._intensified = true;
    return { from: current, to: "high" };
  }

  /**
   * Whether the model actually in use is a cloud model. Read from the client
   * rather than the ladder cursor, which can point at a rung the run never
   * used when the starting model was off the ladder.
   * @returns {boolean}
   */
  get cloudUsed() {
    return isCloudModel(this.client?.model ?? "");
  }

  /** @returns {number} */
  get escalationCount() {
    return this._escalationCount;
  }

  /**
   * @param {StruggleState} state
   * @returns {Promise<{escalated: boolean, from?: string, to?: string, reason?: string}|null>}
   */
  async maybeEscalate(state) {
    if (this._escalationCount >= this.maxEscalations) return null;

    const score = computeStruggleScore(state);
    if (score < this.threshold) return null;

    const trigger = `struggle score ${score} >= ${this.threshold}`;
    const model = this.client?.model;

    // Cheapest first: think harder on the model already in memory.
    const intensified = this.intensifyCurrentModel();
    if (intensified) {
      this._escalationCount += 1;
      this.lastBlockedReason = null;
      return {
        escalated: true,
        kind: "intensify",
        from: model,
        to: model,
        reason: `${trigger} — raised reasoning effort ${intensified.from} → ${intensified.to} (no model reload)`,
      };
    }

    const next = this.nextRung();
    if (!next) {
      const cloudAvailable = this.ladder.some((m) => m.cloud && m.paramsB > this.currentParamsB);
      this.lastBlockedReason =
        !this.allowCloud && cloudAvailable
          ? `${trigger}, but '${model}' is already the largest local model and cloud escalation is disabled`
          : `${trigger}, but no stronger model is available`;
      return null;
    }

    await configureClientModel(this.client, next.name);
    this.currentParamsB = next.paramsB;
    this._escalationCount += 1;
    this.lastBlockedReason = null;

    return {
      escalated: true,
      kind: "swap",
      from: model,
      to: next.name,
      reason: `${trigger}${next.cloud ? " — escalating to cloud" : ""}`,
    };
  }
}

/**
 * Resolve initial model for escalation-first routing.
 * @param {object} options
 * @param {string} options.requested
 * @param {{show?: Function, listModelsDetailed: Function}} options.client
 * @param {boolean} [options.escalationEnabled]
 * @param {boolean} [options.requireVision]
 * @returns {Promise<{model: string, warnings: string[], ladder: Array<{name: string, paramsB: number, cloud: boolean}>}>}
 */
export async function resolveModelWithEscalation({
  requested,
  client,
  escalationEnabled = true,
  totalMemBytes,
  vramBytes,
  requireVision = false,
}) {
  const warnings = [];
  const ladder = await buildModelLadder({ client, totalMemBytes, vramBytes });

  if (!escalationEnabled || requested !== "auto" || requireVision) {
    // Image turns need a vision model up front — do not start on a text-only
    // weak local and hope escalation finds vision later.
    const { resolveModelAuto } = await import("./model-routing.mjs");
    const routed = await resolveModelAuto({
      requested,
      client,
      totalMemBytes,
      requireVision,
    });
    return { ...routed, ladder };
  }

  const weakest = await suggestWeakestLocalModel({ client, totalMemBytes, vramBytes });
  if (weakest) {
    warnings.push(`Using '${weakest.model}': ${weakest.reason}.`);
    return { model: weakest.model, warnings, ladder };
  }

  const { resolveModelAuto } = await import("./model-routing.mjs");
  const routed = await resolveModelAuto({ requested, client, totalMemBytes, requireVision });
  return { ...routed, ladder };
}
