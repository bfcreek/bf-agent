/**
 * Eval tasks: each one sets up a temp workspace, states a goal, and checks
 * the outcome mechanically — no judge model. Tasks should be small enough
 * that a competent 3B–8B tool-calling model can pass them; failures then
 * point at the agent runtime, not at model capacity.
 *
 * @typedef {object} EvalTask
 * @property {string} name
 * @property {string} goal Prompt given to the agent.
 * @property {(dir: string) => Promise<void>} setup Populate the workspace.
 * @property {(dir: string, result: import("../src/agent-loop.mjs").AgentRunResult) => Promise<{pass: boolean, detail: string}>} check
 */

import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ok = (detail = "ok") => ({ pass: true, detail });
const fail = (detail) => ({ pass: false, detail });

/** @type {EvalTask[]} */
export const TASKS = [
  {
    name: "answer-from-readme",
    goal: "What port does the deploy server of this project use? Answer with just the number.",
    async setup(dir) {
      await writeFile(
        path.join(dir, "README.md"),
        "# Widget Service\n\nA demo service.\n\n## Deploy\n\nThe deploy server listens on port 4711.\n",
      );
    },
    async check(dir, result) {
      return result.text.includes("4711")
        ? ok()
        : fail(`answer did not contain 4711: ${JSON.stringify(result.text.slice(0, 200))}`);
    },
  },
  {
    name: "create-file",
    goal: "Create a file named hello.txt in the workspace root containing exactly the text: hello evals",
    async setup() {},
    async check(dir) {
      let text;
      try {
        text = await readFile(path.join(dir, "hello.txt"), "utf8");
      } catch {
        return fail("hello.txt was not created");
      }
      return text.trim() === "hello evals"
        ? ok()
        : fail(`hello.txt content was ${JSON.stringify(text.slice(0, 100))}`);
    },
  },
  {
    name: "edit-json",
    goal: "In config.json, change the value of \"debug\" to true. Do not change anything else.",
    async setup(dir) {
      await writeFile(
        path.join(dir, "config.json"),
        JSON.stringify({ name: "demo", debug: false, retries: 3 }, null, 2),
      );
    },
    async check(dir) {
      let config;
      try {
        config = JSON.parse(await readFile(path.join(dir, "config.json"), "utf8"));
      } catch (err) {
        return fail(`config.json unreadable or invalid JSON: ${err.message}`);
      }
      if (config.debug !== true) return fail(`debug is ${JSON.stringify(config.debug)}`);
      if (config.name !== "demo" || config.retries !== 3) {
        return fail("other keys were changed");
      }
      return ok();
    },
  },
  {
    name: "find-definition",
    goal: "Which file defines the function computeTax? Reply with the file's path relative to the workspace root.",
    async setup(dir) {
      await writeFile(path.join(dir, "index.mjs"), "import { computeTax } from './lib/tax.mjs';\nconsole.log(computeTax(100));\n");
      await writeFile(path.join(dir, "README.md"), "# Tax demo\n");
      const lib = path.join(dir, "lib");
      await (await import("node:fs/promises")).mkdir(lib, { recursive: true });
      await writeFile(path.join(lib, "tax.mjs"), "export function computeTax(amount) {\n  return amount * 0.2;\n}\n");
      await writeFile(path.join(lib, "util.mjs"), "export const noop = () => {};\n");
    },
    async check(dir, result) {
      const normalized = result.text.replaceAll("\\", "/");
      return normalized.includes("lib/tax.mjs")
        ? ok()
        : fail(`answer did not name lib/tax.mjs: ${JSON.stringify(result.text.slice(0, 200))}`);
    },
  },
  {
    name: "run-command",
    goal: "Run 'node --version' with the shell tool and tell me the version it printed.",
    async setup() {},
    async check(dir, result) {
      const version = process.version; // the eval runs under the same node
      return result.text.includes(version)
        ? ok()
        : fail(`answer did not contain ${version}: ${JSON.stringify(result.text.slice(0, 200))}`);
    },
  },
  {
    name: "fix-failing-test",
    goal: "Run 'node test.mjs'. It fails because of a bug in add.mjs. Fix the bug so the test passes, then confirm by running it again.",
    async setup(dir) {
      await writeFile(path.join(dir, "add.mjs"), "export function add(a, b) {\n  return a - b;\n}\n");
      await writeFile(
        path.join(dir, "test.mjs"),
        [
          "import assert from 'node:assert/strict';",
          "import { add } from './add.mjs';",
          "assert.equal(add(2, 3), 5);",
          "console.log('test passed');",
        ].join("\n"),
      );
    },
    async check(dir) {
      const run = spawnSync(process.execPath, ["test.mjs"], { cwd: dir, encoding: "utf8" });
      return run.status === 0
        ? ok()
        : fail(`node test.mjs still fails: ${(run.stderr || run.stdout).slice(0, 200)}`);
    },
  },
];
