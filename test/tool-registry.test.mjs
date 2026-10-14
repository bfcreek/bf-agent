import assert from "node:assert/strict";
import { test } from "node:test";

import { ToolRegistry, parseAutoApproveSpec, suggestSimilarTools } from "../src/tool-registry.mjs";
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

test("auto-approve skips the handler for named tools and still gates the rest", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "write_file", requiresApproval: true, execute: () => "wrote" });
  registry.register({ name: "run_command", requiresApproval: true, execute: () => "ran" });
  registry.setAutoApprove(["write_file"]);
  const seen = [];
  registry.setApprovalHandler((request) => {
    seen.push(request.name);
    return false;
  });

  const write = await registry.execute("write_file", { path: "a.txt" });
  assert.deepEqual(write, { ok: true, result: "wrote" });
  const shell = await registry.execute("run_command", { command: "echo hi" });
  assert.equal(shell.ok, false);
  assert.match(shell.error, /declined/);
  assert.deepEqual(seen, ["run_command"]);
  assert.equal(registry.callApproved, false);
});

test("parseAutoApproveSpec accepts all, off, and tool lists", () => {
  assert.deepEqual(parseAutoApproveSpec("all"), { ok: true, policy: "all" });
  assert.deepEqual(parseAutoApproveSpec(true), { ok: true, policy: "all" });
  assert.deepEqual(parseAutoApproveSpec("off"), { ok: true, policy: "off" });
  assert.deepEqual(parseAutoApproveSpec("write_file, run_command"), {
    ok: true,
    policy: ["write_file", "run_command"],
  });
  assert.equal(parseAutoApproveSpec("write file").ok, false);
  assert.match(parseAutoApproveSpec("write file").error, /write file/);
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

test("aliases resolve hallucinated names onto registered tools and rewrite arguments", async () => {
  const registry = new ToolRegistry();
  const seen = [];
  registry.register({ name: "grep_search", execute: (args) => (seen.push(args), "hits") });
  registry.register({ name: "read_file", execute: (args) => (seen.push(args), "text") });

  const grep = await registry.execute("search", { query: "foo", path: "src" });
  assert.equal(grep.ok, true);
  assert.equal(grep.result, "hits");
  assert.equal(grep.resolvedName, "grep_search");
  assert.deepEqual(seen[0], { pattern: "foo", path: "src" });

  const read = await registry.execute("open_file", JSON.stringify({ file: "a.txt", line_start: 10, line_end: 14 }));
  assert.equal(read.ok, true);
  assert.equal(read.resolvedName, "read_file");
  assert.deepEqual(seen[1], { path: "a.txt", offset: 10, limit: 5 });

  // Direct calls carry no resolvedName.
  const direct = await registry.execute("read_file", { path: "b.txt" });
  assert.equal(direct.resolvedName, undefined);

  // Aliases are never advertised.
  assert.deepEqual(registry.schemas().map((s) => s.function.name), ["grep_search", "read_file"]);
});

test("an alias whose target is missing stays an unknown tool", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "echo", execute: ({ text }) => text });
  const outcome = await registry.execute("open_file", { path: "x" });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /Unknown tool 'open_file'/);
});

test("aliased gated tools are approved under the target name", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "run_command", requiresApproval: true, execute: ({ command }) => `ran ${command}` });
  registry.setAutoApprove(["run_command"]);
  const outcome = await registry.execute("bash", { cmd: "ls" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result, "ran ls");

  const asked = [];
  registry.setAutoApprove("off");
  registry.setApprovalHandler(({ name }) => (asked.push(name), false));
  const declined = await registry.execute("shell", { command: "rm x" });
  assert.equal(declined.ok, false);
  assert.deepEqual(asked, ["run_command"]);
});

test("registerAliases adds custom aliases; replace and unregister manage tools", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "read_file", execute: () => "builtin" });
  registry.registerAliases({ slurp: { target: "read_file" } });
  assert.equal((await registry.execute("slurp", {})).result, "builtin");

  assert.equal(registry.replace({ name: "read_file", execute: () => "richer" }), true);
  assert.equal((await registry.execute("read_file", {})).result, "richer");
  assert.equal(registry.replace({ name: "new_tool", execute: () => 1 }), false);
  assert.deepEqual(registry.names(), ["read_file", "new_tool"]);

  assert.equal(registry.unregister("new_tool"), true);
  assert.equal(registry.unregister("new_tool"), false);
  assert.ok(!registry.has("new_tool"));
});
