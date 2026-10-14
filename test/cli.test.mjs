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
    env: { ...process.env, HALO_AGENT_FORCE_INTERACTIVE: "" },
  });
}

function cliAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "src", "cli.mjs"), ...args], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, HALO_AGENT_FORCE_INTERACTIVE: "", ...(options.env ?? {}) },
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
  assert.match(run.stdout, /Interactive terminal mode/);
  assert.match(run.stdout, /bf-agent serve/);
  assert.match(run.stdout, /bf-agent models/);
  for (const flag of ["--model", "--session", "--mcp", "--mode", "--auto-approve", "--no-auto-approve", "--version", "--json", "--no-checkpoints"]) {
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

test("no arguments is a usage error when stdin is not a TTY", () => {
  const run = cli();
  assert.equal(run.status, 1);
  assert.match(run.stderr, /No goal given/);
  assert.match(run.stdout, /Usage:/);
});

test("interactive mode accepts prompts until /quit", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          models: [
            {
              name: "qwen3:30b",
              size: 20_000_000_000,
              details: { parameter_size: "30B" },
            },
          ],
        }),
      );
      return;
    }
    if (req.url === "/api/show") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ capabilities: ["tools", "thinking"] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const child = spawn(
      process.execPath,
      [path.join(root, "src", "cli.mjs"), "--no-index", "--quiet", "--base-url", `http://127.0.0.1:${port}`],
      {
        cwd: root,
        env: {
          ...process.env,
          HALO_AGENT_FORCE_INTERACTIVE: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let phase = 0;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (phase === 1 && stdout.includes("Interactive commands")) {
        phase = 2;
        child.stdin.write("/quit\n");
        child.stdin.end();
      }
    });
    let sent = false;
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (!sent && stderr.includes("Enter a prompt")) {
        sent = true;
        phase = 1;
        child.stdin.write("/help\n");
      }
    });
    const status = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(status, 0);
    assert.match(stderr, /interactive/);
    assert.match(stdout, /Interactive commands:/);
    assert.match(stdout, /\/quit/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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

  const badWallClock = cli("hello", "--wall-clock", "soon");
  assert.equal(badWallClock.status, 1);
  assert.match(badWallClock.stderr, /--wall-clock needs a positive integer \(seconds\), got 'soon'/);

  const badBudget = cli("hello", "--max-prompt-tokens", "lots");
  assert.equal(badBudget.status, 1);
  assert.match(badBudget.stderr, /--max-prompt-tokens needs a positive integer, got 'lots'/);
});

test("--wall-clock, --max-prompt-tokens, and --streak-nudge are documented in help", () => {
  const run = cli("--help");
  assert.equal(run.status, 0);
  assert.match(run.stdout, /--wall-clock <sec>/);
  assert.match(run.stdout, /HALO_WALL_CLOCK_SECONDS/);
  assert.match(run.stdout, /--max-prompt-tokens <n>/);
  assert.match(run.stdout, /--streak-nudge \[n\]/);
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

test("--auto-approve accepts all, a tool list, or off", () => {
  const all = cli("hello", "--auto-approve", "--no-index", "--base-url", "http://127.0.0.1:9");
  assert.equal(all.status, 3);
  assert.match(all.stderr, /auto-approving all gated tools/);

  const listed = cli(
    "hello",
    "--auto-approve",
    "write_file,run_command",
    "--no-index",
    "--base-url",
    "http://127.0.0.1:9",
  );
  assert.equal(listed.status, 3);
  assert.match(listed.stderr, /auto-approving write_file, run_command/);

  const off = cli("hello", "--auto-approve", "--no-auto-approve", "--no-index", "--base-url", "http://127.0.0.1:9");
  assert.equal(off.status, 3);
  assert.doesNotMatch(off.stderr, /auto-approving/);
});

test("--auto-approve rejects a policy that is not all, off, or tool names", () => {
  const run = cli("hello", "--auto-approve", "write file");
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--auto-approve needs all, off/);
  assert.match(run.stderr, /write file/);
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

test("--help documents config edit, models config, and tier flags", () => {
  const run = cli("--help");
  assert.equal(run.status, 0);
  assert.match(run.stdout, /bf-agent config edit/);
  assert.match(run.stdout, /bf-agent models config edit/);
  assert.match(run.stdout, /models\.yaml/);
  assert.match(run.stdout, /--tier-preset/);
  assert.match(run.stdout, /cloud-max/);
  assert.match(run.stdout, /--tier/);
});

test("--help documents config edit and the config file", () => {
  const run = cli("--help");
  assert.equal(run.status, 0);
  assert.match(run.stdout, /bf-agent config edit/);
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

test("models config edit creates models.yaml", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-agent-models-config-"));
  const configPath = path.join(dir, "models.yaml");
  const editorPath = path.join(dir, "fake-editor.mjs");
  await writeFile(
    editorPath,
    `import { readFileSync } from "node:fs";
console.log(readFileSync(process.argv[2], "utf8").includes("Bitfield Ollama Agent model routing") ? "ok" : "bad");
`,
    "utf8",
  );
  try {
    const run = spawnSync(
      process.execPath,
      [path.join(root, "src", "cli.mjs"), "models", "config", "edit"],
      {
        encoding: "utf8",
        cwd: root,
        env: {
          ...process.env,
          HALO_MODELS_CONFIG: configPath,
          EDITOR: `"${process.execPath}" "${editorPath}"`,
        },
      },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /ok/);
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
console.log(readFileSync(process.argv[2], "utf8").includes("Bitfield Ollama Agent user configuration") ? "ok" : "bad");
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
