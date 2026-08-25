import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { ToolRegistry } from "../src/tool-registry.mjs";
import { globToRegExp, registerSearchTools } from "../src/tools/search.mjs";

let root;
let registry;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "halo-agent-search-"));
  await mkdir(path.join(root, "src", "deep"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });

  await writeFile(path.join(root, "src", "app.mjs"), "export function greetUser() {\n  return 'hello';\n}\n");
  await writeFile(path.join(root, "src", "deep", "util.mjs"), "// greetUser is called here\ngreetUser();\n");
  await writeFile(path.join(root, "notes.txt"), "nothing interesting\n");
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "greetUser(); // must never be found\n");
  await writeFile(path.join(root, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0x67, 0x72, 0x65, 0x65, 0x74]));

  registry = registerSearchTools(new ToolRegistry(), { workspaceRoot: root });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("globToRegExp: * stays in one segment, ** crosses, ? is one char", () => {
  assert.ok(globToRegExp("*.mjs").test("app.mjs"));
  assert.ok(!globToRegExp("*.mjs").test("src/app.mjs"));
  assert.ok(globToRegExp("src/**/*.mjs").test("src/deep/util.mjs"));
  assert.ok(globToRegExp("app.mj?").test("app.mjs"));
  assert.ok(!globToRegExp("app.mj?").test("app.mj"));
});

test("grep_search finds matches as path:line and skips node_modules and binary files", async () => {
  const { ok, result } = await registry.execute("grep_search", { pattern: "greetUser" });
  assert.ok(ok);
  assert.match(result, /src\/app\.mjs:1: export function greetUser/);
  assert.match(result, /src\/deep\/util\.mjs:1: \/\/ greetUser is called here/);
  assert.ok(!result.includes("node_modules"), "node_modules is pruned");
  assert.ok(!result.includes("binary.bin"), "binary files are skipped");
});

test("grep_search scopes by path and glob", async () => {
  const scoped = await registry.execute("grep_search", { pattern: "greetUser", path: "src/deep" });
  assert.ok(!scoped.result.includes("src/app.mjs"));
  assert.match(scoped.result, /util\.mjs/);

  const globbed = await registry.execute("grep_search", { pattern: ".", glob: "*.txt" });
  assert.match(globbed.result, /notes\.txt/);
  assert.ok(!globbed.result.includes(".mjs"));
});

test("grep_search reports no matches and rejects bad regexes gracefully", async () => {
  const none = await registry.execute("grep_search", { pattern: "zzz_not_here" });
  assert.ok(none.ok);
  assert.match(none.result, /No matches/);

  const bad = await registry.execute("grep_search", { pattern: "(" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Invalid regular expression/);
});

test("grep_search caps results at max_results and says so", async () => {
  const capped = await registry.execute("grep_search", { pattern: ".", max_results: 2 });
  assert.ok(capped.ok);
  assert.match(capped.result, /stopped at 2 matches/);
});

test("grep_search rejects paths outside the workspace", async () => {
  const outcome = await registry.execute("grep_search", { pattern: "x", path: "../.." });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /outside the workspace/);
});

test("find_files matches basenames anywhere without '/', whole paths with '/'", async () => {
  const byName = await registry.execute("find_files", { pattern: "*.mjs" });
  assert.match(byName.result, /src\/app\.mjs/);
  assert.match(byName.result, /src\/deep\/util\.mjs/);
  assert.ok(!byName.result.includes("node_modules"));

  const byPath = await registry.execute("find_files", { pattern: "src/deep/*.mjs" });
  assert.match(byPath.result, /src\/deep\/util\.mjs/);
  assert.ok(!byPath.result.includes("src/app.mjs"));
});

test("find_files reports when nothing matches", async () => {
  const outcome = await registry.execute("find_files", { pattern: "*.rs" });
  assert.ok(outcome.ok);
  assert.match(outcome.result, /No files matching/);
});

test("grep_search falls back when glob matches zero files", async () => {
  const noneGlob = await registry.execute("grep_search", { pattern: "greetUser", glob: "*.py" });
  assert.ok(noneGlob.ok);
  assert.match(noneGlob.result, /glob '\*\.py' matched 0/);
  assert.match(noneGlob.result, /searched all files instead/);
  assert.match(noneGlob.result, /src\/app\.mjs/);
});
