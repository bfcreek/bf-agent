import assert from "node:assert/strict";
import { test } from "node:test";

import { ToolRegistry, suggestSimilarTools } from "../src/tool-registry.mjs";
import { registerBuiltinTools } from "../src/tools/builtin.mjs";

test("schemas render in OpenAI function shape", () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "ping",
    description: "Ping.",
    parameters: { type: "object", properties: {} },
    execute: () => "pong",
  });

  const schemas = registry.schemas();
  assert.equal(schemas.length, 1);
  assert.deepEqual(schemas[0], {
    type: "function",
    function: {
      name: "ping",
      description: "Ping.",
      parameters: { type: "object", properties: {} },
    },
  });
});

test("duplicate registration is rejected", () => {
  const registry = new ToolRegistry();
  const tool = { name: "x", execute: () => 1 };
  registry.register(tool);
  assert.throws(() => registry.register(tool), /already registered/);
});

test("execute returns ok result", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "one", execute: () => 1 });
  assert.deepEqual(await registry.execute("one", {}), { ok: true, result: 1 });
});

test("execute wraps thrown errors instead of throwing", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "bad",
    execute: () => {
      throw new Error("nope");
    },
  });
  const outcome = await registry.execute("bad", {});
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /nope/);
});

test("invalid JSON string arguments fail gracefully", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "one", execute: () => 1 });
  const outcome = await registry.execute("one", "{not json");
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /not valid JSON/);
});

test("write_file invalid JSON hints at escaped content", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "write_file", execute: () => ({ ok: true }) });
  const outcome = await registry.execute("write_file", '{"path":"a.txt","content": unclosed');
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /not valid JSON/);
  assert.match(outcome.error, /path\/content|old_string\/new_string/i);
});

test("gated tool is blocked when the approval handler denies", async () => {
  const registry = new ToolRegistry();
  let executed = false;
  registry.register({
    name: "danger",
    requiresApproval: true,
    execute: () => {
      executed = true;
      return "done";
    },
  });
  registry.setApprovalHandler(() => false);

  const outcome = await registry.execute("danger", {});
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /declined/);
  assert.equal(executed, false);
});

test("gated tool runs when the approval handler allows", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "danger", requiresApproval: true, execute: () => "done" });
  const seen = [];
  registry.setApprovalHandler((request) => {
    seen.push(request);
    return true;
  });

  const outcome = await registry.execute("danger", { path: "a.txt" });
  assert.deepEqual(outcome, { ok: true, result: "done" });
  assert.deepEqual(seen, [{ name: "danger", args: { path: "a.txt" } }]);
});

test("gated tool runs freely when no approval handler is set", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "danger", requiresApproval: true, execute: () => "done" });
  const outcome = await registry.execute("danger", {});
  assert.equal(outcome.ok, true);
});

test("approval handler errors are reported, not thrown", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "danger", requiresApproval: true, execute: () => "done" });
  registry.setApprovalHandler(() => {
    throw new Error("prompt unavailable");
  });
  const outcome = await registry.execute("danger", {});
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /Approval check failed: prompt unavailable/);
});

test("ungated tools never consult the approval handler", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "safe", execute: () => "ok" });
  let consulted = false;
  registry.setApprovalHandler(() => {
    consulted = true;
    return false;
  });
  const outcome = await registry.execute("safe", {});
  assert.equal(outcome.ok, true);
  assert.equal(consulted, false);
});

test("write_file, edit_file, and run_command are approval-gated builtins", async () => {
  const registry = registerBuiltinTools(new ToolRegistry());
  for (const name of ["write_file", "edit_file", "run_command"]) {
    assert.equal(registry.tools.get(name).requiresApproval, true, `${name} should be gated`);
  }
  for (const name of ["read_file", "list_dir", "get_time", "echo"]) {
    assert.ok(!registry.tools.get(name).requiresApproval, `${name} should not be gated`);
  }
});

test("builtin tools register and run", async () => {
  const registry = registerBuiltinTools(new ToolRegistry());
  assert.ok(registry.has("get_time"));
  assert.ok(registry.has("echo"));

  const echo = await registry.execute("echo", { text: "hello" });
  assert.deepEqual(echo, { ok: true, result: "hello" });

  const time = await registry.execute("get_time", {});
  assert.equal(time.ok, true);
  assert.match(time.result.iso, /^\d{4}-\d{2}-\d{2}T/);
});

test("unknown tool error suggests similar names for common typos", async () => {
  const registry = registerBuiltinTools(new ToolRegistry());
  const outcome = await registry.execute("search_search", { pattern: "foo" });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /Unknown tool 'search_search'/);
  assert.match(outcome.error, /grep_search|search_project|web_search/);
  assert.ok(suggestSimilarTools("search_search", ["grep_search", "read_file"]).includes("grep_search"));
});
