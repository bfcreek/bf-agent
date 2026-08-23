import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { McpClient, registerMcpTools } from "../src/mcp-client.mjs";
import { ToolRegistry } from "../src/tool-registry.mjs";

/**
 * A minimal MCP server: newline-delimited JSON-RPC over stdio with an `add`
 * tool and a `boom` tool that reports isError.
 */
const FAKE_SERVER = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    reply(msg.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-server", version: "1.0.0" },
    });
  } else if (msg.method === "tools/list") {
    reply(msg.id, {
      tools: [
        {
          name: "add",
          description: "Add two numbers.",
          inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
        },
        { name: "boom", description: "Always fails." },
      ],
    });
  } else if (msg.method === "tools/call") {
    if (msg.params.name === "add") {
      const { a, b } = msg.params.arguments;
      reply(msg.id, { content: [{ type: "text", text: String(a + b) }] });
    } else {
      reply(msg.id, { content: [{ type: "text", text: "kaboom" }], isError: true });
    }
  } else if (msg.id !== undefined) {
    reply(msg.id, {});
  }
});
`;

let dir;
let serverPath;
let client;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "halo-agent-mcp-"));
  serverPath = path.join(dir, "fake-mcp-server.cjs");
  await writeFile(serverPath, FAKE_SERVER, "utf8");
  client = await McpClient.connect({ command: `node "${serverPath}"` });
});

after(async () => {
  await client?.close();
  await rm(dir, { recursive: true, force: true });
});

test("connect completes the initialize handshake", () => {
  assert.equal(client.serverInfo?.name, "fake-server");
});

test("listTools returns the server's tool definitions", async () => {
  const tools = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["add", "boom"],
  );
  assert.equal(tools[0].inputSchema.required[0], "a");
});

test("callTool flattens text content", async () => {
  assert.equal(await client.callTool("add", { a: 20, b: 22 }), "42");
});

test("isError results throw so the registry can report them", async () => {
  await assert.rejects(() => client.callTool("boom", {}), /kaboom/);
});

test("registerMcpTools bridges tools into the registry with a prefix", async () => {
  const registry = new ToolRegistry();
  const names = await registerMcpTools(registry, client);
  assert.deepEqual(names, ["mcp_add", "mcp_boom"]);

  const schema = registry.schemas().find((s) => s.function.name === "mcp_add");
  assert.equal(schema.function.description, "Add two numbers.");
  assert.deepEqual(schema.function.parameters.required, ["a", "b"]);

  const ok = await registry.execute("mcp_add", { a: 1, b: 2 });
  assert.deepEqual(ok, { ok: true, result: "3" });

  const failed = await registry.execute("mcp_boom", {});
  assert.equal(failed.ok, false);
  assert.match(failed.error, /kaboom/);
});

test("requests reject cleanly when the server dies", async () => {
  const dying = await McpClient.connect({ command: `node "${serverPath}"` });
  await dying.close();
  await assert.rejects(() => dying.request("tools/list", {}), /closed|exited/);
});
