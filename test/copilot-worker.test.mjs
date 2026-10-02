import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createCompletionGuard,
  createDelegationTracker,
  registerDelegateCopilotTool,
} from "../src/providers/copilot-worker.mjs";
import { ToolRegistry } from "../src/tool-registry.mjs";

test("delegate_copilot uses injected SDK and records tracker", async () => {
  const tracker = createDelegationTracker();
  const registry = new ToolRegistry();
  let stopped = false;

  registerDelegateCopilotTool(registry, {
    workspaceRoot: process.cwd(),
    tracker,
    loadSdk: async () => ({
      CopilotClient: class {
        async start() {}
        async stop() {
          stopped = true;
        }
        async createSession() {
          return {
            sessionId: "sess-1",
            async sendAndWait({ prompt }) {
              assert.match(prompt, /Task:/);
              assert.match(prompt, /paint the bikeshed/);
              return { data: { content: "painted" } };
            },
          };
        }
      },
      approveAll: () => ({ kind: "approved" }),
    }),
  });

  const outcome = await registry.execute("delegate_copilot", {
    task: "paint the bikeshed",
    acceptance: "shed is blue",
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.summary, "painted");
  assert.equal(tracker.calls.length, 1);
  assert.equal(stopped, true);
});

test("completion guard asks for delegation on implementation goals", async () => {
  const tracker = createDelegationTracker();
  const stop = createCompletionGuard({ tracker });
  const decision = await stop({
    goal: "fix the failing unit test",
    text: "Looks fine",
    steps: [],
    loopCount: 0,
  });
  assert.match(decision.followupMessage, /delegate_copilot/);
});

test("completion guard allows verified completion", async () => {
  const tracker = createDelegationTracker();
  tracker.calls.push({ task: "x", acceptance: "y" });
  const stop = createCompletionGuard({ tracker });
  const decision = await stop({
    goal: "fix it",
    text: "verified",
    steps: [
      {
        kind: "tool-calls",
        toolCalls: [{ name: "delegate_copilot" }],
      },
      {
        kind: "tool-calls",
        toolCalls: [{ name: "read_file" }],
      },
    ],
    loopCount: 0,
  });
  assert.deepEqual(decision, {});
});
