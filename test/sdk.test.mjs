import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    "DEFAULT_MAX_STEPS",
    "DEFAULT_MAX_STOP_HOOK_LOOPS",
    "ToolRegistry",
    "OllamaClient",
    "OllamaClientError",
    "createAgent",
    "createOpenAIServer",
    "SessionStore",
    "CheckpointStore",
    "registerBuiltinTools",
    "registerProjectSearchTool",
    "registerRuleTool",
    "buildSystemPrompt",
    "buildEnvironmentContext",
    "buildGitSnapshot",
    "listRules",
    "listNestedAgentsFiles",
    "loadAppliedInstructions",
    "ensureProjectIndex",
    "searchProjectIndex",
    "compactMessages",
    "createOutputSpiller",
    "formatMcpToolIndex",
    "resolveModel",
    "isLikelyToolCapable",
    "isLikelyVisionCapable",
    "listClassifiedModels",
    "assertToolCapable",
    "assertVisionCapable",
    "messagesHaveImages",
    "ModelRoutingError",
    "DEFAULT_SYSTEM_PROMPT",
    "resolveThinkSetting",
    "configureClientModel",
    "modelPromptOverlay",
    "resolveAutoNumCtx",
    "checkContextWindow",
    "deriveMinimumContext",
    "MIN_NUM_CTX",
  ]) {
    assert.ok(name in sdk, `missing export: ${name}`);
  }
  // Removed loop machinery must not leak back into the public surface.
  for (const name of ["detectTaskHints", "buildProjectContext", "gatherFirstTurnProjectContext", "EscalationController"]) {
    assert.ok(!(name in sdk), `unexpected export: ${name}`);
  }
});

test("createAgent runs a goal end to end with builtin tools", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [{ function: { name: "echo", arguments: { text: "ping" } } }] },
    { role: "assistant", content: "echoed" },
  ]);
  const agent = await sdk.createAgent({ client, workspaceRoot: root, projectIndex: false });

  const result = await agent.run("echo ping");
  assert.equal(result.text, "echoed");
  assert.equal(result.steps[0].toolCalls[0].result, "ping");
  // The user's goal is sent as-is: no hints, plan requests, or wrappers.
  assert.equal(client.calls[0].messages[1].content, "echo ping");
});

test("createAgent injects a context-built system prompt", async () => {
  const client = new FakeClient([{ role: "assistant", content: "ok" }]);
  const agent = await sdk.createAgent({ client, workspaceRoot: root, projectIndex: false });

  await agent.run("hi");
  const system = client.calls[0].messages[0];
  assert.equal(system.role, "system");
  assert.match(system.content, /## Environment/);
  assert.ok(system.content.includes(path.resolve(root)));
});

test("createAgent exposes steer, queue, and hooks", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [{ function: { name: "echo", arguments: { text: "a" } } }] },
    { role: "assistant", content: "first" },
    { role: "assistant", content: "second" },
  ]);
  const blocked = [];
  const agent = await sdk.createAgent({
    client,
    workspaceRoot: root,
    projectIndex: false,
    hooks: {
      beforeToolCall: ({ name }) => {
        blocked.push(name);
      },
    },
  });
  agent.steer("keep it short");
  agent.queue("and now the second thing");

  const result = await agent.run("go");

  assert.deepEqual(blocked, ["echo"]);
  assert.equal(result.text, "second");
  assert.ok(result.steps.some((s) => s.kind === "steer"));
  assert.ok(client.calls[2].messages.some((m) => m.role === "user" && m.content === "and now the second thing"));
});

test("createAgent snapshots files before write_file when checkpoints are on", async () => {
  const target = path.join(root, "notes.txt");
  await writeFile(target, "before\n", "utf8");
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [{ function: { name: "write_file", arguments: { path: "notes.txt", content: "after\n" } } }] },
    { role: "assistant", content: "written" },
  ]);
  const agent = await sdk.createAgent({ client, workspaceRoot: root, projectIndex: false });

  const result = await agent.run("update notes.txt");

  assert.equal(result.steps[0].toolCalls[0].ok, true);
  assert.equal(await readFile(target, "utf8"), "after\n");
  assert.ok(agent.checkpoints instanceof sdk.CheckpointStore);
  const runs = await sdk.CheckpointStore.list(root);
  const mine = runs.find((r) => r.runId === agent.checkpoints.runId);
  assert.ok(mine, "checkpoint manifest written for this run");
  assert.deepEqual(mine.files.map((f) => f.path), ["notes.txt"]);

  await sdk.CheckpointStore.restore(root, agent.checkpoints.runId);
  assert.equal(await readFile(target, "utf8"), "before\n");
});

test("custom tools register alongside builtins and approval gating applies", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [{ function: { name: "deploy", arguments: {} } }] },
    { role: "assistant", content: "denied then reported" },
  ]);
  const agent = await sdk.createAgent({
    client,
    workspaceRoot: root,
    projectIndex: false,
    tools: [{ name: "deploy", requiresApproval: true, execute: () => "deployed" }],
    approvalHandler: () => false,
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
  });

  assert.deepEqual([...agent.registry.tools.keys()], ["only_tool"]);
  await agent.run("hi");
  assert.equal(client.calls[0].messages[0].content, "CUSTOM");
});
