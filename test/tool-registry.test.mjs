import assert from "node:assert/strict";
import { test } from "node:test";

import { ToolRegistry } from "../src/tool-registry.mjs";
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
