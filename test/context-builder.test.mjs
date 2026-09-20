import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  buildEnvironmentContext,
  buildGitSnapshot,
  buildSystemPrompt,
  listNestedAgentsFiles,
  listRules,
  loadAppliedInstructions,
  parseRuleFrontmatter,
  shouldAlwaysApplyRule,
} from "../src/context-builder.mjs";
import { truncateMiddle } from "../src/tools/output.mjs";

const execFileAsync = promisify(execFile);

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
  assert.match(context, /file tool paths are relative/);
  assert.match(context, /Do not prefix paths with the workspace folder name/);
  assert.ok(context.includes(process.platform), "platform present");
  assert.match(context, /run_command uses (PowerShell|\/bin\/sh)/);
  assert.ok(context.includes(process.version), "node version present");
  assert.match(context, /Local date:/);
  if (process.platform === "win32") {
    assert.match(context, /\.ps1/);
    assert.match(context, /Chain commands with ';'/);
  }
  // Task-specific guidance lives in rules, not the environment block.
  assert.doesNotMatch(context, /acceptance|apt-get|merge CONFLICT/i);
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

test("buildGitSnapshot reports branch and short status like Cursor's git_status block", async () => {
  const outputs = { "symbolic-ref": "feature/x\n", status: " M src/a.mjs\n?? new.txt\n" };
  const exec = async (_cmd, args) => ({ stdout: outputs[args[0]] });
  const snapshot = await buildGitSnapshot(root, { exec });
  assert.match(snapshot, /^## Git/);
  assert.match(snapshot, /- Branch: feature\/x/);
  assert.match(snapshot, /Status \(2 changes\)/);
  assert.match(snapshot, / M src\/a\.mjs/);

  const clean = await buildGitSnapshot(root, { exec: async (_c, args) => ({ stdout: args[0] === "status" ? "" : "main" }) });
  assert.match(clean, /Working tree clean/);

  // Detached HEAD: symbolic-ref fails, rev-parse answers.
  const detached = await buildGitSnapshot(root, {
    exec: async (_c, args) => {
      if (args[0] === "symbolic-ref") throw new Error("not a symbolic ref");
      return { stdout: args[0] === "status" ? "" : "HEAD" };
    },
  });
  assert.match(detached, /- Branch: HEAD/);

  const notRepo = await buildGitSnapshot(root, {
    exec: async () => {
      throw new Error("not a git repository");
    },
  });
  assert.equal(notRepo, "");
});

test("environment context includes the git snapshot when .git is present", async () => {
  const gitRoot = await mkdtemp(path.join(os.tmpdir(), "halo-agent-ctx-git-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: gitRoot });
    const context = await buildEnvironmentContext({ workspaceRoot: gitRoot });
    assert.match(context, /## Git/);
    assert.match(context, /- Branch: /);
  } finally {
    await rm(gitRoot, { recursive: true, force: true });
  }
});

test("buildSystemPrompt prepends the base prompt", async () => {
  const prompt = await buildSystemPrompt({
    basePrompt: "BASE RULES",
    workspaceRoot: root,
    userConfigDir: root,
  });
  assert.ok(prompt.startsWith("BASE RULES\n\n"));
  assert.match(prompt, /## Environment/);
});

test("buildSystemPrompt appends project context when provided", async () => {
  const prompt = await buildSystemPrompt({
    basePrompt: "BASE",
    workspaceRoot: root,
    userConfigDir: root,
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

test("parseRuleFrontmatter reads alwaysApply and globs", () => {
  const { attributes, body } = parseRuleFrontmatter(`---
description: TypeScript conventions
globs: **/*.ts
alwaysApply: true
---

Use strict TypeScript.
`);
  assert.equal(attributes.alwaysApply, true);
  assert.equal(attributes.globs, "**/*.ts");
  assert.match(body, /strict TypeScript/);
  assert.equal(shouldAlwaysApplyRule({ alwaysApply: true }), true);
  assert.equal(shouldAlwaysApplyRule({ alwaysApply: false, globs: "**/*.ts" }), false);
  assert.equal(shouldAlwaysApplyRule({ globs: "**/*.ts" }), false);
  assert.equal(shouldAlwaysApplyRule({}), true);
});

test("loadAppliedInstructions injects AGENTS.md, user instructions, and always-apply rules", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "halo-agent-instr-"));
  const userDir = await mkdtemp(path.join(os.tmpdir(), "halo-agent-user-instr-"));
  try {
    await writeFile(path.join(ws, "AGENTS.md"), "Prefer list_dir over guessing paths.", "utf8");
    await writeFile(path.join(userDir, "instructions.md"), "Use PowerShell ';' not '&&'.", "utf8");
    await mkdir(path.join(ws, ".cursor", "rules"), { recursive: true });
    await writeFile(
      path.join(ws, ".cursor", "rules", "always.mdc"),
      `---
alwaysApply: true
---

Never rewrite git history.
`,
      "utf8",
    );
    await writeFile(
      path.join(ws, ".cursor", "rules", "scoped.mdc"),
      `---
description: TypeScript conventions
globs: "**/*.ts"
alwaysApply: false
---

This should not appear.
`,
      "utf8",
    );
    await mkdir(path.join(ws, "packages", "api"), { recursive: true });
    await writeFile(path.join(ws, "packages", "api", "AGENTS.md"), "API package notes.", "utf8");
    await mkdir(path.join(ws, "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(ws, "node_modules", "dep", "AGENTS.md"), "ignored", "utf8");

    const text = await loadAppliedInstructions({
      workspaceRoot: ws,
      userConfigDir: userDir,
    });
    assert.match(text, /User instructions \(from instructions\.md\)/);
    assert.match(text, /Use PowerShell/);
    assert.match(text, /Workspace instructions \(from AGENTS\.md\)/);
    assert.match(text, /Prefer list_dir/);
    assert.match(text, /\.cursor\/rules\/always\.mdc/);
    assert.match(text, /Never rewrite git history/);
    // Described / scoped rules are listed for fetch_rule, not inlined.
    assert.doesNotMatch(text, /This should not appear/);
    assert.match(text, /## Available rules \(fetch with fetch_rule/);
    assert.match(text, /- scoped \[applies to \*\*\/\*\.ts\]: TypeScript conventions/);
    // Nested AGENTS.md files are listed by path; node_modules is skipped.
    assert.match(text, /## Directory instructions/);
    assert.match(text, /- packages\/api\/AGENTS\.md/);
    assert.doesNotMatch(text, /node_modules/);
    assert.doesNotMatch(text, /API package notes/);

    const rules = await listRules(ws);
    assert.deepEqual(
      rules.map((r) => [r.name, r.alwaysApply]),
      [
        ["always", true],
        ["scoped", false],
      ],
    );
    assert.deepEqual(await listNestedAgentsFiles(ws), ["packages/api/AGENTS.md"]);

    const prompt = await buildSystemPrompt({
      basePrompt: "BASE",
      workspaceRoot: ws,
      userConfigDir: userDir,
    });
    assert.ok(prompt.indexOf("Prefer list_dir") < prompt.indexOf("## Environment"));
  } finally {
    await rm(ws, { recursive: true, force: true });
    await rm(userDir, { recursive: true, force: true });
  }
});
