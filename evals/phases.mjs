/**
 * Tier-6 bench phases: create a project, then a follow-up change on the same
 * workspace as a fresh agent run (new system prompt, no transcript history).
 */

/**
 * @param {import("./scenarios.mjs").BenchScenario} scenario
 * @param {{ maxSteps?: number }} [defaults]
 * @returns {Array<{ id: string, goal: string, maxSteps: number }>}
 */
export function scenarioPhases(scenario, defaults = {}) {
  const createSteps = scenario.maxSteps ?? defaults.maxSteps ?? 15;
  const phases = [{ id: "create", goal: scenario.goal, maxSteps: createSteps }];
  if (typeof scenario.followUp === "string" && scenario.followUp.trim()) {
    phases.push({
      id: "follow-up",
      goal: scenario.followUp,
      maxSteps: scenario.followUpMaxSteps ?? createSteps,
    });
  }
  return phases;
}

/**
 * Concatenate per-phase agent results for judging and reporting.
 *
 * @param {Array<import("../src/agent-loop.mjs").AgentRunResult>} phaseResults
 * @param {Array<{ id?: string, goal?: string }>} phases
 */
export function mergePhaseResults(phaseResults, phases = []) {
  const steps = [];
  const messages = [];
  const summaries = [];

  // Each phase runs as its own agent, so closed-loop telemetry has to be
  // aggregated here or the report loses it entirely.
  const checks = [];
  const missing = new Set();
  const advisory = new Set();
  const lessonIds = new Set();
  let verified = null;
  let escalationCount = 0;
  let cloudUsed = false;

  for (let i = 0; i < phaseResults.length; i++) {
    const result = phaseResults[i] ?? { text: "", stopReason: "completed", steps: [], messages: [] };
    const phase = phases[i] ?? {};
    const offset = steps.length;
    for (const step of result.steps ?? []) {
      steps.push({ ...step, index: (step.index ?? 0) + offset, phase: i + 1 });
    }
    messages.push(...(result.messages ?? []));
    summaries.push({
      id: phase.id ?? `phase-${i + 1}`,
      goal: phase.goal ?? "",
      stopReason: result.stopReason,
      steps: result.steps?.length ?? 0,
      text: result.text ?? "",
      verificationPassed: result.verification?.passed ?? null,
    });

    escalationCount += result.escalationCount ?? 0;
    if (result.cloudUsed) cloudUsed = true;
    for (const id of result.memoryLessonIds ?? []) lessonIds.add(id);
    if (result.verification) {
      // Each phase is verified against its own goal, so the run only counts as
      // verified when every phase that produced a contract passed it.
      verified = (verified ?? true) && result.verification.passed;
      checks.push(...(result.verification.checks ?? []));
      for (const item of result.verification.missing ?? []) missing.add(item);
      for (const item of result.verification.advisory ?? []) advisory.add(item);
    }
  }

  const last = phaseResults[phaseResults.length - 1] ?? {
    text: "",
    stopReason: "completed",
  };
  return {
    text: last.text ?? "",
    stopReason: last.stopReason ?? "completed",
    steps,
    messages,
    phases: summaries,
    verification:
      verified === null
        ? undefined
        : { passed: verified, checks, missing: [...missing], advisory: [...advisory] },
    escalationCount,
    cloudUsed,
    memoryLessonIds: [...lessonIds],
  };
}
