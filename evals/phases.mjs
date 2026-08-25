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
    });
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
  };
}
