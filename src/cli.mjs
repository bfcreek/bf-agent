#!/usr/bin/env node
/**
 * halo-agent CLI.
 *
 * Run one goal:   node src/cli.mjs "what time is it?" [--model llama3.2] [...]
 * Serve OpenAI:   node src/cli.mjs serve [--port 11435] [...]
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

import { AgentLoop, DEFAULT_SYSTEM_PROMPT } from "./agent-loop.mjs";
import { buildSystemPrompt } from "./context-builder.mjs";
import { buildProjectContext } from "./project-index.mjs";
import { McpClient, registerMcpTools } from "./mcp-client.mjs";
import {
  ModelRoutingError,
  resolveModelDetected,
  assertToolCapable,
  listClassifiedModelsDetected,
} from "./model-routing.mjs";
import { DEFAULT_NUM_CTX, OllamaClient, OllamaClientError } from "./ollama-client.mjs";
import { createOpenAIServer } from "./openai-server.mjs";
import { SessionStore } from "./session-store.mjs";
import { ToolRegistry } from "./tool-registry.mjs";
import { registerBuiltinTools } from "./tools/builtin.mjs";

function parseArgs(argv) {
  const options = {
    model: "llama3.2",
    baseUrl: "http://127.0.0.1:11434",
    maxSteps: 10,
    numCtx: DEFAULT_NUM_CTX,
    quiet: false,
    cwd: process.cwd(),
    port: 11435,
    // Interactive terminals gate writes/shell behind a prompt; piped or
    // headless runs cannot prompt, so they run unattended.
    mode: process.stdin.isTTY && process.stderr.isTTY ? "ask" : "agent",
    mcp: [],
    embedModel: "nomic-embed-text",
    noIndex: false,
    json: false,
    goal: "",
    errors: [],
  };
  const positional = [];

  const value = (flag, i) => {
    const v = argv[i];
    if (v === undefined) options.errors.push(`${flag} requires a value.`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--model":
        options.model = value(arg, ++i) ?? options.model;
        break;
      case "--base-url":
        options.baseUrl = value(arg, ++i) ?? options.baseUrl;
        break;
      case "--max-steps": {
        const raw = value(arg, ++i);
        const n = Number.parseInt(raw ?? "", 10);
        if (Number.isFinite(n) && n > 0) options.maxSteps = n;
        else if (raw !== undefined) options.errors.push(`--max-steps needs a positive integer, got '${raw}'.`);
        break;
      }
      case "--num-ctx": {
        const raw = value(arg, ++i);
        const n = Number.parseInt(raw ?? "", 10);
        if (Number.isFinite(n) && n > 0) options.numCtx = n;
        else if (raw !== undefined) options.errors.push(`--num-ctx needs a positive integer, got '${raw}'.`);
        break;
      }
      case "--quiet":
        options.quiet = true;
        break;
      case "--cwd": {
        const raw = value(arg, ++i);
        if (raw !== undefined) options.cwd = path.resolve(raw);
        break;
      }
      case "--port": {
        const raw = value(arg, ++i);
        const p = Number.parseInt(raw ?? "", 10);
        if (Number.isFinite(p) && p >= 0 && p <= 65535) options.port = p;
        else if (raw !== undefined) options.errors.push(`--port needs a number from 0 to 65535, got '${raw}'.`);
        break;
      }
      case "--mode": {
        const mode = value(arg, ++i);
        if (mode === "ask" || mode === "agent") options.mode = mode;
        else if (mode !== undefined) options.errors.push(`--mode must be 'ask' or 'agent', got '${mode}'.`);
        break;
      }
      case "--session": {
        const name = value(arg, ++i);
        if (name !== undefined) options.session = name;
        break;
      }
      case "--mcp": {
        const spec = value(arg, ++i);
        if (spec !== undefined) options.mcp.push(spec);
        break;
      }
      case "--embed-model": {
        const name = value(arg, ++i);
        if (name !== undefined) options.embedModel = name;
        break;
      }
      case "--no-index":
        options.noIndex = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--version":
      case "-v":
        options.version = true;
        break;
      case "--":
        positional.push(...argv.slice(i + 1));
        i = argv.length;
        break;
      default:
        if (arg.startsWith("-")) {
          options.errors.push(`Unknown option '${arg}'.`);
        } else {
          positional.push(arg);
        }
    }
  }

  if (positional[0] === "serve") {
    options.serve = true;
    positional.shift();
  }
  if (positional[0] === "models") {
    options.listModels = true;
    positional.shift();
  }
  options.goal = positional.join(" ").trim();
  return options;
}

const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

function printHelp() {
  console.log(`halo-agent v${VERSION} - local agent loop on Ollama

Usage:
  halo-agent "<goal>" [options]     Run one goal and print the answer
  halo-agent serve [options]        OpenAI-compatible server (/v1/chat/completions)
  halo-agent models [options]       List installed Ollama models and tool compliance

Options:
  --model <name>       Ollama model (default llama3.2)
  --base-url <url>     Ollama server (default http://127.0.0.1:11434)
  --max-steps <n>      Max model round-trips (default 10)
  --num-ctx <n>        Context window in tokens sent to Ollama (default ${DEFAULT_NUM_CTX})
  --cwd <path>         Workspace root for file/shell tools (default: current directory)
  --mode <ask|agent>   ask: confirm writes/shell commands (default in a terminal)
                       agent: run them unattended (default when not a TTY, and in serve mode)
  --session <name>     Persist/resume this conversation (.halo-agent/sessions/ in the workspace)
  --mcp "<command>"    Attach an MCP server (stdio); repeatable. Tools appear as mcp_<name>
  --embed-model <name> Embedding model for project index (default nomic-embed-text)
  --no-index           Skip building the local project vector index
  --port <n>           Port for serve mode (default 11435)
  --quiet              Only print the final answer
  --json               JSON output (models command)
  --                   Treat everything after as the goal, even if it starts with -
  -v, --version        Print the version
  -h, --help           Show this help

Examples:
  halo-agent "what time is it?"
  halo-agent "summarize src/agent-loop.mjs" --model qwen3-coder:30b
  halo-agent "fix the failing test" --session fix-tests --mode agent
  halo-agent serve --port 11435
  halo-agent models
  halo-agent models --json --base-url http://127.0.0.1:11434
  halo-agent "search my notes for X" --mcp "npx -y some-mcp-server"

Exit codes:
  0  success        1  usage error      2  stopped at max steps
  3  Ollama error   4  MCP attach failed`);
}

function makeProjectBootstrap(options, client) {
  return {
    workspaceRoot: options.cwd,
    client: options.noIndex ? undefined : client,
    embeddingModel: options.embedModel,
    onProgress: options.quiet ? undefined : (msg) => console.error(`[index] ${msg}`),
  };
}

function makeApprovalPrompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const handler = async ({ name, args }) => {
    let preview = JSON.stringify(args);
    if (preview.length > 200) preview = `${preview.slice(0, 200)}...`;
    const answer = await rl.question(`allow ${name} ${preview}? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  };
  return { handler, close: () => rl.close() };
}

function printClassifiedModels({ baseUrl, classified, json }) {
  if (json) {
    console.log(
      JSON.stringify(
        {
          baseUrl,
          compliant: classified.compliant,
          notCompliant: classified.notCompliant,
          unknown: classified.unknown,
        },
        null,
        2,
      ),
    );
    return;
  }

  const lines = [`Ollama models at ${baseUrl}:`, ""];
  const section = (title, names) => {
    lines.push(`${title}:`);
    if (names.length === 0) lines.push("  (none)");
    else for (const name of names) lines.push(`  ${name}`);
    lines.push("");
  };
  section("compliant (tool-capable)", classified.compliant);
  section("not compliant", classified.notCompliant);
  section("unknown", classified.unknown);
  console.log(lines.join("\n").trimEnd());
}

async function listOllamaModels(options) {
  const client = new OllamaClient({ baseUrl: options.baseUrl, model: options.model });
  try {
    const installed = await client.listModels();
    const classified = await listClassifiedModelsDetected(client, installed);
    printClassifiedModels({ baseUrl: options.baseUrl, classified, json: options.json });
  } catch (err) {
    if (err instanceof OllamaClientError) {
      console.error(err.message);
      process.exitCode = 3;
      return;
    }
    throw err;
  }
}

function describeStep(step) {
  if (step.kind === "final") return;
  for (const call of step.toolCalls) {
    const status = call.ok ? "ok" : `error: ${call.error}`;
    console.error(`[step ${step.index}] ${call.name}(${JSON.stringify(call.args)}) -> ${status}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.version) {
    console.log(VERSION);
    return;
  }
  if (options.help) {
    printHelp();
    return;
  }
  if (options.errors.length > 0) {
    for (const error of options.errors) console.error(error);
    console.error("Run 'halo-agent --help' for usage.");
    process.exitCode = 1;
    return;
  }
  if (!options.goal && !options.serve && !options.listModels) {
    console.error("No goal given.");
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (options.listModels) {
    await listOllamaModels(options);
    return;
  }

  const client = new OllamaClient({
    baseUrl: options.baseUrl,
    model: options.model,
    numCtx: options.numCtx,
  });

  // Route to an installed, tool-capable model up front; skip silently when
  // Ollama is unreachable — the run itself will surface that error clearly.
  try {
    const installed = await client.listModels();
    const routed = await resolveModelDetected({ requested: options.model, installed, client });
    for (const warning of routed.warnings) console.error(warning);
    client.model = routed.model;
    options.model = routed.model;
  } catch (err) {
    if (err instanceof ModelRoutingError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    try {
      assertToolCapable(options.model);
    } catch (routingErr) {
      console.error(routingErr.message);
      process.exitCode = 1;
      return;
    }
    // Ollama unreachable — fall through; the run itself will surface that error.
  }

  const registry = registerBuiltinTools(new ToolRegistry(), {
    workspaceRoot: options.cwd,
    searchClient: options.noIndex ? undefined : client,
    embeddingModel: options.embedModel,
  });

  const mcpClients = [];
  for (const spec of options.mcp) {
    try {
      const mcp = await McpClient.connect({
        command: spec,
        onStderr: options.quiet ? undefined : (line) => console.error(`[mcp] ${line}`),
      });
      mcpClients.push(mcp);
      const names = await registerMcpTools(registry, mcp);
      if (!options.quiet) {
        console.error(`[mcp] ${mcp.serverInfo?.name ?? spec}: ${names.join(", ") || "(no tools)"}`);
      }
    } catch (err) {
      console.error(`Failed to attach MCP server '${spec}': ${err.message}`);
      process.exitCode = 4;
      for (const mcp of mcpClients) await mcp.close();
      return;
    }
  }

  const projectContext = await buildProjectContext({
    workspaceRoot: options.cwd,
    client: options.noIndex ? undefined : client,
    embeddingModel: options.embedModel,
    index: !options.noIndex,
    onProgress: options.quiet ? undefined : (msg) => console.error(`[index] ${msg}`),
  });

  const systemPrompt = await buildSystemPrompt({
    basePrompt: DEFAULT_SYSTEM_PROMPT,
    workspaceRoot: options.cwd,
    projectContext,
  });

  if (options.serve) {
    const server = createOpenAIServer({
      client,
      registry,
      systemPrompt,
      maxSteps: options.maxSteps,
      defaultModel: options.model,
      projectBootstrap: makeProjectBootstrap(options, client),
    });
    server.listen(options.port, () => {
      const { port } = server.address();
      console.error(`halo-agent serving OpenAI-compatible API on http://127.0.0.1:${port}/v1`);
      console.error(`workspace: ${options.cwd} | model: ${options.model} | ollama: ${options.baseUrl}`);
    });
    return;
  }

  let approval;
  if (options.mode === "ask") {
    approval = makeApprovalPrompt();
    registry.setApprovalHandler(approval.handler);
  }

  const loop = new AgentLoop({
    client,
    registry,
    systemPrompt,
    maxSteps: options.maxSteps,
    onStep: options.quiet ? undefined : describeStep,
    compaction: {},
    projectBootstrap: makeProjectBootstrap(options, client),
    onBootstrap: options.quiet
      ? undefined
      : ({ readme, ragHits }) => {
          const parts = [];
          if (readme) parts.push("README");
          if (ragHits > 0) parts.push(`${ragHits} indexed passage(s)`);
          if (parts.length > 0) console.error(`[bootstrap] auto-retrieved ${parts.join(" + ")}`);
        },
  });

  let store;
  let priorSession = null;
  if (options.session) {
    store = new SessionStore({ workspaceRoot: options.cwd });
    priorSession = await store.load(options.session);
    if (priorSession && !options.quiet) {
      console.error(
        `[session ${options.session}] resuming: ${priorSession.messages.length} messages, ${priorSession.steps.length} steps so far`,
      );
    }
  }

  try {
    const result = await loop.run(options.goal, {
      history: priorSession?.messages,
    });

    if (store) {
      const saved = store.merge(options.session, priorSession, result);
      await store.save(options.session, saved);
      if (!options.quiet && saved.changedFiles.length > 0) {
        console.error(`[session ${options.session}] files changed: ${saved.changedFiles.join(", ")}`);
      }
    }

    if (result.stopReason === "max-steps") {
      console.error(
        `Stopped after ${options.maxSteps} steps; the answer below may be incomplete (raise --max-steps to allow more).`,
      );
      if (result.text) console.log(result.text);
      process.exitCode = 2;
      return;
    }
    console.log(result.text);
  } catch (err) {
    if (err instanceof OllamaClientError) {
      console.error(err.message);
      process.exitCode = 3;
      return;
    }
    throw err;
  } finally {
    approval?.close();
    for (const mcp of mcpClients) await mcp.close();
  }
}

await main();
