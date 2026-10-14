import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BUILTIN_CONTEXT_GUIDANCE, composeSystemPrompt, DEFAULT_SYSTEM_PROMPT } from "../src/agent-loop.mjs";
import { ToolRegistry } from "../src/tool-registry.mjs";
import { registerBuiltinTools } from "../src/tools/builtin.mjs";
import {
  HALO_SCAN_CONTEXT_GUIDANCE,
  HALO_SCAN_PROMPT_OVERLAY,
  HALO_SCAN_SUPERSEDES,
  importHaloScan,
  registerHaloScanTools,
  wrapHaloScanTool,
} from "../src/tools/halo-scan.mjs";

/** Minimal stand-in for @bitfieldcreek/halo-scan's managed toolset. */
function fakeHaloScanModule({ initial, extra = [], profile = "auto" }) {
  const registry = {
    onChange: null,
    tools: [...initial],
    list() {
      return [...this.tools];
    },
    add(tool) {
      this.tools.push(tool);
      this.onChange?.();
    },
  };
  return {
    registry,
    module: {
      async createManagedToolset() {
        return { registry, catalog: new Map(), profile, listChanged: profile !== "full" };
      },
      TOOL_ALIASES: {
        tree: { target: "dir_digest" },
        search: { target: "grep_search", args: (a) => ({ ...a, pattern: a.pattern ?? a.query }) },
      },
    },
    extra,
  };
}

test("registerHaloScanTools returns null when Halo Scan is unavailable", async () => {
  const registry = registerBuiltinTools(new ToolRegistry(), { workspaceRoot: process.cwd() });
  const before = registry.names();
  const info = await registerHaloScanTools(registry, { workspaceRoot: process.cwd(), module: {} });
  assert.equal(info, null);
  assert.deepEqual(registry.names(), before);
});

test("Halo Scan tools replace same-named builtins and add the rest; aliases are installed", async () => {
  const registry = registerBuiltinTools(new ToolRegistry(), { workspaceRoot: process.cwd() });
  const calls = [];
  const { module } = fakeHaloScanModule({
    initial: [
      {
        name: "read_file",
        description: "richer read",
        inputSchema: { type: "object", properties: { path: { type: "string" }, paths: { type: "array" } } },
        execute: (args) => (calls.push(["read_file", args]), "contents"),
      },
      {
        name: "repo_overview",
        description: "overview",
        inputSchema: { type: "object", properties: {} },
        execute: () => "# overview",
      },
      {
        name: "dir_digest",
        inputSchema: { type: "object", properties: {} },
        execute: () => "tree",
      },
    ],
  });

  const info = await registerHaloScanTools(registry, { workspaceRoot: process.cwd(), module });
  assert.deepEqual(info.replaced, ["read_file"]);
  assert.deepEqual(info.added, ["repo_overview", "dir_digest"]);
  assert.deepEqual(info.names, ["read_file", "repo_overview", "dir_digest"]);
  assert.equal(info.profile, "auto");
  assert.equal(info.aliasCount, 2);

  // Replaced under the same name: one read_file, with Halo Scan's schema.
  const schema = registry.schemas().find((s) => s.function.name === "read_file");
  assert.equal(schema.function.description, "richer read");
  assert.ok(schema.function.parameters.properties.paths);
  assert.equal(registry.names().filter((n) => n === "read_file").length, 1);

  // Builtins Halo Scan does not cover stay put.
  for (const name of ["write_file", "edit_file", "run_command", "fetch_rule", "web_search"]) {
    assert.ok(registry.has(name), `${name} should remain`);
  }

  // Legacy line_start/line_end spellings are normalized for the embedded read_file.
  const out = await registry.execute("read_file", { path: "a", line_start: 3, line_end: 7 });
  assert.equal(out.result, "contents");
  assert.deepEqual(calls[0][1], { path: "a", offset: 3, limit: 5 });

  // Halo Scan's alias table is merged into the registry.
  const tree = await registry.execute("tree", {});
  assert.equal(tree.ok, true);
  assert.equal(tree.resolvedName, "dir_digest");
});

test("tools activated later via activate_pack are mirrored into the registry", async () => {
  const registry = new ToolRegistry();
  const { module, registry: scanRegistry } = fakeHaloScanModule({
    initial: [{ name: "repo_overview", inputSchema: { type: "object", properties: {} }, execute: () => "o" }],
  });
  await registerHaloScanTools(registry, { workspaceRoot: process.cwd(), module });
  assert.ok(!registry.has("symbol_context"));

  scanRegistry.add({ name: "symbol_context", inputSchema: { type: "object", properties: {} }, execute: () => "ctx" });
  assert.ok(registry.has("symbol_context"));
  assert.equal((await registry.execute("symbol_context", {})).result, "ctx");
});

test("wrapped list_dir hides the agent data directory; long string output is spilled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bf-agent-halo-scan-"));
  try {
    const spilled = [];
    const spill = async (text, label) => (spilled.push(label), text.length > 10 ? "[spilled]" : text);

    const listDir = wrapHaloScanTool(
      { name: "list_dir", execute: () => ({ path: ".", entries: [".bf/", ".halo-agent/", "src/", "README.md"] }) },
      { spill },
    );
    assert.deepEqual(await listDir.execute({}), { path: ".", entries: ["src/", "README.md"] });

    const big = wrapHaloScanTool({ name: "grep_search", execute: () => "x".repeat(50) }, { spill });
    assert.equal(await big.execute({ pattern: "x" }), "[spilled]");
    assert.deepEqual(spilled, ["grep_search"]);

    const obj = wrapHaloScanTool({ name: "thing", execute: () => ({ a: 1 }) }, { spill });
    assert.deepEqual(await obj.execute({}), { a: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context guidance replaces the builtin bullet in the core prompt", () => {
  for (const name of ["repo_overview", "project_conventions", "file_outline", "get_symbol", "symbol_context"]) {
    assert.ok(HALO_SCAN_CONTEXT_GUIDANCE.includes(name), `guidance should mention ${name}`);
  }
  assert.equal(HALO_SCAN_PROMPT_OVERLAY, HALO_SCAN_CONTEXT_GUIDANCE);
  assert.deepEqual([...HALO_SCAN_SUPERSEDES].sort(), ["find_files", "grep_search", "list_dir", "read_file"]);

  const withScan = composeSystemPrompt({ contextGuidance: HALO_SCAN_CONTEXT_GUIDANCE });
  assert.ok(withScan.includes("symbol_context"));
  assert.ok(!withScan.includes(BUILTIN_CONTEXT_GUIDANCE), "builtin grep/read/list bullet must be replaced, not kept");
  assert.ok(withScan.includes("Read a file before editing it"), "rest of the core prompt is intact");
  assert.ok(DEFAULT_SYSTEM_PROMPT.includes(BUILTIN_CONTEXT_GUIDANCE));
  assert.ok(!DEFAULT_SYSTEM_PROMPT.includes("symbol_context"));
});

test("real Halo Scan (sibling checkout or package) embeds end to end", async (t) => {
  const mod = await importHaloScan();
  if (!mod) {
    t.skip("@bitfieldcreek/halo-scan not available");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "bf-agent-halo-scan-real-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, ".bf", "bf-agent"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node --test" } }));
    await writeFile(path.join(root, "src", "a.mjs"), "export function alpha() {\n  return 1;\n}\nexport function beta() {\n  return alpha() + 1;\n}\n");

    const registry = registerBuiltinTools(new ToolRegistry(), { workspaceRoot: root });
    const info = await registerHaloScanTools(registry, { workspaceRoot: root, profile: "base" });
    assert.ok(info, "expected Halo Scan to embed");
    for (const name of HALO_SCAN_SUPERSEDES) assert.ok(info.replaced.includes(name), `${name} should be replaced`);
    assert.ok(registry.has("repo_overview"));
    assert.ok(registry.has("get_symbol"));
    assert.ok(registry.has("activate_pack"), "non-full profile exposes activate_pack");

    const sym = await registry.execute("get_symbol", { path: "src/a.mjs", name: "beta" });
    assert.equal(sym.ok, true, sym.error);
    assert.match(String(sym.result), /alpha\(\) \+ 1/);

    const ls = await registry.execute("list_dir", {});
    assert.ok(!ls.result.entries.some((e) => e.startsWith(".bf")), "data dir hidden");

    const many = await registry.execute("read_file", { paths: ["package.json", "src/a.mjs"] });
    assert.equal(many.ok, true, many.error);
    assert.match(String(many.result), /## package.json/);

    // A hallucinated name from Halo Scan's alias table resolves against the embedded tool.
    const alias = await registry.execute("open_file", { path: "src/a.mjs", start_line: 1, end_line: 2 });
    assert.equal(alias.ok, true, alias.error);
    assert.equal(alias.resolvedName, "read_file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
