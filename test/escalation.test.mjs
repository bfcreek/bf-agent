import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeStruggleScore,
  DEFAULT_ESCALATION_THRESHOLD,
  EscalationController,
  paramsBOf,
} from "../src/escalation.mjs";

const LADDER = [
  { name: "qwen3:8b", paramsB: 8, cloud: false },
  { name: "qwen3:14b", paramsB: 14, cloud: false },
  { name: "gpt-oss:120b-cloud", paramsB: 120, cloud: true },
];

const STRUGGLING = {
  repeatedCount: 3,
  consecutiveEmpty: 2,
  toolNudgeCount: 3,
  parseRecoveries: 1,
  editMissLoop: false,
  searchLoop: false,
};

const CALM = {
  repeatedCount: 0,
  consecutiveEmpty: 0,
  toolNudgeCount: 0,
  parseRecoveries: 0,
  editMissLoop: false,
  searchLoop: false,
};

/** Minimal client stand-in: escalation only reassigns `model` on it. */
function fakeClient(model) {
  return {
    model,
    async show() {
      return { capabilities: ["tools", "thinking"] };
    },
  };
}

test("computeStruggleScore weights repeated steps and empty responses", () => {
  const low = computeStruggleScore({
    repeatedCount: 0,
    consecutiveEmpty: 0,
    toolNudgeCount: 0,
    parseRecoveries: 0,
    editMissLoop: false,
    searchLoop: false,
  });
  const high = computeStruggleScore({
    repeatedCount: 3,
    consecutiveEmpty: 2,
    toolNudgeCount: 3,
    parseRecoveries: 1,
    editMissLoop: true,
    searchLoop: true,
  });
  assert.equal(low, 0);
  assert.ok(high >= DEFAULT_ESCALATION_THRESHOLD);
});

test("two consecutive empty turns are enough struggle to escalate", () => {
  const one = { ...CALM, consecutiveEmpty: 1 };
  const two = { ...CALM, consecutiveEmpty: 2 };
  assert.ok(
    computeStruggleScore(one) < DEFAULT_ESCALATION_THRESHOLD,
    "a single empty turn must not climb the ladder",
  );
  assert.ok(
    computeStruggleScore(two) >= DEFAULT_ESCALATION_THRESHOLD,
    "repeated empty turns are calmly producing nothing",
  );
});

test("computeStruggleScore ignores single nudge", () => {
  const score = computeStruggleScore({
    repeatedCount: 0,
    consecutiveEmpty: 0,
    toolNudgeCount: 1,
    parseRecoveries: 0,
    editMissLoop: false,
    searchLoop: false,
  });
  assert.equal(score, 0);
});

test("spending the step budget with work outstanding counts as struggle", () => {
  const steady = { ...CALM, budgetPressure: 0.9, workOutstanding: false };
  const pressured = { ...CALM, budgetPressure: 0.65, workOutstanding: true };
  const critical = { ...CALM, budgetPressure: 0.9, workOutstanding: true };

  assert.equal(computeStruggleScore(steady), 0, "a run on track must not escalate");
  assert.ok(computeStruggleScore(pressured) < DEFAULT_ESCALATION_THRESHOLD);
  assert.ok(computeStruggleScore(critical) >= DEFAULT_ESCALATION_THRESHOLD);
});

test("early steps with work outstanding do not escalate", () => {
  const early = { ...CALM, budgetPressure: 0.2, workOutstanding: true };
  assert.equal(computeStruggleScore(early), 0);
});

test("hollow completion with no tools is struggle after two paid steps", () => {
  const firstTurn = { ...CALM, workOutstanding: true, hollowCompletion: true, paidSteps: 1 };
  const later = { ...CALM, workOutstanding: true, hollowCompletion: true, paidSteps: 2 };
  assert.equal(computeStruggleScore(firstTurn), 0, "turn 1 can still try");
  assert.ok(computeStruggleScore(later) >= DEFAULT_ESCALATION_THRESHOLD);
});

test("hollow completion escalates even when the contract looks satisfied", () => {
  const later = { ...CALM, workOutstanding: false, hollowCompletion: true, paidSteps: 2 };
  assert.ok(
    computeStruggleScore(later) >= DEFAULT_ESCALATION_THRESHOLD,
    "calmly producing nothing should escalate even if checks already pass on disk",
  );
});

test("two consecutive failed work commands with work outstanding is struggle", () => {
  const oneFail = { ...CALM, workOutstanding: true, consecutiveFailedRuns: 1 };
  const twoFails = { ...CALM, workOutstanding: true, consecutiveFailedRuns: 2 };
  assert.equal(computeStruggleScore(oneFail), 0, "a single failed pretest must not escalate");
  assert.ok(computeStruggleScore(twoFails) >= DEFAULT_ESCALATION_THRESHOLD);
});

test("budget pressure does not escalate when only verify commands remain", () => {
  const verifyOnly = {
    ...CALM,
    budgetPressure: 0.9,
    workOutstanding: true,
    verifyOutstandingOnly: true,
  };
  const stillBuilding = {
    ...CALM,
    budgetPressure: 0.9,
    workOutstanding: true,
    verifyOutstandingOnly: false,
  };
  assert.equal(
    computeStruggleScore(verifyOnly),
    0,
    "missing verify alone must use the acceptance nudge, not the model ladder",
  );
  assert.ok(computeStruggleScore(stillBuilding) >= DEFAULT_ESCALATION_THRESHOLD);
});

test("hollow completion does not escalate when only named deliverables remain", () => {
  const deliverableOnly = {
    ...CALM,
    hollowCompletion: true,
    paidSteps: 4,
    workOutstanding: true,
    deliverableOutstandingOnly: true,
  };
  const hollowUnknown = {
    ...CALM,
    hollowCompletion: true,
    paidSteps: 4,
    workOutstanding: true,
    deliverableOutstandingOnly: false,
  };
  assert.equal(
    computeStruggleScore(deliverableOnly),
    0,
    "named create PATH gaps must use write_file nudge, not the model ladder",
  );
  assert.ok(computeStruggleScore(hollowUnknown) >= DEFAULT_ESCALATION_THRESHOLD);
});

test("budget pressure does not escalate when only deliverables remain", () => {
  const deliverableOnly = {
    ...CALM,
    budgetPressure: 0.9,
    workOutstanding: true,
    deliverableOutstandingOnly: true,
  };
  assert.equal(computeStruggleScore(deliverableOnly), 0);
});

test("spent acceptance nudges unlock escalation on verify/deliverable-only gaps", () => {
  const verifyOnly = {
    ...CALM,
    budgetPressure: 0.9,
    workOutstanding: true,
    verifyOutstandingOnly: true,
    acceptanceNudgesSpent: true,
  };
  const deliverableOnly = {
    ...CALM,
    budgetPressure: 0.9,
    workOutstanding: true,
    deliverableOutstandingOnly: true,
    acceptanceNudgesSpent: true,
  };
  assert.ok(
    computeStruggleScore(verifyOnly) >= DEFAULT_ESCALATION_THRESHOLD,
    "when the cheap nudge lever failed, budget pressure must escalate again",
  );
  assert.ok(computeStruggleScore(deliverableOnly) >= DEFAULT_ESCALATION_THRESHOLD);
});

test("paramsBOf reads the size out of a model tag", () => {
  assert.equal(paramsBOf("qwen3:14b"), 14);
  assert.equal(paramsBOf("gpt-oss:120b-cloud"), 120);
  assert.equal(paramsBOf("llama3.2:1b"), 1);
  assert.equal(paramsBOf("some-model"), 0);
});

test("escalation climbs the ladder only while struggling", async () => {
  const client = fakeClient("qwen3:8b");
  const controller = new EscalationController({ client, ladder: LADDER, allowCloud: true });

  assert.equal(await controller.maybeEscalate(CALM), null);
  assert.equal(client.model, "qwen3:8b");

  const first = await controller.maybeEscalate(STRUGGLING);
  assert.equal(first.to, "qwen3:14b");
  assert.equal(client.model, "qwen3:14b");
  assert.equal(controller.cloudUsed, false);

  const second = await controller.maybeEscalate(STRUGGLING);
  assert.equal(second.to, "gpt-oss:120b-cloud");
  assert.equal(controller.cloudUsed, true);
  assert.equal(controller.escalationCount, 2);
});

test("escalation stops at maxEscalations", async () => {
  const client = fakeClient("qwen3:8b");
  const controller = new EscalationController({ client, ladder: LADDER, maxEscalations: 1 });

  await controller.maybeEscalate(STRUGGLING);
  assert.equal(await controller.maybeEscalate(STRUGGLING), null);
  assert.equal(client.model, "qwen3:14b");
});

test("a model missing from the ladder never escalates downward", async () => {
  const client = fakeClient("mistral-small:24b");
  const controller = new EscalationController({ client, ladder: LADDER, allowCloud: true });

  const escalated = await controller.maybeEscalate(STRUGGLING);

  assert.equal(escalated.to, "gpt-oss:120b-cloud");
  assert.equal(client.model, "gpt-oss:120b-cloud");
});

test("an unsized model off the ladder escalates from the bottom", async () => {
  const client = fakeClient("custom-model");
  const controller = new EscalationController({ client, ladder: LADDER });

  const escalated = await controller.maybeEscalate(STRUGGLING);

  assert.equal(escalated.to, "qwen3:8b");
});

test("escalation skips a cloud rung that is smaller than the current model", async () => {
  // Locals sort ahead of clouds regardless of size, so the rung directly after
  // the largest local can be a smaller cloud model.
  const ladder = [
    { name: "qwen3:14b", paramsB: 14.8, cloud: false, thinking: true },
    { name: "qwen3-coder:30b", paramsB: 30.5, cloud: false, thinking: false },
    { name: "gpt-oss:20b-cloud", paramsB: 20.9, cloud: true, thinking: true },
    { name: "gpt-oss:120b-cloud", paramsB: 116.8, cloud: true, thinking: true },
  ];
  const client = fakeClient("qwen3-coder:30b");
  const controller = new EscalationController({ client, ladder, allowCloud: true });

  const escalated = await controller.maybeEscalate(STRUGGLING);

  assert.equal(escalated.to, "gpt-oss:120b-cloud");
});

test("escalation prefers a larger local model over any cloud model", async () => {
  const ladder = [
    { name: "qwen3:14b", paramsB: 14.8, cloud: false, thinking: true },
    { name: "qwen3-coder:30b", paramsB: 30.5, cloud: false, thinking: false },
    { name: "gpt-oss:120b-cloud", paramsB: 116.8, cloud: true, thinking: true },
  ];
  const client = fakeClient("qwen3:14b");
  const controller = new EscalationController({ client, ladder });

  const escalated = await controller.maybeEscalate(STRUGGLING);

  assert.equal(escalated.to, "qwen3-coder:30b");
  assert.equal(controller.cloudUsed, false, "a local rung must not report cloud use");
});

test("cloud rungs are off by default once local models run out", async () => {
  const client = fakeClient("qwen3:14b");
  const controller = new EscalationController({ client, ladder: LADDER });

  assert.equal(await controller.maybeEscalate(STRUGGLING), null);
  assert.equal(client.model, "qwen3:14b", "must not silently move to a paid model");
  assert.equal(controller.escalationCount, 0);
  assert.match(controller.lastBlockedReason, /largest local model/);
});

test("intensifying the loaded model comes before a model swap", async () => {
  const client = { ...fakeClient("gpt-oss:20b"), thinkingCapable: true, think: "auto" };
  const ladder = [
    { name: "gpt-oss:20b", paramsB: 20.9, cloud: false, thinking: true },
    { name: "qwen3-coder:30b", paramsB: 30.5, cloud: false, thinking: false },
  ];
  const controller = new EscalationController({ client, ladder });

  const first = await controller.maybeEscalate(STRUGGLING);
  assert.equal(first.kind, "intensify");
  assert.equal(client.model, "gpt-oss:20b", "no reload should happen on the first escalation");
  assert.equal(client.think, "high");

  // Effort is a one-shot tier: the next escalation has to swap models.
  const second = await controller.maybeEscalate(STRUGGLING);
  assert.equal(second.kind, "swap");
  assert.equal(client.model, "qwen3-coder:30b");
});

test("a model already thinking at full effort skips straight to a swap", async () => {
  const client = { ...fakeClient("qwen3:14b"), thinkingCapable: true, think: true };
  const ladder = [
    { name: "qwen3:14b", paramsB: 14.8, cloud: false, thinking: true },
    { name: "qwen3-coder:30b", paramsB: 30.5, cloud: false, thinking: false },
  ];
  const controller = new EscalationController({ client, ladder });

  const escalated = await controller.maybeEscalate(STRUGGLING);

  assert.equal(escalated.kind, "swap");
  assert.equal(client.model, "qwen3-coder:30b");
});
