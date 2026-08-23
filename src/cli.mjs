#!/usr/bin/env node
/**
 * halo-agent CLI.
 *
 * Run one goal:   node src/cli.mjs "what time is it?" [--model llama3.2] [...]
 * Serve OpenAI:   node src/cli.mjs serve [--port 11435] [...]
 */

import path from "node:path";
import readline from "node:readline/promises";

import { AgentLoop, DEFAULT_SYSTEM_PROMPT } from "./agent-loop.mjs";
import { buildSystemPrompt } from "./context-builder.mjs";
import { OllamaClient, OllamaClientError } from "./ollama-client.mjs";
import { createOpenAIServer } from "./openai-server.mjs";
import { ToolRegistry } from "./tool-registry.mjs";
import { registerBuiltinTools } from "./tools/builtin.mjs";

function parseArgs(argv) {
  const options = {
    model: "llama3.2",
    baseUrl: "http://127.0.0.1:11434",
    maxSteps: 10,
    quiet: false,
    cwd: process.cwd(),
    port: 11435,
    // Interactive terminals gate writes/shell behind a prompt; piped or
    // headless runs cannot prompt, so they run unattended.
    mode: process.stdin.isTTY && process.stderr.isTTY ? "ask" : "agent",
    goal: "",
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--model":
        options.model = argv[++i] ?? options.model;
        break;
      case "--base-url":
        options.baseUrl = argv[++i] ?? options.baseUrl;
        break;
      case "--max-steps": {
        const n = Number.parseInt(argv[++i] ?? "", 10);
        if (Number.isFinite(n) && n > 0) options.maxSteps = n;
        break;
      }
      case "--quiet":
        options.quiet = true;
        break;
      case "--cwd":
        options.cwd = path.resolve(argv[++i] ?? options.cwd);
        break;
      case "--port": {
        const p = Number.parseInt(argv[++i] ?? "", 10);
        if (Number.isFinite(p) && p >= 0 && p <= 65535) options.port = p;
        break;
      }
      case "--mode": {
        const mode = argv[++i];
        if (mode === "ask" || mode === "agent") options.mode = mode;
        break;
      }
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        positional.push(arg);
    }
  }

  if (positional[0] === "serve") {
    options.serve = true;
    positional.shift();
  }
  options.goal = positional.join(" ").trim();
  return options;
}

function printHelp() {
  console.log(`halo-agent - local agent loop on Ollama

Usage:
  halo-agent "<goal>" [options]     Run one goal and print the answer
  halo-agent serve [options]        OpenAI-compatible server (/v1/chat/completions)

Options:
  --model <name>       Ollama model (default llama3.2)
  --base-url <url>     Ollama server (default http://127.0.0.1:11434)
  --max-steps <n>      Max model round-trips (default 10)
  --cwd <path>         Workspace root for file/shell tools (default: current directory)
  --mode <ask|agent>   ask: confirm writes/shell commands (default in a terminal)
                       agent: run them unattended (default when not a TTY, and in serve mode)
  --port <n>           Port for serve mode (default 11435)
  --quiet              Only print the final answer
  -h, --help           Show this help`);
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

function describeStep(step) {
  if (step.kind === "final") return;
  for (const call of step.toolCalls) {
    const status = call.ok ? "ok" : `error: ${call.error}`;
    console.error(`[step ${step.index}] ${call.name}(${JSON.stringify(call.args)}) -> ${status}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || (!options.goal && !options.serve)) {
    printHelp();
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const client = new OllamaClient({ baseUrl: options.baseUrl, model: options.model });
  const registry = registerBuiltinTools(new ToolRegistry(), { workspaceRoot: options.cwd });
  const systemPrompt = await buildSystemPrompt({
    basePrompt: DEFAULT_SYSTEM_PROMPT,
    workspaceRoot: options.cwd,
  });

  if (options.serve) {
    const server = createOpenAIServer({
      client,
      registry,
      systemPrompt,
      maxSteps: options.maxSteps,
      defaultModel: options.model,
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
  });

  try {
    const result = await loop.run(options.goal);
    if (result.stopReason === "max-steps") {
      console.error(`Stopped after ${options.maxSteps} steps without a final answer.`);
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
  }
}

await main();
