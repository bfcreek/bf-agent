/**
 * Persist halo-agent run artifacts for bench judging.
 * Written into the scenario workspace so the Cursor CLI judge can read them
 * from disk even when the inline grading prompt is truncated.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { agentAnswerText } from "./scenarios.mjs";

export const ARTIFACTS_DIR = ".halo-bench";
export const ARTIFACTS_JSON = `${ARTIFACTS_DIR}/agent-artifacts.json`;
export const ARTIFACTS_STEPS_TXT = `${ARTIFACTS_DIR}/agent-steps.txt`;
export const ARTIFACTS_JUDGE_PROMPT = `${ARTIFACTS_DIR}/judge-prompt.txt`;

/**
 * Ordered tool-call names across all steps (failed calls suffixed with `!`).
 * @param {import("../src/agent-loop.mjs").AgentRunResult} agentResult
 */
export function collectToolCallOrder(agentResult) {
  /** @type {string[]} */
  const ordered = [];
  for (const step of agentResult.steps ?? []) {
    for (const call of step.toolCalls ?? []) {
      ordered.push(call.ok ? call.name : `${call.name}!`);
    }
  }
  return ordered;
}

/**
 * One-line summary for judge prompts: step count and tool ordering.
 * @param {import("../src/agent-loop.mjs").AgentRunResult} agentResult
 */
export function formatStepSummary(agentResult) {
  const ordered = collectToolCallOrder(agentResult);
  const stepCount = agentResult.steps?.length ?? 0;
  if (ordered.length === 0) return `${stepCount} step(s), no tool calls`;
  return `${stepCount} step(s), tool calls: ${ordered.join(" → ")}`;
}

/**
 * @param {import("../src/agent-loop.mjs").AgentRunResult} agentResult
 */
export function formatStepsText(agentResult) {
  const lines = [
    `stop reason: ${agentResult.stopReason}`,
    `steps: ${agentResult.steps?.length ?? 0}`,
    `tool call order: ${collectToolCallOrder(agentResult).join(" → ") || "(none)"}`,
    "",
    "final answer:",
    agentAnswerText(agentResult) || "(empty)",
    "",
    "step trace:",
  ];

  for (const step of agentResult.steps ?? []) {
    const tools = (step.toolCalls ?? [])
      .map((call) => {
        const status = call.ok ? "ok" : `error: ${call.error ?? "failed"}`;
        return `${call.name}(${JSON.stringify(call.args)}) -> ${status}`;
      })
      .join("; ");
    lines.push(
      `${step.index}. [${step.kind}] ${step.content?.slice(0, 500) || "(no text)"}${tools ? ` | ${tools}` : ""}`,
    );
  }

  return lines.join("\n");
}

/**
 * @param {import("../src/agent-loop.mjs").AgentRunResult} agentResult
 */
export function buildAgentArtifacts(agentResult, extra = {}) {
  return {
    task: extra.goal ?? extra.task ?? null,
    followUp: extra.followUp ?? null,
    rubric: extra.rubric ?? null,
    oracle: extra.oracle ?? null,
    efficiency: extra.efficiency ?? null,
    finalAnswer: agentAnswerText(agentResult),
    stopReason: agentResult.stopReason,
    elapsedMs: agentResult.elapsedMs ?? null,
    model: agentResult.model ?? null,
    numCtx: agentResult.numCtx ?? null,
    compactions: agentResult.compactions ?? 0,
    compactionFailures: agentResult.compactionFailures ?? 0,
    truncatedTurns: agentResult.truncatedTurns ?? 0,
    stepCount: agentResult.steps?.length ?? 0,
    toolCallOrder: collectToolCallOrder(agentResult),
    stepSummary: formatStepSummary(agentResult),
    steps: (agentResult.steps ?? []).map((step) => ({
      index: step.index,
      kind: step.kind,
      content: step.content ?? "",
      ...(typeof step.durationMs === "number" ? { durationMs: step.durationMs } : {}),
      ...(typeof step.promptTokens === "number" ? { promptTokens: step.promptTokens } : {}),
      ...(typeof step.completionTokens === "number" ? { completionTokens: step.completionTokens } : {}),
      ...(step.truncated === true ? { truncated: true } : {}),
      toolCalls: (step.toolCalls ?? []).map((call) => ({
        name: call.name,
        args: call.args ?? {},
        ok: Boolean(call.ok),
        error: call.error ?? null,
        ...(typeof call.durationMs === "number" ? { durationMs: call.durationMs } : {}),
        resultPreview:
          call.result == null
            ? null
            : String(typeof call.result === "string" ? call.result : JSON.stringify(call.result)).slice(
                0,
                400,
              ),
      })),
    })),
  };
}

/**
 * @param {string} workspaceDir
 * @param {import("../src/agent-loop.mjs").AgentRunResult} agentResult
 */
export async function persistAgentArtifacts(workspaceDir, agentResult, extra = {}) {
  const root = path.resolve(workspaceDir);
  const artifacts = buildAgentArtifacts(agentResult, extra);
  const dir = path.join(root, ARTIFACTS_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(root, ARTIFACTS_JSON), JSON.stringify(artifacts, null, 2), "utf8");
  await writeFile(path.join(root, ARTIFACTS_STEPS_TXT), formatStepsText(agentResult), "utf8");
  return artifacts;
}

/**
 * Persist the full judge prompt to disk so the Cursor CLI can be invoked with a
 * short command line (Windows CreateProcess limit is ~8191 chars).
 * @param {string} workspaceDir
 * @param {string} prompt
 */
export async function persistJudgePrompt(workspaceDir, prompt) {
  const root = path.resolve(workspaceDir);
  const dir = path.join(root, ARTIFACTS_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(root, ARTIFACTS_JUDGE_PROMPT), prompt, "utf8");
}

/**
 * @param {string} workspaceDir
 */
export async function loadAgentArtifacts(workspaceDir) {
  try {
    const raw = await readFile(path.join(path.resolve(workspaceDir), ARTIFACTS_JSON), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
