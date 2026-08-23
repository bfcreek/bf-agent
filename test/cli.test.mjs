import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

function cli(...args) {
  return spawnSync(process.execPath, [path.join(root, "src", "cli.mjs"), ...args], {
    encoding: "utf8",
    cwd: root,
  });
}

test("--help prints usage, options, examples, and exit codes", () => {
  const run = cli("--help");
  assert.equal(run.status, 0);
  assert.match(run.stdout, /Usage:/);
  assert.match(run.stdout, /halo-agent serve/);
  for (const flag of ["--model", "--session", "--mcp", "--mode", "--version"]) {
    assert.ok(run.stdout.includes(flag), `help should document ${flag}`);
  }
  assert.match(run.stdout, /Examples:/);
  assert.match(run.stdout, /Exit codes:/);
});

test("-h is an alias for --help", () => {
  const run = cli("-h");
  assert.equal(run.status, 0);
  assert.match(run.stdout, /Usage:/);
});

test("--version prints the package version", () => {
  const run = cli("--version");
  assert.equal(run.status, 0);
  assert.equal(run.stdout.trim(), pkg.version);
});

test("no arguments is a usage error with help on stderr+stdout", () => {
  const run = cli();
  assert.equal(run.status, 1);
  assert.match(run.stderr, /No goal given/);
  assert.match(run.stdout, /Usage:/);
});

test("unknown options are rejected instead of silently joining the goal", () => {
  const run = cli("--modle", "llama3.2", "hello");
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Unknown option '--modle'/);
  assert.match(run.stderr, /--help/);
});

test("invalid option values are rejected with specific messages", () => {
  const badSteps = cli("hello", "--max-steps", "abc");
  assert.equal(badSteps.status, 1);
  assert.match(badSteps.stderr, /--max-steps needs a positive integer, got 'abc'/);

  const badMode = cli("hello", "--mode", "yolo");
  assert.equal(badMode.status, 1);
  assert.match(badMode.stderr, /--mode must be 'ask' or 'agent', got 'yolo'/);

  const badPort = cli("serve", "--port", "99999");
  assert.equal(badPort.status, 1);
  assert.match(badPort.stderr, /--port needs a number from 0 to 65535/);
});

test("a flag missing its value is reported", () => {
  const run = cli("hello", "--model");
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--model requires a value/);
});

test("multiple usage errors are all reported at once", () => {
  const run = cli("hello", "--mode", "yolo", "--max-steps", "0");
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--mode must be/);
  assert.match(run.stderr, /--max-steps needs/);
});

test("an unreachable Ollama exits with code 3 and a clear message", () => {
  const run = cli("hello", "--base-url", "http://127.0.0.1:9", "--quiet");
  assert.equal(run.status, 3);
  assert.match(run.stderr, /Cannot reach Ollama/);
});
