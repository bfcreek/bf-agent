#!/usr/bin/env node
/**
 * bf-agent CLI.
 *
 * Run one goal:   node src/cli.mjs "what time is it?" [--model llama3.2] [...]
 * Interactive:    node src/cli.mjs   (TTY, no arguments — prompt until /quit)
 * Serve OpenAI:   node src/cli.mjs serve [--port 11435] [...]
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

import { AgentLoop, DEFAULT_MAX_STEPS, DEFAULT_SYSTEM_PROMPT } from "./agent-loop.mjs";
import { CheckpointStore } from "./checkpoints.mjs";
import { buildSystemPrompt } from "./context-builder.mjs";
import { ensureProjectIndex } from "./project-index.mjs";
import { formatMcpToolIndex, McpClient, registerMcpTools } from "./mcp-client.mjs";
import {
  ModelRoutingError,
  resolveModelAuto,
  assertToolCapable,
  listClassifiedModelsDetected,
  suggestModel,
} from "./model-routing.mjs";
import { configureClientModel, modelPromptOverlay } from "./model-tuning.mjs";
import { DEFAULT_NUM_CTX, OllamaClient, OllamaClientError } from "./ollama-client.mjs";
import { createOpenAIServer } from "./openai-server.mjs";
import { SessionStore } from "./session-store.mjs";
import { ToolRegistry } from "./tool-registry.mjs";
import { registerBuiltinTools } from "./tools/builtin.mjs";
import {
  applyConfigToDefaults,
  ensureConfigFile,
  getBuiltinDefaults,
  getConfigPath,
  loadUserConfig,
  openConfigInEditor,
} from "./user-config.mjs";
import {
  DEFAULT_TASK_TIER,
  ensureModelsConfigFile,
  getModelsConfigPath,
  loadModelsConfig,
  openConfigInEditor as openModelsConfigInEditor,
  resolveCliModel,
} from "./models-config.mjs";
import { parseTierPresetArg, resolveEffectiveTierModels, applyTierPresetPolicy, coerceTierPresetModel, getTierPresetPolicy, TIER_PRESET_HELP } from "./tier-models.mjs";

/**
 * Wall-clock budget for the agent loop, in ms. `--wall-clock` wins over
 * HALO_WALL_CLOCK_SECONDS. The budget is measured from process start (an
 * external supervisor's timer already started), so startup time is subtracted.
 * @param {{wallClockSeconds?: number}} options
 * @param {{env?: NodeJS.ProcessEnv, uptimeMs?: number}} [runtime]
 * @returns {number} 0 when no budget applies.
 */
export function resolveWallClockMs(options, { env = process.env, uptimeMs = process.uptime() * 1000 } = {}) {
  let seconds = options.wallClockSeconds;
  if (!(Number.isFinite(seconds) && seconds > 0)) {
    const raw = env.HALO_WALL_CLOCK_SECONDS;
    const n = Number.parseInt(String(raw ?? ""), 10);
    seconds = Number.isFinite(n) && n > 0 ? n : 0;
  }
  if (!seconds) return 0;
  // Never hand the loop a zero/negative budget; a tiny one still makes it wrap up.
  return Math.max(1_000, seconds * 1000 - uptimeMs);
}

function parseArgs(argv, initial = getBuiltinDefaults()) {
  const options = {
    ...initial,
    mcp: [...(initial.mcp ?? [])],
    errors: [],
  };
  const positional = [];
  let mcpFromCli = false;

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
      case "--tier-preset": {
        const raw = value(arg, ++i);
        if (raw !== undefined) {
          try {
            options.tierPreset = parseTierPresetArg(raw);
          } catch (err) {
            options.errors.push(err.message);
          }
        }
        break;
      }
      case "--tier": {
        const raw = value(arg, ++i);
        const n = Number.parseInt(raw ?? "", 10);
        if (Number.isFinite(n) && n >= 0 && n <= 6) options.taskTier = n;
        else if (raw !== undefined) options.errors.push(`--tier needs an integer from 0 to 6, got '${raw}'.`);
        break;
      }
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
      case "--wall-clock": {
        const raw = value(arg, ++i);
        const n = Number.parseInt(raw ?? "", 10);
        if (Number.isFinite(n) && n > 0) options.wallClockSeconds = n;
        else if (raw !== undefined) options.errors.push(`--wall-clock needs a positive integer (seconds), got '${raw}'.`);
        break;
      }
      case "--quiet":
        options.quiet = true;
        break;
      case "--no-checkpoints":
        options.noCheckpoints = true;
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
        if (spec !== undefined) {
          if (!mcpFromCli) {
            options.mcp = [];
            mcpFromCli = true;
          }
          options.mcp.push(spec);
        }
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
      case "--think": {
        const level = value(arg, ++i);
        if (level === "auto" || level === "true" || level === "false" || level === "off") {
          options.think = level === "false" || level === "off" ? false : level;
        } else if (level === "low" || level === "medium" || level === "high" || level === "max") {
          options.think = level;
        } else if (level !== undefined) {
          options.errors.push(
            `--think must be auto, true, false, off, or low|medium|high|max, got '${level}'.`,
          );
        }
        options.thinkExplicit = true;
        break;
      }
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
  if (positional[0] === "checkpoints") {
    positional.shift();
    options.checkpointsCommand = positional.shift() ?? "list";
    options.checkpointsRunId = positional.shift();
  }
  if (positional[0] === "models") {
    positional.shift();
    if (positional[0] === "config") {
      positional.shift();
      if (positional[0] === "edit") {
        options.modelsConfigEdit = true;
        positional.shift();
      } else {
        options.modelsConfigCommand = true;
      }
    } else {
      options.listModels = true;
    }
  }
  if (positional[0] === "config") {
    options.configCommand = true;
    positional.shift();
    if (positional[0] === "edit") {
      options.configEdit = true;
      positional.shift();
    }
  }
  options.goal = positional.join(" ").trim();
  coerceTierPresetModel(options);
  return options;
}

const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

function printHelp() {
  console.log(`Bitfield Agent (bf-agent) v${VERSION} - local agent loop on Ollama

Usage:
  bf-agent                        Interactive terminal mode (TTY only)
  bf-agent "<goal>" [options]     Run one goal and print the answer
  bf-agent serve [options]        OpenAI-compatible server (/v1/chat/completions)
  bf-agent models [options]       List installed Ollama models and tool compliance
  bf-agent models config edit       Create or open the model-routing config (models.yaml)
  bf-agent config edit              Create or open the general user config (config.yaml)
  bf-agent checkpoints [list|restore <run-id>]  File snapshots taken before edits

Config:
  General defaults: ${getConfigPath()} (YAML)
  Model routing:    ${getModelsConfigPath()} (YAML — tier presets, bands, vision models)
  Keys match CLI flag names (without --). Command-line flags override config values.

Options:
  --model <name|auto|tier>  Ollama model. Default auto: with models.yaml, picks the band
                       for --tier (default from models.yaml); without models.yaml, strongest
                       installed model with thinking + tools that fits in memory
  --tier-preset <name> Preset for model routing: ${TIER_PRESET_HELP}
  --tier <n>           Task difficulty 0–6 for model routing (default from models.yaml)
  --base-url <url>     Ollama server (default http://127.0.0.1:11434)
  --max-steps <n>      Max model round-trips (default ${DEFAULT_MAX_STEPS})
  --num-ctx <n>        Context window in tokens sent to Ollama (default ${DEFAULT_NUM_CTX})
  --wall-clock <sec>   Wall-clock budget for the run (also HALO_WALL_CLOCK_SECONDS). Time spent
                       counts toward budget pressure, command timeouts are clamped to what
                       remains, and the loop wraps up before the deadline instead of being killed
  --cwd <path>         Workspace root for file/shell tools (default: current directory)
  --mode <ask|agent>   ask: confirm writes/shell commands (default in a terminal)
                       agent: run them unattended (default when not a TTY, and in serve mode)
  --session <name>     Persist/resume this conversation (.halo-agent/sessions/ in the workspace)
  --mcp "<command>"    Attach an MCP server (stdio); repeatable. Tools appear as mcp_<name>
  --embed-model <name> Embedding model for project index (default nomic-embed-text)
  --no-index           Skip building the local project vector index
  --think <mode>       Native model reasoning: auto (default), true, false/off,
                       or low|medium|high|max (for thinking models / gpt-oss)
  --no-checkpoints     Do not snapshot files before write_file/edit_file
  --port <n>           Port for serve mode (default 11435)
  --quiet              Only print the final answer
  --json               JSON output (models command)
  --                   Treat everything after as the goal, even if it starts with -
  -v, --version        Print the version
  -h, --help           Show this help

Examples:
  bf-agent
  bf-agent "what time is it?"
  bf-agent "summarize src/agent-loop.mjs" --model qwen3-coder:30b
  bf-agent "fix the failing test" --session fix-tests --mode agent
  bf-agent serve --port 11435
  bf-agent models
  bf-agent models config edit
  bf-agent models --json --base-url http://127.0.0.1:11434
  bf-agent "hard refactor" --tier 4 --tier-preset hybrid
  bf-agent "frontier coding" --tier 5 --tier-preset cloud-max
  bf-agent "search my notes for X" --mcp "npx -y some-mcp-server"
  bf-agent "what is the latest Node.js LTS version?"

Exit codes:
  0  success        1  usage error      2  stopped at max steps
  3  Ollama error   4  MCP attach failed`);
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

function makeInteractivePrompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  const approve = async ({ name, args }) => {
    let preview = JSON.stringify(args);
    if (preview.length > 200) preview = `${preview.slice(0, 200)}...`;
    const answer = await rl.question(`allow ${name} ${preview}? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  };
  return {
    approve,
    async readLine() {
      return rl.question("› ");
    },
    close() {
      if (!closed) {
        closed = true;
        rl.close();
      }
    },
    onSigInt(handler) {
      rl.on("SIGINT", handler);
    },
    ended() {
      return closed || process.stdin.readableEnded;
    },
  };
}

function printInteractiveHelp() {
  console.log(`Interactive commands:
  /help, ?     Show this help
  /clear       Start a new conversation (keeps --session name, clears in-memory history)
  /quit, /exit  Leave interactive mode (also: quit, exit)`);
}

function isInteractiveCommand(input) {
  const cmd = input.trim().toLowerCase();
  return (
    cmd === "/help" ||
    cmd === "?" ||
    cmd === "/quit" ||
    cmd === "/exit" ||
    cmd === "quit" ||
    cmd === "exit"
  );
}

async function runInteractiveSession({
  options,
  loop,
  store,
  prompt,
  sessionName,
  priorSession,
}) {
  let history = priorSession?.messages ?? null;
  let sessionSnapshot = priorSession;

  const sessionLabel = sessionName ? ` | session: ${sessionName}` : "";
  console.error(
    `Bitfield Agent (bf-agent) v${VERSION} | interactive | model: ${options.model} | workspace: ${options.cwd}${sessionLabel}`,
  );
  console.error("Enter a prompt, or /help for commands. /quit to exit.");
  if (priorSession && !options.quiet) {
    console.error(
      `[session ${sessionName}] resuming: ${priorSession.messages.length} messages, ${priorSession.steps.length} steps so far`,
    );
  }

  prompt.onSigInt(() => {
    console.log("");
    prompt.close();
    process.exit(0);
  });

  try {
    while (true) {
      let line;
      try {
        line = await prompt.readLine();
      } catch (err) {
        if (err?.code === "ERR_USE_AFTER_CLOSE") break;
        throw err;
      }

      const input = line.trim();
      if (!input) {
        if (prompt.ended()) break;
        continue;
      }

      const cmd = input.toLowerCase();
      if (cmd === "/help" || cmd === "?") {
        printInteractiveHelp();
        continue;
      }
      if (cmd === "/clear") {
        history = null;
        sessionSnapshot = null;
        console.error("[cleared conversation]");
        continue;
      }
      if (isInteractiveCommand(input)) break;

      try {
        const result = await loop.run(input, {
          history: history ?? undefined,
        });
        history = result.messages;

        if (store && sessionName) {
          const saved = store.merge(sessionName, sessionSnapshot, result);
          await store.save(sessionName, saved);
          sessionSnapshot = saved;
          if (!options.quiet && saved.changedFiles.length > 0) {
            console.error(`[session ${sessionName}] files changed: ${saved.changedFiles.join(", ")}`);
          }
        }

        if (result.stopReason === "max-steps") {
          console.error(
            `Stopped after ${options.maxSteps} steps; the answer below may be incomplete (raise --max-steps to allow more).`,
          );
        }
        if (result.text) console.log(result.text);
      } catch (err) {
        if (err instanceof OllamaClientError) {
          console.error(err.message);
          continue;
        }
        throw err;
      }
    }
  } finally {
    prompt.close();
  }
}

function printClassifiedModels({ baseUrl, classified, suggested, json }) {
  if (json) {
    console.log(
      JSON.stringify(
        {
          baseUrl,
          suggested: suggested ? { model: suggested.model, reason: suggested.reason } : null,
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
  lines.push(
    suggested
      ? `suggested (--model auto): ${suggested.model} — ${suggested.reason}`
      : "suggested (--model auto): none — no installed model has thinking + tools at a usable size",
  );
  console.log(lines.join("\n").trimEnd());
}

async function listOllamaModels(options) {
  const client = new OllamaClient({ baseUrl: options.baseUrl, model: options.model });
  try {
    const models = await client.listModelsDetailed();
    const classified = await listClassifiedModelsDetected(client, models.map((m) => m.name));
    const suggested = await suggestModel({ client, models });
    printClassifiedModels({ baseUrl: options.baseUrl, classified, suggested, json: options.json });
  } catch (err) {
    if (err instanceof OllamaClientError) {
      console.error(err.message);
      process.exitCode = 3;
      return;
    }
    throw err;
  }
}

/** @param {object} step */
function describeStep(step) {
  if (step.kind === "steer") {
    console.error(`[steer] ${step.content}`);
    return;
  }
  if (step.kind === "failed") {
    console.error(`[failed] ${step.content}`);
    return;
  }
  for (const call of step.toolCalls ?? []) {
    const status = call.ok ? "ok" : `error: ${call.error}`;
    console.error(`[step ${step.index}] ${call.name}(${JSON.stringify(call.args)}) -> ${status}`);
  }
}

async function runCheckpointsCommand(options) {
  const cmd = options.checkpointsCommand ?? "list";
  switch (cmd) {
    case "list": {
      const runs = await CheckpointStore.list(options.cwd);
      if (options.json) {
        console.log(JSON.stringify(runs, null, 2));
        return;
      }
      if (runs.length === 0) {
        console.log("No checkpoints.");
        return;
      }
      for (const run of runs) {
        console.log(`${run.runId}  (${run.files.length} file${run.files.length === 1 ? "" : "s"})`);
        for (const file of run.files) console.log(`  ${file.existed ? "modified" : "created "}  ${file.path}`);
      }
      return;
    }
    case "restore": {
      if (!options.checkpointsRunId) {
        console.error("Usage: bf-agent checkpoints restore <run-id>");
        process.exitCode = 1;
        return;
      }
      const { restored, removed } = await CheckpointStore.restore(options.cwd, options.checkpointsRunId);
      console.log(`Restored ${restored.length} file(s), removed ${removed.length} from ${options.checkpointsRunId}.`);
      for (const file of restored) console.log(`  restored ${file}`);
      for (const file of removed) console.log(`  removed  ${file}`);
      return;
    }
    default:
      console.error(`Unknown checkpoints subcommand '${cmd}'. Use: list, restore <run-id>`);
      process.exitCode = 1;
  }
}

async function main() {
  const builtins = getBuiltinDefaults();
  const { values: configValues, errors: configErrors } = await loadUserConfig();
  const {
    values: modelsConfigValues,
    errors: modelsConfigErrors,
    exists: modelsConfigExists,
  } = await loadModelsConfig();
  const withConfig = applyConfigToDefaults(builtins, configValues);
  const options = parseArgs(process.argv.slice(2), withConfig);
  options.errors.push(...configErrors, ...modelsConfigErrors);

  if (options.version) {
    console.log(VERSION);
    return;
  }
  if (options.help) {
    printHelp();
    return;
  }
  if (options.configEdit) {
    const configPath = await ensureConfigFile();
    process.exitCode = openConfigInEditor(configPath);
    return;
  }
  if (options.modelsConfigEdit) {
    const configPath = await ensureModelsConfigFile();
    process.exitCode = openModelsConfigInEditor(configPath);
    return;
  }
  if (options.modelsConfigCommand) {
    console.error("Unknown models config subcommand. Use: bf-agent models config edit");
    process.exitCode = 1;
    return;
  }
  if (options.configCommand) {
    console.error("Unknown config subcommand. Use: bf-agent config edit");
    process.exitCode = 1;
    return;
  }
  if (options.errors.length > 0) {
    for (const error of options.errors) console.error(error);
    console.error("Run 'bf-agent --help' for usage.");
    process.exitCode = 1;
    return;
  }
  if (options.checkpointsCommand) {
    await runCheckpointsCommand(options);
    return;
  }
  if (!options.goal && !options.serve && !options.listModels) {
    const forceInteractive = process.env.HALO_AGENT_FORCE_INTERACTIVE === "1";
    if ((process.stdin.isTTY && process.stdout.isTTY) || forceInteractive) {
      options.interactive = true;
    } else {
      console.error("No goal given.");
      printHelp();
      process.exitCode = 1;
      return;
    }
  }

  if (options.listModels) {
    await listOllamaModels(options);
    return;
  }

  const effectivePreset = options.tierPreset ?? modelsConfigValues.tierPreset;
  applyTierPresetPolicy(options, effectivePreset, { thinkExplicit: options.thinkExplicit === true });
  const presetPolicy = getTierPresetPolicy(effectivePreset);

  const client = new OllamaClient({
    baseUrl: options.baseUrl,
    model: options.model,
    numCtx: options.numCtx,
    think: options.think,
  });

  // Route to an installed, suitable model up front; skip silently when Ollama is
  // unreachable — the run itself will surface that error clearly.
  try {
    if (options.model === "auto" && !modelsConfigExists && !options.tierPreset && !presetPolicy.cloudOnly) {
      const routed = await resolveModelAuto({ requested: options.model, client });
      for (const warning of routed.warnings ?? []) console.error(warning);
      options.model = routed.model;
      await configureClientModel(client, routed.model);
    } else {
      const routed = await resolveCliModel(options, client, modelsConfigValues, modelsConfigExists);
      for (const warning of routed.warnings) console.error(warning);
      options.model = routed.model;
      await configureClientModel(client, routed.model);
    }
  } catch (err) {
    if (err instanceof ModelRoutingError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    if (options.model !== "auto") {
      try {
        assertToolCapable(options.model);
        await configureClientModel(client, options.model);
      } catch (routingErr) {
        console.error(routingErr.message);
        process.exitCode = 1;
        return;
      }
    }
    // Ollama unreachable — fall through; the run itself will surface that error.
  }

  const checkpointStore = options.noCheckpoints ? undefined : new CheckpointStore({ workspaceRoot: options.cwd });
  const registry = registerBuiltinTools(new ToolRegistry(), {
    workspaceRoot: options.cwd,
    searchClient: options.noIndex ? undefined : client,
    embeddingModel: options.embedModel,
    checkpoints: checkpointStore,
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

  if (!options.noIndex) {
    try {
      await ensureProjectIndex({
        workspaceRoot: options.cwd,
        client,
        embeddingModel: options.embedModel,
        onProgress: options.quiet ? undefined : (msg) => console.error(`[index] ${msg}`),
      });
    } catch {
      // Index is best-effort; search_project reports its own errors.
    }
  }

  const systemPrompt = await buildSystemPrompt({
    basePrompt: DEFAULT_SYSTEM_PROMPT,
    modelOverlay: modelPromptOverlay(options.model),
    workspaceRoot: options.cwd,
    extraContext: formatMcpToolIndex(registry),
  });

  if (options.serve) {
    let serveTierModels = null;
    try {
      serveTierModels = await resolveEffectiveTierModels({
        cliTierPreset: options.tierPreset ?? null,
        userTierModels: modelsConfigValues.tierModels,
        userTierPreset: modelsConfigValues.tierPreset,
        baseUrl: options.baseUrl,
        client,
      });
    } catch {
      // Tier config optional for serve; image turns fall back to auto vision pick.
    }
    const server = createOpenAIServer({
      client,
      registry,
      systemPrompt,
      maxSteps: options.maxSteps,
      defaultModel: options.model,
      tierModels: serveTierModels,
      defaultTier: options.taskTier ?? modelsConfigValues.defaultTier ?? DEFAULT_TASK_TIER,
    });
    server.listen(options.port, () => {
      const { port } = server.address();
      console.error(`Bitfield Agent serving OpenAI-compatible API on http://127.0.0.1:${port}/v1`);
      console.error(`workspace: ${options.cwd} | model: ${options.model} | ollama: ${options.baseUrl}`);
    });
    return;
  }

  let approval;
  let interactivePrompt;
  if (options.interactive) {
    interactivePrompt = makeInteractivePrompt();
    if (options.mode === "ask") {
      registry.setApprovalHandler(interactivePrompt.approve);
    }
  } else if (options.mode === "ask") {
    approval = makeApprovalPrompt();
    registry.setApprovalHandler(approval.handler);
  }

  let store;
  let priorSession = null;
  /** Steps accumulated during the current non-interactive run for live flush. */
  const liveRunSteps = [];
  let liveFlushBusy = Promise.resolve();

  if (options.session) {
    store = new SessionStore({ workspaceRoot: options.cwd });
    priorSession = await store.load(options.session);
    if (priorSession && !options.quiet) {
      console.error(
        `[session ${options.session}] resuming: ${priorSession.messages.length} messages, ${priorSession.steps.length} steps so far`,
      );
    }
  }

  /**
   * Persist a mid-run snapshot so Harbor AgentTimeoutError / SIGTERM still
   * leaves a usable trajectory instead of an empty session.json.
   * @param {object} [partial]
   */
  const flushLiveSession = (partial = {}) => {
    if (!store || !options.session) return Promise.resolve();
    liveFlushBusy = liveFlushBusy
      .then(async () => {
        const draft = store.merge(options.session, priorSession, {
          messages: partial.messages ?? priorSession?.messages ?? [],
          steps: liveRunSteps,
          stopReason: partial.stopReason ?? "running",
          checkpointRunId: checkpointStore?.runId,
          error: partial.error,
        });
        await store.save(options.session, draft);
      })
      .catch(() => {
        // Best-effort: a flush failure must not kill the agent loop.
      });
    return liveFlushBusy;
  };

  const onStep = (step) => {
    if (store && options.session && !options.interactive) {
      liveRunSteps.push(step);
      void flushLiveSession();
    }
    if (!options.quiet) describeStep(step);
  };

  const loop = new AgentLoop({
    client,
    registry,
    systemPrompt,
    maxSteps: options.maxSteps,
    onStep,
    compaction: {},
    wallClockMs: resolveWallClockMs(options),
  });

  const onKillSignal = () => {
    void flushLiveSession({ stopReason: "timeout", error: "process received SIGTERM/SIGINT" }).finally(
      () => process.exit(1),
    );
  };
  if (store && options.session && !options.interactive) {
    process.once("SIGTERM", onKillSignal);
    process.once("SIGINT", onKillSignal);
  }

  try {
    if (options.interactive) {
      await runInteractiveSession({
        options,
        loop,
        store,
        prompt: interactivePrompt,
        sessionName: options.session,
        priorSession,
      });
      return;
    }

    const result = await loop.run(options.goal, {
      history: priorSession?.messages,
    });

    if (store) {
      await flushLiveSession();
      const saved = store.merge(options.session, priorSession, {
        ...result,
        checkpointRunId: checkpointStore?.runId,
      });
      await store.save(options.session, saved);
      if (!options.quiet && saved.changedFiles.length > 0) {
        console.error(`[session ${options.session}] files changed: ${saved.changedFiles.join(", ")}`);
      }
    }

    if (result.stopReason === "max-steps") {
      console.error(
        result.wallClockExhausted
          ? `Stopped at the wall-clock budget (${Math.round((result.elapsedMs ?? 0) / 1000)}s); the answer below may be incomplete (raise --wall-clock to allow more).`
          : `Stopped after ${options.maxSteps} steps; the answer below may be incomplete (raise --max-steps to allow more).`,
      );
      if (result.text) console.log(result.text);
      process.exitCode = 2;
      return;
    }
    if (result.stopReason === "failed") {
      console.error(result.error ?? "Agent stopped: the model returned no usable response.");
      if (result.text) console.log(result.text);
      process.exitCode = 1;
      return;
    }
    console.log(result.text);
  } catch (err) {
    if (store && options.session) {
      const failed = {
        text: "",
        stopReason: "error",
        // Keep any steps already flushed mid-run — an empty steps array here
        // would wipe the trajectory Harbor needs after a crash.
        steps: liveRunSteps,
        messages: priorSession?.messages ?? [],
        error: err instanceof OllamaClientError ? err.message : String(err?.message ?? err),
      };
      await flushLiveSession({
        stopReason: "error",
        error: failed.error,
        messages: failed.messages,
      });
      const saved = store.merge(options.session, priorSession, failed);
      await store.save(options.session, saved);
    }
    if (err instanceof OllamaClientError) {
      console.error(err.message);
      process.exitCode = 3;
      return;
    }
    throw err;
  } finally {
    process.off("SIGTERM", onKillSignal);
    process.off("SIGINT", onKillSignal);
    approval?.close();
    interactivePrompt?.close();
    for (const mcp of mcpClients) await mcp.close();
  }
}

await main();
