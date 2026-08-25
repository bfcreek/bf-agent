import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { ToolRegistry } from "../src/tool-registry.mjs";
import { registerBuiltinTools } from "../src/tools/builtin.mjs";
import { replaceFlexible, replaceOnce, truncatedSourceIssue, suggestedUniqueSnippets, windowsBashScriptIssue } from "../src/tools/fs.mjs";

let root;
let registry;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "halo-agent-fs-safety-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  registry = registerBuiltinTools(new ToolRegistry(), { workspaceRoot: root });
});

async function writeWorkspaceFile(relativePath, content) {
  const target = path.join(root, relativePath);
  await writeFile(target, content, "utf8");
  return target;
}

async function readWorkspaceFile(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function assertFileUnchanged(relativePath, before, editResult) {
  assert.equal(editResult.ok, false, "edit should fail");
  assert.equal(await readWorkspaceFile(relativePath), before, "file must be unchanged after a failed edit");
}

// --- replaceOnce / replaceFlexible unit tests ---

test("replaceOnce treats dollar signs in the replacement literally", () => {
  assert.equal(replaceOnce("cost = OLD", "OLD", "$$100"), "cost = $$100");
  assert.equal(replaceOnce("use $& here", "$&", "literal"), "use literal here");
});

test("replaceFlexible returns null for whitespace-only snippets", () => {
  assert.equal(replaceFlexible("hello\nworld", "   \n  ", "x"), null);
});

test("replaceFlexible returns null when nothing matches", () => {
  assert.equal(replaceFlexible("alpha\nbeta", "gamma", "delta"), null);
});

test("replaceFlexible reports ambiguity without changing text", () => {
  const text = "  item\nbody\n  item\n";
  const result = replaceFlexible(text, "item", "thing");
  assert.equal(result.matches, 2);
  assert.equal(result.updated, text);
});

test("replaceFlexible preserves bytes outside the matched region", () => {
  const text = "HEADER\n  keep me\n  change me\nFOOTER\n";
  const result = replaceFlexible(text, "change me", "done");
  assert.equal(result.matches, 1);
  assert.equal(result.updated, "HEADER\n  keep me\n  done\nFOOTER\n");
});

test("replaceFlexible keeps CRLF line endings when the model uses LF", () => {
  const text = "one\r\ntwo\r\nthree\r\n";
  const result = replaceFlexible(text, "one\ntwo", "one\r\nTWO");
  assert.equal(result.matches, 1);
  assert.equal(result.updated, "one\r\nTWO\r\nthree\r\n");
});

// --- edit_file must not corrupt on failure ---

test("edit_file rejects empty old_string without touching the file", async () => {
  const before = "do not erase me";
  await writeWorkspaceFile("empty-old.txt", before);

  const edit = await registry.execute("edit_file", {
    path: "empty-old.txt",
    old_string: "",
    new_string: "gone",
  });

  await assertFileUnchanged("empty-old.txt", before, edit);
  assert.match(edit.error, /old_string must not be empty/);
});

test("edit_file leaves the file unchanged when old_string is missing", async () => {
  const before = '{"debug": true, "port": 3000}\n';
  await writeWorkspaceFile("config.json", before);

  const edit = await registry.execute("edit_file", {
    path: "config.json",
    old_string: '"debug": false',
    new_string: '"debug": true',
  });

  await assertFileUnchanged("config.json", before, edit);
});

test("edit_file leaves the file unchanged on ambiguous exact matches", async () => {
  const before = "id: 1\nid: 2\nid: 3\n";
  await writeWorkspaceFile("ids.txt", before);

  const edit = await registry.execute("edit_file", {
    path: "ids.txt",
    old_string: "id:",
    new_string: "key:",
  });

  await assertFileUnchanged("ids.txt", before, edit);
  assert.match(edit.error, /appears 3 times/);
});

test("edit_file leaves the file unchanged on ambiguous flexible matches", async () => {
  const before = "  item\nx\n    item\n";
  await writeWorkspaceFile("ambig-flex.txt", before);

  const edit = await registry.execute("edit_file", {
    path: "ambig-flex.txt",
    old_string: "\titem",
    new_string: "\tthing",
  });

  await assertFileUnchanged("ambig-flex.txt", before, edit);
  assert.match(edit.error, /appears 2 times/);
});

// --- successful edits must preserve unrelated content ---

test("edit_file preserves unicode and untouched lines byte-for-byte", async () => {
  const before = "# title 🚀\nname = OLD\n# 日本語コメント\n";
  await writeWorkspaceFile("unicode.txt", before);

  const edit = await registry.execute("edit_file", {
    path: "unicode.txt",
    old_string: "name = OLD",
    new_string: "name = NEW",
  });

  assert.equal(edit.ok, true);
  assert.equal(await readWorkspaceFile("unicode.txt"), "# title 🚀\nname = NEW\n# 日本語コメント\n");
});

test("edit_file can change one JSON field without disturbing the rest", async () => {
  const before = '{\n  "debug": false,\n  "port": 3000,\n  "tags": ["a", "b"]\n}\n';
  await writeWorkspaceFile("app.json", before);

  const edit = await registry.execute("edit_file", {
    path: "app.json",
    old_string: '"debug": false',
    new_string: '"debug": true',
  });

  assert.equal(edit.ok, true);
  const after = await readWorkspaceFile("app.json");
  assert.equal(after, '{\n  "debug": true,\n  "port": 3000,\n  "tags": ["a", "b"]\n}\n');
  assert.doesNotThrow(() => JSON.parse(after));
});

test("edit_file preserves a missing final newline when the edit is not at EOF", async () => {
  const before = "first\nsecond";
  await writeWorkspaceFile("no-eol.txt", before);

  const edit = await registry.execute("edit_file", {
    path: "no-eol.txt",
    old_string: "first",
    new_string: "FIRST",
  });

  assert.equal(edit.ok, true);
  assert.equal(await readWorkspaceFile("no-eol.txt"), "FIRST\nsecond");
});

test("edit_file preserves trailing newline when only an inner line changes", async () => {
  const before = "alpha\nbeta\n";
  await writeWorkspaceFile("trail-nl.txt", before);

  const edit = await registry.execute("edit_file", {
    path: "trail-nl.txt",
    old_string: "beta",
    new_string: "BETA",
  });

  assert.equal(edit.ok, true);
  assert.equal(await readWorkspaceFile("trail-nl.txt"), "alpha\nBETA\n");
});

test("edit_file keeps dollar signs and regex-like text in the replacement", async () => {
  const before = "const pattern = OLD;\n";
  await writeWorkspaceFile("dollars.mjs", before);

  const edit = await registry.execute("edit_file", {
    path: "dollars.mjs",
    old_string: "OLD",
    new_string: "/^\\$[0-9]+$/",
  });

  assert.equal(edit.ok, true);
  assert.equal(await readWorkspaceFile("dollars.mjs"), "const pattern = /^\\$[0-9]+$/;\n");
});

test("edit_file replace_all only changes matched spans", async () => {
  const before = "foo + foo = foo\n";
  await writeWorkspaceFile("replace-all.txt", before);

  const edit = await registry.execute("edit_file", {
    path: "replace-all.txt",
    old_string: "foo",
    new_string: "bar",
    replace_all: true,
  });

  assert.equal(edit.ok, true);
  assert.equal(edit.result.replacements, 3);
  assert.equal(await readWorkspaceFile("replace-all.txt"), "bar + bar = bar\n");
});

test("edit_file flexible match re-indents without shifting unrelated code", async () => {
  const before = [
    "function outer() {",
    "    if (ready) {",
    "        return run();",
    "    }",
    "    return idle();",
    "}",
    "",
  ].join("\n");
  await writeWorkspaceFile("indent-safe.mjs", before);

  const edit = await registry.execute("edit_file", {
    path: "indent-safe.mjs",
    old_string: "  if (ready) {\n    return run();\n  }",
    new_string: "  if (ready) {\n    return stop();\n  }",
  });

  assert.equal(edit.ok, true);
  const after = await readWorkspaceFile("indent-safe.mjs");
  assert.match(after, /return stop\(\);/);
  assert.match(after, /return idle\(\);/);
  assert.equal(after.split("\n")[4], "    return idle();");
});

test("write_file refuses to create a missing file the user asked to edit", async () => {
  registry.setRunContext({ goal: "Fix the typo in NONEXISTENT_FILE.mjs and save it." });
  const write = await registry.execute("write_file", {
    path: "NONEXISTENT_FILE.mjs",
    content: "export const x = 1;\n",
  });
  assert.equal(write.ok, false);
  assert.match(write.error, /does not exist/);
});

test("write_file still creates files when the task asked to create them", async () => {
  registry.setRunContext({ goal: "Create greet.mjs that exports greet()." });
  const write = await registry.execute("write_file", {
    path: "greet-created.mjs",
    content: "export function greet() { return 'hi'; }\n",
  });
  assert.equal(write.ok, true);
  assert.match(await readWorkspaceFile("greet-created.mjs"), /export function greet/);
});

test("edit_file rejects identical old_string and new_string without touching the file", async () => {
  const before = "hello world\n";
  await writeWorkspaceFile("same.txt", before);
  const edit = await registry.execute("edit_file", {
    path: "same.txt",
    old_string: "hello",
    new_string: "hello",
  });
  await assertFileUnchanged("same.txt", before, edit);
  assert.match(edit.error, /identical/);
});

test("write_file allows creating a shared module on extract/refactor goals", async () => {
  registry.setRunContext({
    goal: "Extract shared slugify into src/slugify.mjs, update imports, keep behavior identical.",
  });
  const write = await registry.execute("write_file", {
    path: "src/slugify.mjs",
    content: "export function slugify(text) { return String(text).toLowerCase(); }\n",
  });
  assert.equal(write.ok, true);
  assert.match(await readWorkspaceFile("src/slugify.mjs"), /export function slugify/);
});

test("write_file rejects a missing path", async () => {
  const write = await registry.execute("write_file", { content: "x" });
  assert.equal(write.ok, false);
  assert.match(write.error, /path is required/);
});
test("edit_file suggests similar paths when the target is missing", async () => {
  await writeWorkspaceFile("MathOps.cs", "class MathOps {}\n");
  const edit = await registry.execute("edit_file", {
    path: "MathAdd.cs",
    old_string: "a",
    new_string: "b",
  });
  assert.equal(edit.ok, false);
  assert.match(edit.error, /does not exist/);
  assert.match(edit.error, /MathOps\.cs|Did you mean/i);
});

test("truncatedSourceIssue flags unbalanced C# and accepts a complete class", () => {
  assert.match(
    truncatedSourceIssue("Program.cs", "class Program { static void Main() {"),
    /truncated|incomplete/i,
  );
  assert.equal(
    truncatedSourceIssue("Program.cs", "class Program { static void Main() {} }\n"),
    null,
  );
});

test("write_file refuses truncated C# source", async () => {
  const write = await registry.execute("write_file", {
    path: "Broken.cs",
    content: "class Broken { void M() {",
  });
  assert.equal(write.ok, false);
  assert.match(write.error, /truncated|incomplete/i);
});

test("truncatedSourceIssue flags placeholder C# stubs", () => {
  assert.match(
    truncatedSourceIssue(
      "Catalog.cs",
      "class Catalog { public void List() { throw new NotImplementedException(); } }\n",
    ),
    /placeholder|incomplete/i,
  );
  assert.match(
    truncatedSourceIssue("Catalog.cs", "class Catalog {\n  // ... incomplete\n}\n"),
    /placeholder|incomplete/i,
  );
  assert.equal(
    truncatedSourceIssue("Catalog.cs", "class Catalog { public static void List() {} }\n"),
    null,
  );
});

test("truncatedSourceIssue flags C# CS0542 method/class name clash", () => {
  assert.match(
    truncatedSourceIssue(
      "Slugify.cs",
      "public static class Slugify { public static string Slugify(string text) { return text; } }\n",
    ),
    /CS0542|same name as its class/i,
  );
  assert.equal(
    truncatedSourceIssue(
      "Slugify.cs",
      "public static class Slugify { public static string ToSlug(string text) { return text; } }\n",
    ),
    null,
  );
});

test("edit_file refuses replace_all on a non-unique statement snippet", async () => {
  await writeWorkspaceFile("ops.py", "def add(a, b):\n    return a + b\n\ndef mul(a, b):\n    return a + b\n");
  const blocked = await registry.execute("edit_file", {
    path: "ops.py",
    old_string: "    return a + b",
    new_string: "    return a * b",
    replace_all: true,
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /replace_all|enclosing function/i);
  const ambiguous = await registry.execute("edit_file", {
    path: "ops.py",
    old_string: "    return a + b",
    new_string: "    return a * b",
  });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error, /enclosing function|surrounding context/i);
  assert.doesNotMatch(ambiguous.error, /or set replace_all/);
  assert.match(ambiguous.error, /def add[\s\S]*return a \+ b/);
  assert.match(ambiguous.error, /def mul[\s\S]*return a \+ b/);
});

test("suggestedUniqueSnippets includes enclosing function context", () => {
  const text = "def add(a, b):\n    return a + b\n\ndef mul(a, b):\n    return a + b\n";
  const snippets = suggestedUniqueSnippets(text, "    return a + b");
  assert.equal(snippets.length, 2);
  assert.match(snippets[0], /def add/);
  assert.match(snippets[1], /def mul/);
});

const BASH_HELLO = "#!/bin/bash\necho hello\n";
const PS1_HELLO = "Write-Output 'hello'\n";

test("windowsBashScriptIssue refuses new bash scripts on Windows", () => {
  const win = { platform: "win32" };
  assert.match(
    windowsBashScriptIssue("hello.sh", BASH_HELLO, "Create a script that prints hello", win),
    /\.ps1|PowerShell/,
  );
  assert.match(
    windowsBashScriptIssue("hello.bash", BASH_HELLO, "write a helper script", win),
    /\.ps1|PowerShell/,
  );
  assert.match(
    windowsBashScriptIssue("run", BASH_HELLO, "Create a script that prints hello", win),
    /shebang|\.ps1|PowerShell/i,
  );
  assert.equal(
    windowsBashScriptIssue("hello.ps1", PS1_HELLO, "Create a script that prints hello", win),
    null,
  );
  assert.equal(
    windowsBashScriptIssue("hello.sh", BASH_HELLO, "Create a script that prints hello", {
      platform: "linux",
    }),
    null,
  );
  assert.equal(
    windowsBashScriptIssue("hello.sh", BASH_HELLO, "Write a bash script that prints hello", win),
    null,
  );
  assert.equal(
    windowsBashScriptIssue("deploy.sh", BASH_HELLO, "Fix deploy.sh", { ...win, exists: true }),
    null,
  );
  assert.equal(
    windowsBashScriptIssue("cli.mjs", "#!/usr/bin/env node\nexport const x = 1;\n", "Create cli.mjs", win),
    null,
  );
});

test("write_file uses the native shell script type", async () => {
  registry.setRunContext({ goal: "Create a script that prints hello" });
  if (process.platform === "win32") {
    const sh = await registry.execute("write_file", {
      path: "hello.sh",
      content: BASH_HELLO,
    });
    assert.equal(sh.ok, false);
    assert.match(sh.error, /\.ps1|PowerShell/);
    const ps1 = await registry.execute("write_file", {
      path: "hello.ps1",
      content: PS1_HELLO,
    });
    assert.equal(ps1.ok, true);
    assert.match(await readWorkspaceFile("hello.ps1"), /Write-Output/);
  } else {
    const sh = await registry.execute("write_file", {
      path: "hello.sh",
      content: "#!/bin/sh\necho hello\n",
    });
    assert.equal(sh.ok, true);
  }
});

test("write_file allows an explicit bash script on Windows", async () => {
  if (process.platform !== "win32") return;
  registry.setRunContext({ goal: "Create a bash script named hello.sh that prints hello." });
  const sh = await registry.execute("write_file", {
    path: "hello.sh",
    content: BASH_HELLO,
  });
  assert.equal(sh.ok, true);
});
