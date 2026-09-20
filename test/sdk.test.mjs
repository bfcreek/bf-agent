import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import * as sdk from "../src/index.mjs";

class FakeClient {
  constructor(script) {
    this.script = [...script];
    this.calls = [];
  }

  async chat(request) {
    this.calls.push(structuredClone(request));
    const message = this.script.shift();
    if (!message) throw new Error("FakeClient script exhausted.");
    return { message, raw: { message } };
  }
}

let root;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "halo-agent-sdk-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("the SDK exports the full public surface", () => {
  for (const name of [
    "AgentLoop",
    "ToolRegistry",
    "OllamaClient",
    "OllamaClientError",
    "createAgent",
    "createOpenAIServer",
    "SessionStore",
    "registerBuiltinTools",
    "registerProjectSearchTool",
    "buildSystemPrompt",
    "buildEnvironmentContext",
    "loadAppliedInstructions",
    "buildProjectContext",
    "gatherFirstTurnProjectContext",
    "ensureProjectIndex",
    "searchProjectIndex",
    "compactMessages",
    "resolveModel",
    "isLikelyToolCapable",
    "isLikelyVisionCapable",
    "listClassifiedModels",
    "assertToolCapable",
    "assertVisionCapable",
    "messagesHaveImages",
    "ModelRoutingError",
    "DEFAULT_SYSTEM_PROMPT",
    "detectTaskHints",
    "resolveThinkSetting",
    "configureClientModel",
  ]) {
    assert.ok(name in sdk, `missing export: ${name}`);
  }
});

test("createAgent runs a goal end to end with builtin tools", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [{ function: { name: "echo", arguments: { text: "ping" } } }] },
    { role: "assistant", content: "echoed" },
  ]);
  const agent = await sdk.createAgent({
    client,
    workspaceRoot: root,
    projectIndex: false,
    projectBootstrap: false,
    planning: false,
  });

  const result = await agent.run("echo ping");
  assert.equal(result.text, "echoed");
  assert.equal(result.steps[0].toolCalls[0].result, "ping");
});

test("createAgent injects a context-built system prompt", async () => {
  const client = new FakeClient([{ role: "assistant", content: "ok" }]);
  const agent = await sdk.createAgent({
    client,
    workspaceRoot: root,
    projectIndex: false,
    projectBootstrap: false,
    planning: false,
  });

  await agent.run("hi");
  const system = client.calls[0].messages[0];
  assert.equal(system.role, "system");
  assert.match(system.content, /## Environment/);
  assert.ok(system.content.includes(path.resolve(root)));
});

test("custom tools register alongside builtins and approval gating applies", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [{ function: { name: "deploy", arguments: {} } }] },
    { role: "assistant", content: "denied then reported" },
  ]);
  const agent = await sdk.createAgent({
    client,
    workspaceRoot: root,
    tools: [{ name: "deploy", requiresApproval: true, execute: () => "deployed" }],
    approvalHandler: () => false,
    planning: false,
  });

  const result = await agent.run("deploy it");
  assert.equal(result.steps[0].toolCalls[0].ok, false);
  assert.match(result.steps[0].toolCalls[0].error, /declined/);
});

test("builtinTools:false yields a custom-tools-only agent", async () => {
  const client = new FakeClient([{ role: "assistant", content: "ok" }]);
  const agent = await sdk.createAgent({
    client,
    workspaceRoot: root,
    builtinTools: false,
    tools: [{ name: "only_tool", execute: () => 1 }],
    systemPrompt: "CUSTOM",
    planning: false,
  });

  assert.deepEqual([...agent.registry.tools.keys()], ["only_tool"]);
  await agent.run("hi");
  assert.equal(client.calls[0].messages[0].content, "CUSTOM");
});
