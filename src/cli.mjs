#!/usr/bin/env node
/**
 * halo-agent CLI: run one goal through the agent loop against local Ollama.
 *
 *   node src/cli.mjs "what time is it?" [--model llama3.2] [--max-steps 10]
 *                    [--base-url http://127.0.0.1:11434] [--quiet]
 */

import path from "node:path";

import { AgentLoop } from "./agent-loop.mjs";
import { OllamaClient, OllamaClientError } from "./ollama-client.mjs";
import { ToolRegistry } from "./tool-registry.mjs";
import { registerBuiltinTools } from "./tools/builtin.mjs";

function parseArgs(argv) {
  const options = {
    model: "llama3.2",
    baseUrl: "http://127.0.0.1:11434",
    maxSteps: 10,
    quiet: false,
    cwd: process.cwd(),
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
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        positional.push(arg);
    }
  }

  options.goal = positional.join(" ").trim();
  return options;
}

function printHelp() {
  console.log(`halo-agent - local agent loop on Ollama

Usage: halo-agent "<goal>" [options]

Options:
  --model <name>       Ollama model (default llama3.2)
  --base-url <url>     Ollama server (default http://127.0.0.1:11434)
  --max-steps <n>      Max model round-trips (default 10)
  --cwd <path>         Workspace root for file/shell tools (default: current directory)
  --quiet              Only print the final answer
  -h, --help           Show this help`);
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
  if (options.help || !options.goal) {
    printHelp();
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const client = new OllamaClient({ baseUrl: options.baseUrl, model: options.model });
  const registry = registerBuiltinTools(new ToolRegistry(), { workspaceRoot: options.cwd });
  const loop = new AgentLoop({
    client,
    registry,
    maxSteps: options.maxSteps,
    onStep: options.quiet ? undefined : describeStep,
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
  }
}

await main();
