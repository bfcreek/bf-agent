import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { ToolRegistry } from "../src/tool-registry.mjs";
import { registerBuiltinTools } from "../src/tools/builtin.mjs";
import { MAX_TOOL_OUTPUT_CHARS, resolveWithinRoot } from "../src/tools/fs.mjs";
import { findDeleteCommand } from "../src/tools/shell.mjs";

const IS_WINDOWS = process.platform === "win32";

let root;
let registry;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "halo-agent-tools-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  registry = registerBuiltinTools(new ToolRegistry(), { workspaceRoot: root });
});

test("all builtin tools are registered", () => {
  for (const name of [
    "get_time",
    "echo",
    "read_file",
    "list_dir",
    "write_file",
    "edit_file",
    "grep_search",
    "find_files",
    "run_command",
  ]) {
    assert.ok(registry.has(name), `missing tool: ${name}`);
  }
});

test("resolveWithinRoot rejects escapes and accepts inside paths", () => {
  assert.equal(resolveWithinRoot(root, "a/b.txt"), path.join(root, "a", "b.txt"));
  assert.equal(resolveWithinRoot(root, undefined), path.resolve(root));
  assert.throws(() => resolveWithinRoot(root, "../outside.txt"), /outside the workspace/);
  assert.throws(
    () => resolveWithinRoot(root, path.join(os.tmpdir(), "elsewhere.txt")),
    /outside the workspace/,
  );
});

test("write_file then read_file round-trips content", async () => {
  const write = await registry.execute("write_file", {
    path: "notes/hello.txt",
    content: "hello world",
  });
  assert.equal(write.ok, true);
  assert.equal(write.result.bytesWritten, 11);

  const read = await registry.execute("read_file", { path: "notes/hello.txt" });
  assert.deepEqual(read, { ok: true, result: "hello world" });
});

test("read_file supports offset and limit line ranges", async () => {
  await writeFile(path.join(root, "lines.txt"), "one\ntwo\nthree\nfour\nfive", "utf8");

  const middle = await registry.execute("read_file", { path: "lines.txt", offset: 2, limit: 2 });
  assert.deepEqual(middle, { ok: true, result: "two\nthree" });

  const tail = await registry.execute("read_file", { path: "lines.txt", offset: 4 });
  assert.deepEqual(tail, { ok: true, result: "four\nfive" });
});

test("read_file truncates very large files with a marker", async () => {
  await writeFile(path.join(root, "big.txt"), "x".repeat(MAX_TOOL_OUTPUT_CHARS + 500), "utf8");

  const read = await registry.execute("read_file", { path: "big.txt" });
  assert.equal(read.ok, true);
  assert.match(read.result, /\[output truncated: 500 of \d+ characters omitted\]$/);
});

test("read_file on a missing file fails gracefully", async () => {
  const read = await registry.execute("read_file", { path: "no-such-file.txt" });
  assert.equal(read.ok, false);
  assert.match(read.error, /read_file/);
});

test("list_dir marks directories with a trailing slash", async () => {
  await mkdir(path.join(root, "pkg", "sub"), { recursive: true });
  await writeFile(path.join(root, "pkg", "a.txt"), "a", "utf8");

  const listed = await registry.execute("list_dir", { path: "pkg" });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.result.entries, ["a.txt", "sub/"]);
});

test("edit_file replaces a unique match", async () => {
  await writeFile(path.join(root, "edit.txt"), "alpha beta gamma", "utf8");

  const edit = await registry.execute("edit_file", {
    path: "edit.txt",
    old_string: "beta",
    new_string: "BETA",
  });
  assert.equal(edit.ok, true);
  assert.equal(edit.result.replacements, 1);
  assert.equal(await readFile(path.join(root, "edit.txt"), "utf8"), "alpha BETA gamma");
});

test("edit_file rejects ambiguous matches unless replace_all is set", async () => {
  await writeFile(path.join(root, "dupes.txt"), "x y x y x", "utf8");

  const ambiguous = await registry.execute("edit_file", {
    path: "dupes.txt",
    old_string: "x",
    new_string: "z",
  });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error, /appears 3 times/);

  const all = await registry.execute("edit_file", {
    path: "dupes.txt",
    old_string: "x",
    new_string: "z",
    replace_all: true,
  });
  assert.equal(all.ok, true);
  assert.equal(all.result.replacements, 3);
  assert.equal(await readFile(path.join(root, "dupes.txt"), "utf8"), "z y z y z");
});

test("edit_file reports when old_string is absent", async () => {
  await writeFile(path.join(root, "absent.txt"), "nothing here", "utf8");

  const edit = await registry.execute("edit_file", {
    path: "absent.txt",
    old_string: "missing",
    new_string: "found",
  });
  assert.equal(edit.ok, false);
  assert.match(edit.error, /not found/);
});

test("edit_file falls back to whitespace-tolerant matching and keeps file indentation", async () => {
  const file = "function f() {\n    if (x) {\n        return 1;\n    }\n}\n";
  await writeFile(path.join(root, "indent.mjs"), file, "utf8");

  // The model reproduced the snippet with 2-space indentation instead of 4.
  const edit = await registry.execute("edit_file", {
    path: "indent.mjs",
    old_string: "  if (x) {\n      return 1;\n  }",
    new_string: "  if (x) {\n      return 2;\n  }",
  });

  assert.equal(edit.ok, true);
  assert.match(edit.result.note, /indentation differences ignored/);
  assert.equal(
    await readFile(path.join(root, "indent.mjs"), "utf8"),
    "function f() {\n    if (x) {\n        return 2;\n    }\n}\n",
  );
});

test("edit_file flexible match handles CRLF files with LF snippets, preserving CRLF", async () => {
  await writeFile(path.join(root, "crlf.txt"), "one\r\ntwo\r\nthree\r\n", "utf8");

  const edit = await registry.execute("edit_file", {
    path: "crlf.txt",
    old_string: "one\ntwo",
    new_string: "one\nTWO",
  });

  assert.equal(edit.ok, true);
  assert.equal(await readFile(path.join(root, "crlf.txt"), "utf8"), "one\r\nTWO\r\nthree\r\n");
});

test("edit_file flexible match rejects ambiguous snippets", async () => {
  await writeFile(path.join(root, "ambig.txt"), "  item\nx\n    item\n", "utf8");

  const edit = await registry.execute("edit_file", {
    path: "ambig.txt",
    old_string: "\titem",
    new_string: "\tthing",
  });

  assert.equal(edit.ok, false);
  assert.match(edit.error, /matches 2 places/);
});

test("file tools refuse paths outside the workspace", async () => {
  for (const [name, args] of [
    ["read_file", { path: "../escape.txt" }],
    ["write_file", { path: "../escape.txt", content: "x" }],
    ["list_dir", { path: ".." }],
  ]) {
    const outcome = await registry.execute(name, args);
    assert.equal(outcome.ok, false, `${name} should refuse`);
    assert.match(outcome.error, /outside the workspace/);
  }
});

test("run_command captures stdout and exit code", async () => {
  const run = await registry.execute("run_command", {
    command: `node -e "console.log('hi from tool')"`,
  });
  assert.equal(run.ok, true);
  assert.equal(run.result.exitCode, 0);
  assert.equal(run.result.timedOut, false);
  assert.match(run.result.stdout, /hi from tool/);
});

test("run_command reports non-zero exit codes and stderr", async () => {
  const run = await registry.execute("run_command", {
    command: `node -e "console.error('bad'); process.exit(3)"`,
  });
  assert.equal(run.ok, true);
  assert.equal(run.result.exitCode, 3);
  assert.match(run.result.stderr, /bad/);
});

test("run_command executes in the workspace root", async () => {
  await writeFile(path.join(root, "marker.txt"), "here", "utf8");

  const run = await registry.execute("run_command", {
    command: `node -e "console.log(require('fs').existsSync('marker.txt'))"`,
  });
  assert.equal(run.ok, true);
  assert.match(run.result.stdout, /true/);
});

test("run_command kills commands that exceed the timeout", async () => {
  const run = await registry.execute("run_command", {
    command: `node -e "setTimeout(() => {}, 60000)"`,
    timeout_seconds: 1,
  });
  assert.equal(run.ok, true);
  assert.equal(run.result.timedOut, true);
});

test("run_command rejects a cwd outside the workspace", async () => {
  const run = await registry.execute("run_command", { command: "node -v", cwd: ".." });
  assert.equal(run.ok, false);
  assert.match(run.error, /outside the workspace/);
});

test("findDeleteCommand flags deletion commands in any shell segment", () => {
  for (const command of [
    "rm file.txt",
    "rm -rf build",
    "Remove-Item junk-notes.txt",
    "remove-item -Force junk.txt",
    "del junk.txt",
    "erase old.log",
    "rmdir /s /q build",
    "rd build",
    "unlink file.txt",
    "sudo rm -rf /tmp/x",
    "/bin/rm file.txt",
    "git rm tracked.txt",
    "git clean -fd",
    "find . -name '*.log' -delete",
    "echo hi; rm file.txt",
    "npm test && del artifacts.zip",
    "Get-ChildItem *.tmp | Remove-Item",
    "Get-ChildItem | ForEach-Object { Remove-Item $_ }",
  ]) {
    assert.ok(findDeleteCommand(command), `should flag: ${command}`);
  }
});

test("findDeleteCommand leaves non-deletion commands alone", () => {
  for (const command of [
    "node -v",
    "npm test",
    "git status",
    "git rm-remote", // not `git rm`
    "grep -r 'rm' src",
    "echo rm file.txt", // rm is an argument, not the command
    "node scripts/rmdir-report.mjs",
    "Move-Item a.txt b.txt",
    "find . -name '*.log'",
  ]) {
    assert.equal(findDeleteCommand(command), null, `should not flag: ${command}`);
  }
});

test("run_command blocks deletion commands when no approval handler is set", async () => {
  await writeFile(path.join(root, "precious.txt"), "keep me", "utf8");

  const run = await registry.execute("run_command", {
    command: IS_WINDOWS ? "Remove-Item precious.txt" : "rm precious.txt",
  });
  assert.equal(run.ok, false);
  assert.match(run.error, /requires explicit user approval/);
  assert.match(run.error, /ask the user/);
  assert.equal(await readFile(path.join(root, "precious.txt"), "utf8"), "keep me");
});

test("run_command allows deletion once an approval handler has approved", async () => {
  await writeFile(path.join(root, "doomed.txt"), "bye", "utf8");
  registry.setApprovalHandler(() => true);

  const run = await registry.execute("run_command", {
    command: IS_WINDOWS ? "Remove-Item doomed.txt" : "rm doomed.txt",
  });
  assert.equal(run.ok, true);
  assert.equal(run.result.exitCode, 0);
  await assert.rejects(readFile(path.join(root, "doomed.txt"), "utf8"));
});

test("run_command still runs non-deletion commands without an approval handler", async () => {
  const run = await registry.execute("run_command", {
    command: `node -e "console.log('harmless')"`,
  });
  assert.equal(run.ok, true);
  assert.match(run.result.stdout, /harmless/);
});
