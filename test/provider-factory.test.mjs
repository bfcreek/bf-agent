import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentLoop } from "../src/agent-loop.mjs";
import { ProviderClientError } from "../src/provider-client.mjs";
import {
  createProviderClient,
  shouldRouteOllamaModel,
} from "../src/providers/factory.mjs";
import {
  createCompletionGuard,
  createDelegationTracker,
} from "../src/providers/copilot-worker.mjs";
import { ToolRegistry } from "../src/tool-registry.mjs";

test("createProviderClient defaults to OllamaClient", async () => {
  const setup = await createProviderClient({ model: "llama3.2" });
  assert.equal(setup.provider, "ollama");
  assert.equal(setup.kind, "llm");
  assert.equal(typeof setup.client.chat, "function");
  assert.equal(setup.client.capabilities.messageDialect, "ollama");
  assert.equal(shouldRouteOllamaModel(setup), true);
});

test("createProviderClient rejects unknown providers", async () => {
  await assert.rejects(
    () => createProviderClient({ provider: "nope" }),
    (err) => err instanceof ProviderClientError && /Unknown provider/.test(err.message),
  );
});

test("openai provider fails clearly when peer SDK is missing", async () => {
  await assert.rejects(
    () => createProviderClient({ provider: "openai", model: "gpt-5" }),
    (err) =>
      err instanceof ProviderClientError &&
      (/optional peer package 'openai'/.test(err.message) || /API key/.test(err.message)),
  );
});

test("copilot nested mode returns supervisor client and applyNested", async () => {
  const setup = await createProviderClient({
    provider: "copilot",
    supervisorProvider: "ollama",
    supervisorModel: "llama3.2",
  });
  assert.equal(setup.kind, "nested");
  assert.equal(setup.provider, "copilot");
  assert.equal(setup.supervisorProvider, "ollama");
  assert.equal(typeof setup.applyNested, "function");

  const registry = new ToolRegistry();
  const { hooks, systemOverlay } = setup.applyNested({
    registry,
    workspaceRoot: process.cwd(),
  });
  assert.ok(registry.has("delegate_copilot"));
  assert.equal(typeof hooks.stop, "function");
  assert.match(systemOverlay, /delegate_copilot/);
});

test("completion guard nudges unverified copilot completion", async () => {
  const tracker = createDelegationTracker();
  tracker.calls.push({ task: "edit file", acceptance: "tests pass" });
  const stop = createCompletionGuard({ tracker });
  const decision = await stop({
    goal: "fix the bug",
    text: "All done!",
    steps: [
      {
        kind: "tool-calls",
        toolCalls: [{ name: "delegate_copilot" }],
      },
      { kind: "final", toolCalls: [] },
    ],
    loopCount: 0,
  });
  assert.match(decision.followupMessage, /without verifying/i);
});

test("AgentLoop retries ProviderClientError transients", async () => {
  let calls = 0;
  const client = {
    async chat() {
      calls += 1;
      if (calls < 2) {
        throw new ProviderClientError("boom", { status: 503 });
      }
      return { message: { role: "assistant", content: "ok" }, raw: {} };
    },
  };
  const registry = new ToolRegistry();
  const loop = new AgentLoop({ client, registry });
  const result = await loop.run("hi");
  assert.equal(result.text, "ok");
  assert.equal(calls, 2);
});
