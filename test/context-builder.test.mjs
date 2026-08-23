import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { buildEnvironmentContext, buildSystemPrompt } from "../src/context-builder.mjs";
import { truncateMiddle } from "../src/tools/fs.mjs";

let root;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "halo-agent-ctx-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "README.md"), "# demo", "utf8");
  await writeFile(path.join(root, "index.mjs"), "//", "utf8");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("environment context names the workspace root, platform, and shell", async () => {
  const context = await buildEnvironmentContext({ workspaceRoot: root });
  assert.ok(context.includes(path.resolve(root)), "workspace root path present");
  assert.ok(context.includes(process.platform), "platform present");
  assert.match(context, /run_command uses (PowerShell|\/bin\/sh)/);
  assert.ok(context.includes(process.version), "node version present");
});

test("environment context lists top-level entries with dirs marked", async () => {
  const context = await buildEnvironmentContext({ workspaceRoot: root });
  assert.match(context, /- README\.md/);
  assert.match(context, /- index\.mjs/);
  assert.match(context, /- src\//);
});

test("listing is capped at maxEntries with a pointer to list_dir", async () => {
  const context = await buildEnvironmentContext({ workspaceRoot: root, maxEntries: 1 });
  assert.match(context, /2 more entries — use list_dir/);
});

test("an unreadable workspace degrades to a note instead of throwing", async () => {
  const context = await buildEnvironmentContext({
    workspaceRoot: path.join(root, "does-not-exist"),
  });
  assert.match(context, /could not list workspace/);
});

test("buildSystemPrompt prepends the base prompt", async () => {
  const prompt = await buildSystemPrompt({ basePrompt: "BASE RULES", workspaceRoot: root });
  assert.ok(prompt.startsWith("BASE RULES\n\n"));
  assert.match(prompt, /## Environment/);
});

test("buildSystemPrompt appends project context when provided", async () => {
  const prompt = await buildSystemPrompt({
    basePrompt: "BASE",
    workspaceRoot: root,
    projectContext: "## Project context\n\noverview",
  });
  assert.match(prompt, /## Project context/);
  assert.match(prompt, /overview/);
});

test("truncateMiddle keeps the head and tail of long output", () => {
  const text = `START${"x".repeat(5000)}END`;
  const out = truncateMiddle(text, 100);
  assert.ok(out.startsWith("START"));
  assert.ok(out.endsWith("END"));
  assert.match(out, /\[\.\.\. \d+ characters omitted \.\.\.\]/);
  assert.ok(out.length < 200);
});

test("truncateMiddle leaves short output alone", () => {
  assert.equal(truncateMiddle("short", 100), "short");
});
