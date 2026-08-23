import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
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

function cliAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "src", "cli.mjs"), ...args], {
      encoding: "utf8",
      cwd: root,
      env: options.env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("--help prints usage, options, examples, and exit codes", () => {
  const run = cli("--help");
  assert.equal(run.status, 0);
  assert.match(run.stdout, /Usage:/);
  assert.match(run.stdout, /halo-agent serve/);
  assert.match(run.stdout, /halo-agent models/);
  for (const flag of ["--model", "--session", "--mcp", "--mode", "--terran", "--ns", "--web", "--version", "--json"]) {
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

test("models reports compliance for installed Ollama models", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          models: [{ name: "qwen3-coder:30b" }, { name: "gemma3:12b" }],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const run = await cliAsync(["models", "--base-url", `http://127.0.0.1:${port}`]);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /compliant \(tool-capable\):/);
    assert.match(run.stdout, /qwen3-coder:30b/);
    assert.match(run.stdout, /not compliant:/);
    assert.match(run.stdout, /gemma3:12b/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("models --json prints structured compliance data", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "llama3.2" }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const run = await cliAsync(["models", "--json", "--base-url", `http://127.0.0.1:${port}`]);
    assert.equal(run.status, 0);
    const body = JSON.parse(run.stdout);
    assert.equal(body.baseUrl, `http://127.0.0.1:${port}`);
    assert.deepEqual(body.compliant, ["llama3.2"]);
    assert.deepEqual(body.notCompliant, []);
    assert.deepEqual(body.unknown, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("models exits with code 3 when Ollama is unreachable", () => {
  const run = cli("models", "--base-url", "http://127.0.0.1:9");
  assert.equal(run.status, 3);
  assert.match(run.stderr, /Cannot reach Ollama/);
});

test("--help documents config edit and the config file", () => {
  const run = cli("--help");
  assert.equal(run.status, 0);
  assert.match(run.stdout, /halo-agent config edit/);
  assert.match(run.stdout, /config\.yaml/);
});

test("config values apply when CLI does not override them", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-agent-cli-config-"));
  const configPath = path.join(dir, "config.yaml");
  await writeFile(
    configPath,
    `base-url: http://127.0.0.1:9
max-steps: 1
`,
    "utf8",
  );
  try {
    const run = spawnSync(
      process.execPath,
      [path.join(root, "src", "cli.mjs"), "hello", "--quiet"],
      {
        encoding: "utf8",
        cwd: root,
        env: { ...process.env, HALO_AGENT_CONFIG: configPath },
      },
    );
    assert.equal(run.status, 3);
    assert.match(run.stderr, /Cannot reach Ollama at http:\/\/127\.0\.0\.1:9/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI flags override config values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-agent-cli-config-"));
  const configPath = path.join(dir, "config.yaml");
  await writeFile(configPath, "base-url: http://127.0.0.1:9\n", "utf8");
  try {
    const run = spawnSync(
      process.execPath,
      [path.join(root, "src", "cli.mjs"), "hello", "--base-url", "http://127.0.0.1:8", "--quiet"],
      {
        encoding: "utf8",
        cwd: root,
        env: { ...process.env, HALO_AGENT_CONFIG: configPath },
      },
    );
    assert.equal(run.status, 3);
    assert.match(run.stderr, /Cannot reach Ollama at http:\/\/127\.0\.0\.1:8/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid config values are reported before running", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-agent-cli-config-"));
  const configPath = path.join(dir, "config.yaml");
  await writeFile(configPath, "max-steps: abc\n", "utf8");
  try {
    const run = spawnSync(
      process.execPath,
      [path.join(root, "src", "cli.mjs"), "hello"],
      {
        encoding: "utf8",
        cwd: root,
        env: { ...process.env, HALO_AGENT_CONFIG: configPath },
      },
    );
    assert.equal(run.status, 1);
    assert.match(run.stderr, /config 'max-steps'/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("config edit creates the config file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-agent-cli-config-"));
  const configPath = path.join(dir, "config.yaml");
  const editorPath = path.join(dir, "fake-editor.mjs");
  await writeFile(
    editorPath,
    `import { readFileSync } from "node:fs";
console.log(readFileSync(process.argv[2], "utf8").includes("halo-agent user configuration") ? "ok" : "bad");
`,
    "utf8",
  );
  try {
    const run = spawnSync(
      process.execPath,
      [path.join(root, "src", "cli.mjs"), "config", "edit"],
      {
        encoding: "utf8",
        cwd: root,
        env: {
          ...process.env,
          HALO_AGENT_CONFIG: configPath,
          EDITOR: `"${process.execPath}" "${editorPath}"`,
        },
      },
    );
    assert.equal(run.status, 0);
    assert.match(run.stdout, /ok/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
