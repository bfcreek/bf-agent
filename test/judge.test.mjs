import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { agentResultFromTrial, inferAgentStopReason } from "../evals/recognized/judge.mjs";

test("inferAgentStopReason marks empty crash sessions as error", () => {
  assert.equal(
    inferAgentStopReason({ steps: [], messages: [], stopReason: "completed" }, {
      stdout: "NonZeroAgentExitCodeError: agent exited with code 3",
    }),
    "error",
  );
  assert.equal(
    inferAgentStopReason({ steps: [], error: "error parsing tool call" }),
    "error",
  );
  assert.equal(
    inferAgentStopReason({ steps: [{ index: 1 }], stopReason: "completed" }),
    "completed",
  );
  assert.equal(
    inferAgentStopReason(null, { stdout: "" }),
    "error",
    "a missing session is a killed/crashed agent, never a completed run",
  );
  assert.equal(
    inferAgentStopReason(null, { stdout: "AgentTimeoutError: agent timed out" }),
    "timeout",
  );
});

test("agentResultFromTrial falls back to the live-flushed session in the /app artifact after a kill", async () => {
  const trialDir = await mkdtemp(path.join(os.tmpdir(), "halo-trial-"));
  try {
    // Harbor killed the agent: /logs/agent/session.json was never copied, but
    // the artifact collection picked up the mid-run flush.
    const sessions = path.join(trialDir, "artifacts", "app", ".halo-agent", "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      path.join(sessions, "harbor.json"),
      JSON.stringify({
        stopReason: "running",
        escalationCount: 2,
        cloudUsed: true,
        steps: [
          { index: 0, kind: "plan", content: "1. build", toolCalls: [] },
          { index: 3, kind: "escalation", content: "Escalated model a → b", toolCalls: [] },
          { index: 3, kind: "tool-calls", content: "", toolCalls: [{ name: "run_command" }] },
        ],
        messages: [],
      }),
    );
    await mkdir(path.join(trialDir, "agent"), { recursive: true });
    await writeFile(
      path.join(trialDir, "agent", "stdout.txt"),
      "AgentTimeoutError: Agent execution timed out after 900.0 seconds",
    );

    const result = await agentResultFromTrial(trialDir);
    assert.equal(result.steps.length, 3, "steps come from the artifact session, not 0");
    assert.equal(result.escalationCount, 2);
    assert.equal(result.cloudUsed, true);
    assert.equal(result.stopReason, "running");
  } finally {
    await rm(trialDir, { recursive: true, force: true });
  }
});

test("agentResultFromTrial with no session at all still reports a killed agent", async () => {
  const trialDir = await mkdtemp(path.join(os.tmpdir(), "halo-trial-"));
  try {
    const result = await agentResultFromTrial(trialDir);
    assert.equal(result.steps.length, 0);
    assert.equal(result.stopReason, "error");
    assert.equal(result.escalationCount, 0);
  } finally {
    await rm(trialDir, { recursive: true, force: true });
  }
});
