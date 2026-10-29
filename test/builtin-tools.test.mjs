import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { AgentLoop } from "../src/agent-loop.mjs";
import { ToolRegistry } from "../src/tool-registry.mjs";
import { registerBuiltinTools } from "../src/tools/builtin.mjs";
import { resolveWithinRoot, writeFileSchemaIssue } from "../src/tools/fs.mjs";
import { classifyCleanupFileMutation } from "../src/tools/mutation-safety.mjs";
import { MAX_TOOL_OUTPUT_CHARS, TOOL_OUTPUT_DIR } from "../src/tools/output.mjs";
import {
  classifyDeleteCommand,
  extractDeleteTargets,
  findDeleteCommand,
  findInteractiveCommand,
  fitTimeoutToDeadline,
  DEADLINE_COMMAND_RESERVE_MS,
  DEADLINE_MIN_COMMAND_MS,
} from "../src/tools/shell.mjs";

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
    "web_search",
    "fetch_url",
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

  const aliased = await registry.execute("read_file", {
    path: "lines.txt",
    line_start: 2,
    line_end: 3,
  });
  assert.deepEqual(aliased, { ok: true, result: "two\nthree" });
});

test("read_file spills very large files to disk and returns head + tail + path", async () => {
  const body = `${"h".repeat(1000)}${"x".repeat(MAX_TOOL_OUTPUT_CHARS)}${"t".repeat(1000)}`;
  await writeFile(path.join(root, "big.txt"), body, "utf8");

  const read = await registry.execute("read_file", { path: "big.txt" });
  assert.equal(read.ok, true);
  assert.ok(read.result.startsWith("h".repeat(1000)), "head is kept");
  assert.ok(read.result.endsWith("t".repeat(1000)), "tail is kept");
  const pointer = read.result.match(/saved to (\S+) — read_file it/);
  assert.ok(pointer, "points at the spilled file");
  assert.ok(pointer[1].startsWith(TOOL_OUTPUT_DIR.split(path.sep).join("/")));
  assert.equal(await readFile(path.join(root, pointer[1]), "utf8"), body);
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
  assert.match(edit.error, /appears 2 times/);
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
  assert.equal(run.result.status, "success");
  assert.equal(run.result.exitCode, 0);
  assert.equal(run.result.timedOut, false);
  assert.match(run.result.stdout, /hi from tool/);
});

test("run_command reports non-zero exit codes and stderr", async () => {
  const run = await registry.execute("run_command", {
    command: `node -e "console.error('bad'); process.exit(3)"`,
  });
  assert.equal(run.ok, true);
  assert.equal(run.result.status, "FAILED with exit code 3");
  assert.equal(run.result.exitCode, 3);
  assert.match(run.result.stderr, /bad/);
});

test("fitTimeoutToDeadline clamps a command timeout to the run's remaining wall clock", () => {
  const now = 1_000_000;
  // No deadline: requested timeout passes through untouched.
  assert.deepEqual(fitTimeoutToDeadline({ requestedMs: 600_000, deadlineAt: null, now }), {
    timeoutMs: 600_000,
    clamped: false,
    remainingMs: null,
  });
  // Plenty of budget: untouched.
  const roomy = fitTimeoutToDeadline({ requestedMs: 60_000, deadlineAt: now + 900_000, now });
  assert.equal(roomy.timeoutMs, 60_000);
  assert.equal(roomy.clamped, false);
  // A 1500s install inside a run with 300s left is cut to what remains minus the reserve.
  const tight = fitTimeoutToDeadline({ requestedMs: 1_500_000, deadlineAt: now + 300_000, now });
  assert.equal(tight.clamped, true);
  assert.equal(tight.timeoutMs, 300_000 - DEADLINE_COMMAND_RESERVE_MS);
  assert.equal(tight.remainingMs, 300_000);
  // Nothing useful can finish: report exhaustion instead of a doomed command.
  const gone = fitTimeoutToDeadline({
    requestedMs: 30_000,
    deadlineAt: now + DEADLINE_COMMAND_RESERVE_MS + DEADLINE_MIN_COMMAND_MS - 1,
    now,
  });
  assert.equal(gone.exhausted, true);
  assert.equal(fitTimeoutToDeadline({ requestedMs: 30_000, deadlineAt: now - 5_000, now }).remainingMs, 0);
});

test("run_command refuses to start when the run's wall-clock budget is spent", async () => {
  registry.setRunContext({ goal: "build it", deadlineAt: Date.now() + 1_000 });
  const run = await registry.execute("run_command", {
    command: `node -e "console.log('never')"`,
    timeout_seconds: 120,
  });
  assert.equal(run.ok, false);
  assert.match(run.error, /wall-clock budget remain/);
  assert.match(run.error, /final answer now/);
});

test("run_command clamps timeout_seconds to the remaining wall clock and says so", async () => {
  registry.setRunContext({
    goal: "build it",
    deadlineAt: Date.now() + DEADLINE_COMMAND_RESERVE_MS + 40_000,
  });
  const run = await registry.execute("run_command", {
    command: `node -e "console.log('quick')"`,
    timeout_seconds: 300,
  });
  assert.equal(run.ok, true);
  assert.equal(run.result.status, "success");
  assert.match(run.result.note, /clamped from 300s to (39|40)s/);
  assert.match(run.result.note, /wall-clock budget remain/);
  registry.setRunContext(null);
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
  assert.match(run.result.status, /TIMED OUT after 1s and was killed/);
});

test("run_command rejects a cwd outside the workspace", async () => {
  const run = await registry.execute("run_command", { command: "node -v", cwd: ".." });
  assert.equal(run.ok, false);
  assert.match(run.error, /outside the workspace/);
});

test("findInteractiveCommand flags bare interpreters and shells", () => {
  for (const command of [
    "node",
    "python",
    "python3",
    "bash",
    "pwsh",
    "node -i",
    "python --interactive",
    "echo hi; node",
    "cd src && python",
  ]) {
    assert.ok(findInteractiveCommand(command), `should flag: ${command}`);
  }
});

test("findInteractiveCommand leaves script and inline invocations alone", () => {
  for (const command of [
    "node script.mjs",
    "node test.mjs --verbose",
    `node -e "console.log('hi')"`,
    `python -c "print('hi')"`,
    "python script.py",
    "node --version",
    "bash -c 'ls'",
    "npm test",
    "git status",
    "dotnet run",
    // Heredoc-fed interpreters have stdin; the body and terminator (`PY` →
    // basename `py`) must not be read as command segments.
    "python3 - <<'PY'\nimport sys\nprint(sys.argv)\nPY",
    "python - <<PY\nimport sys\nnode\nPY",
    "cat <<EOF > notes.txt\nhello\nEOF",
    // Piped interpreters read the pipe, not a TTY.
    "echo 'print(1)' | python3",
    "cat script.js | node",
  ]) {
    assert.equal(findInteractiveCommand(command), null, `should not flag: ${command}`);
  }
  // A bare REPL after a heredoc-fed command is still flagged.
  assert.ok(findInteractiveCommand("python3 - <<'PY'\nprint(1)\nPY\nnode"));
});

test("run_command refuses commands that would open an interactive REPL", async () => {
  const run = await registry.execute("run_command", { command: "node" });
  assert.equal(run.ok, false);
  assert.match(run.error, /interactive REPL/);
  assert.match(run.error, /node -e/);
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

test("extractDeleteTargets keeps files, skips flags and switches", () => {
  assert.deepEqual(extractDeleteTargets("rm -rf build/"), ["build"]);
  assert.deepEqual(extractDeleteTargets("Remove-Item -Force -Recurse junk.txt"), ["junk.txt"]);
  assert.deepEqual(extractDeleteTargets("rmdir /s /q build"), ["build"]);
  // Quoted names with spaces split on whitespace — a known limitation; both
  // halves must then be authorized, which is the conservative direction.
  assert.deepEqual(extractDeleteTargets("del 'old notes.txt'"), ["old", "notes.txt"]);
  assert.deepEqual(extractDeleteTargets("git rm tracked.txt"), ["tracked.txt"]);
  assert.deepEqual(extractDeleteTargets("git clean -fd"), []);
  assert.deepEqual(extractDeleteTargets("find . -name '*.log' -delete"), []);
  assert.deepEqual(extractDeleteTargets("rm ./scratch.md"), ["scratch.md"]);
  assert.deepEqual(
    extractDeleteTargets("Remove-Item invoice.json -ErrorAction SilentlyContinue"),
    ["invoice.json"],
  );
  assert.deepEqual(
    extractDeleteTargets("Remove-Item -ErrorAction SilentlyContinue invoice.json"),
    ["invoice.json"],
  );
});

test("classifyDeleteCommand ignores SilentlyContinue on a named persist file", () => {
  const goal =
    "Persist CLI state in invoice.json at the workspace root so each process sees prior lines.";
  const result = classifyDeleteCommand(
    "Remove-Item invoice.json -ErrorAction SilentlyContinue",
    goal,
  );
  assert.equal(result.verdict, "authorized");
});

test("classifyDeleteCommand authorizes deletes the goal explicitly names", () => {
  const goal = "Delete the file junk-notes.txt from this workspace. Do not change any other file.";
  assert.equal(classifyDeleteCommand("Remove-Item junk-notes.txt", goal).verdict, "authorized");
  assert.equal(classifyDeleteCommand("rm ./junk-notes.txt", goal).verdict, "authorized");
  assert.equal(classifyDeleteCommand("node -v", goal).verdict, "none");
});

test("classifyDeleteCommand blocks deletes the goal never named", () => {
  const goal = "Clean up unused files in this project.";
  const result = classifyDeleteCommand("rm junk-notes.txt", goal);
  assert.equal(result.verdict, "unauthorized");
  assert.equal(result.target, "junk-notes.txt");
});

test("classifyDeleteCommand blocks files the goal says to keep", () => {
  const goal =
    "Clean up unused files. important.mjs is required — do not delete or modify it. Delete junk-notes.txt.";
  const keep = classifyDeleteCommand("rm important.mjs", goal);
  assert.equal(keep.verdict, "protected");
  assert.equal(keep.target, "important.mjs");
  // Protection is judged per sentence: the explicit delete still goes ahead.
  assert.equal(classifyDeleteCommand("rm junk-notes.txt", goal).verdict, "authorized");
});

test("classifyDeleteCommand blocks broad or indirect deletes", () => {
  const goal = "Delete all the .log files and the build directory.";
  assert.equal(classifyDeleteCommand("rm -rf .", goal).verdict, "unauthorized");
  assert.equal(classifyDeleteCommand("git clean -fd", goal).verdict, "unauthorized");
  assert.equal(classifyDeleteCommand("find . -name '*.log' -delete", goal).verdict, "unauthorized");
  assert.equal(classifyDeleteCommand("Get-ChildItem | Remove-Item", goal).verdict, "unauthorized");
  // Wildcards authorize via their fixed part when the goal names it.
  assert.equal(classifyDeleteCommand("rm *.log", goal).verdict, "authorized");
  assert.equal(classifyDeleteCommand("rm -rf build", goal).verdict, "authorized");
});

test("classifyDeleteCommand does not match partial file names", () => {
  const goal = "Delete junk-notes.txt.";
  assert.equal(classifyDeleteCommand("rm notes.txt", goal).verdict, "unauthorized");
  assert.equal(classifyDeleteCommand("rm junk", goal).verdict, "unauthorized");
});

test("classifyCleanupFileMutation blocks unnamed writes on cleanup goals", () => {
  const goal =
    "Clean up unused files in this project. important.mjs is required — do not delete or modify it.";
  assert.equal(classifyCleanupFileMutation("junk-notes.txt", goal).verdict, "unauthorized");
  assert.equal(classifyCleanupFileMutation("helper.mjs", goal).verdict, "unauthorized");
  assert.equal(classifyCleanupFileMutation("important.mjs", goal).verdict, "protected");
  assert.equal(classifyCleanupFileMutation("config.json", "Set debug to true.").verdict, "none");
});

test("classifyCleanupFileMutation authorizes files the goal explicitly names", () => {
  const goal = "Delete the file junk-notes.txt from this workspace. Do not change any other file.";
  assert.equal(classifyCleanupFileMutation("junk-notes.txt", goal).verdict, "authorized");
  assert.equal(classifyCleanupFileMutation("important.mjs", goal).verdict, "unauthorized");
});

test("write_file blocks cleanup workarounds when unattended", async () => {
  await writeFile(path.join(root, "junk-notes.txt"), "maybe delete me?\n", "utf8");
  registry.setRunContext({
    goal:
      "Clean up unused files in this project. important.mjs is required — do not delete or modify it.",
  });

  const write = await registry.execute("write_file", {
    path: "junk-notes.txt",
    content: "",
  });
  assert.equal(write.ok, false);
  assert.match(write.error, /cleanup\/delete|did not explicitly name/i);
  assert.equal(await readFile(path.join(root, "junk-notes.txt"), "utf8"), "maybe delete me?\n");
});

test("edit_file blocks protected files on cleanup goals", async () => {
  await writeFile(path.join(root, "important.mjs"), "export const version = 1;\n", "utf8");
  registry.setRunContext({
    goal:
      "Clean up unused files. important.mjs is required — do not delete or modify it.",
  });

  const edit = await registry.execute("edit_file", {
    path: "important.mjs",
    old_string: "version = 1",
    new_string: "version = 2",
  });
  assert.equal(edit.ok, false);
  assert.match(edit.error, /keep that file/i);
  assert.equal(await readFile(path.join(root, "important.mjs"), "utf8"), "export const version = 1;\n");
});

test("write_file still works for ordinary non-cleanup goals", async () => {
  registry.setRunContext({ goal: 'Open config.json and set "debug" to true.' });
  const write = await registry.execute("write_file", {
    path: "config.json",
    content: '{"debug":true}\n',
  });
  assert.equal(write.ok, true);
  assert.equal(await readFile(path.join(root, "config.json"), "utf8"), '{"debug":true}\n');
});

test("run_command deletes a file the goal explicitly names, unattended", async () => {
  await writeFile(path.join(root, "doomed.txt"), "bye", "utf8");
  registry.setRunContext({ goal: "Please delete doomed.txt from the workspace." });

  const run = await registry.execute("run_command", {
    command: IS_WINDOWS ? "Remove-Item doomed.txt" : "rm doomed.txt",
  });
  assert.equal(run.ok, true);
  assert.equal(run.result.exitCode, 0);
  await assert.rejects(readFile(path.join(root, "doomed.txt"), "utf8"));
});

test("run_command blocks deletes the goal never authorized", async () => {
  await writeFile(path.join(root, "precious.txt"), "keep me", "utf8");
  registry.setRunContext({ goal: "Clean up unused files in this project." });

  const run = await registry.execute("run_command", {
    command: IS_WINDOWS ? "Remove-Item precious.txt" : "rm precious.txt",
  });
  assert.equal(run.ok, false);
  assert.match(run.error, /did not explicitly name/);
  assert.match(run.error, /Do not retry rm|ask the user/i);
  assert.match(run.error, /allow-overwrite|leaving temporary/i);
  assert.equal(await readFile(path.join(root, "precious.txt"), "utf8"), "keep me");
});
test("run_command blocks deletes of files the goal says to keep", async () => {
  await writeFile(path.join(root, "vital.txt"), "do not lose", "utf8");
  registry.setRunContext({
    goal: "Tidy the workspace. vital.txt is required — do not delete it.",
  });

  const run = await registry.execute("run_command", {
    command: IS_WINDOWS ? "Remove-Item vital.txt" : "rm vital.txt",
  });
  assert.equal(run.ok, false);
  assert.match(run.error, /say to keep/);
  assert.equal(await readFile(path.join(root, "vital.txt"), "utf8"), "do not lose");
});

test("run_command blocks deletes when no run context is set (safe default)", async () => {
  await writeFile(path.join(root, "orphan.txt"), "x", "utf8");

  const run = await registry.execute("run_command", {
    command: IS_WINDOWS ? "Remove-Item orphan.txt" : "rm orphan.txt",
  });
  assert.equal(run.ok, false);
  assert.equal(await readFile(path.join(root, "orphan.txt"), "utf8"), "x");
});

test("run_command allows any approved delete when an approval handler is set", async () => {
  await writeFile(path.join(root, "approved.txt"), "bye", "utf8");
  registry.setRunContext({ goal: "Clean up unused files." });
  registry.setApprovalHandler(() => true);

  const run = await registry.execute("run_command", {
    command: IS_WINDOWS ? "Remove-Item approved.txt" : "rm approved.txt",
  });
  assert.equal(run.ok, true);
  await assert.rejects(readFile(path.join(root, "approved.txt"), "utf8"));
});

test("run_command allows a delete that was auto-approved", async () => {
  await writeFile(path.join(root, "auto.txt"), "bye", "utf8");
  registry.setRunContext({ goal: "Clean up unused files." });
  registry.setAutoApprove("all");

  const run = await registry.execute("run_command", {
    command: IS_WINDOWS ? "Remove-Item auto.txt" : "rm auto.txt",
  });
  assert.equal(run.ok, true);
  await assert.rejects(readFile(path.join(root, "auto.txt"), "utf8"));
});

test("run_command still blocks deletes when a different tool is auto-approved", async () => {
  await writeFile(path.join(root, "kept.txt"), "stay", "utf8");
  registry.setRunContext({ goal: "Clean up unused files." });
  registry.setAutoApprove(["write_file"]);

  const run = await registry.execute("run_command", {
    command: IS_WINDOWS ? "Remove-Item kept.txt" : "rm kept.txt",
  });
  assert.equal(run.ok, false);
  assert.match(run.error, /did not explicitly name/);
  assert.equal(await readFile(path.join(root, "kept.txt"), "utf8"), "stay");
});

test("run_command still runs non-deletion commands without any authorization", async () => {
  const run = await registry.execute("run_command", {
    command: `node -e "console.log('harmless')"`,
  });
  assert.equal(run.ok, true);
  assert.match(run.result.stdout, /harmless/);
});

test("agent loop hands the goal to tools via run context", async () => {
  const captured = [];
  const fakeRegistry = {
    schemas: () => [],
    execute: async () => ({ ok: true, result: "" }),
    setRunContext(context) {
      captured.push(context);
    },
  };
  const client = {
    chat: async () => ({ message: { role: "assistant", content: "done" }, raw: {} }),
  };
  const loop = new AgentLoop({ client, registry: fakeRegistry });
  await loop.run("delete junk.txt");
  assert.deepEqual(captured, [{ goal: "delete junk.txt", deadlineAt: null }]);
});

test("writeFileSchemaIssue rejects conflated run_command fields", () => {
  assert.match(writeFileSchemaIssue({ path: "x.py", command: "echo hi" }) ?? "", /run_command/i);
});

test("list_dir hides the agent data directory", async () => {
  await mkdir(path.join(root, ".bf", "bf-agent"), { recursive: true });
  await mkdir(path.join(root, ".halo-agent"), { recursive: true });
  await mkdir(path.join(root, "visible-dir"), { recursive: true });
  const out = await registry.execute("list_dir", {});
  assert.equal(out.ok, true);
  assert.ok(out.result.entries.includes("visible-dir/"));
  assert.ok(!out.result.entries.includes(".bf/"), ".bf/ should be hidden");
  assert.ok(!out.result.entries.includes(".halo-agent/"), ".halo-agent/ should be hidden");
});

test("search_project is registered only when projectIndex is on", () => {
  const embed = { embed: async () => [0, 1] };
  const withIndex = registerBuiltinTools(new ToolRegistry(), { workspaceRoot: root, searchClient: embed });
  assert.ok(withIndex.has("search_project"), "default keeps the previous behavior for direct callers");
  const noIndex = registerBuiltinTools(new ToolRegistry(), { workspaceRoot: root, searchClient: embed, projectIndex: false });
  assert.ok(!noIndex.has("search_project"));
  assert.ok(noIndex.has("fetch_url"), "fetch_url still gets the embed client");
  const noClient = registerBuiltinTools(new ToolRegistry(), { workspaceRoot: root, projectIndex: true });
  assert.ok(!noClient.has("search_project"));
});
