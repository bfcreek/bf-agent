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

import {
  AgentLoop,
  composeSystemPrompt,
  DEFAULT_MAX_STEPS,
  DEFAULT_STREAK_NUDGE_AFTER,
  DEFAULT_SYSTEM_PROMPT,
} from "./agent-loop.mjs";
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
import { configureClientModel, MAX_AUTO_NUM_CTX, modelPromptOverlay } from "./model-tuning.mjs";
import { DEFAULT_NUM_CTX, OllamaClient, OllamaClientError } from "./ollama-client.mjs";
import { withHollowCompletionGuard } from "./hollow-completion-guard.mjs";
import { createOpenAIServer } from "./openai-server.mjs";
import { KNOWN_PROVIDERS, ProviderClientError } from "./provider-client.mjs";
import { createProviderClient, shouldRouteOllamaModel } from "./providers/factory.mjs";
import { SessionStore } from "./session-store.mjs";
import { parseAutoApproveSpec, ToolRegistry } from "./tool-registry.mjs";
import { registerBuiltinTools } from "./tools/builtin.mjs";
import { HALO_SCAN_CONTEXT_GUIDANCE, HALO_SCAN_STREAK_HINT, registerHaloScanTools } from "./tools/halo-scan.mjs";
import { ensureAgentDataDir } from "./workspace-data.mjs";
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
      case "--provider": {
        const raw = value(arg, ++i);
        if (raw !== undefined) {
          const name = String(raw).trim().toLowerCase();
          if (KNOWN_PROVIDERS.includes(name)) options.provider = name;
          else options.errors.push(`--provider must be one of: ${KNOWN_PROVIDERS.join(", ")}.`);
        }
        break;
      }
      case "--api-key":
        options.apiKey = value(arg, ++i) ?? options.apiKey;
        break;
      case "--supervisor-provider": {
        const raw = value(arg, ++i);
        if (raw !== undefined) {
          const name = String(raw).trim().toLowerCase();
          if (name === "copilot") {
            options.errors.push("--supervisor-provider cannot be 'copilot'.");
          } else if (KNOWN_PROVIDERS.includes(name)) {
            options.supervisorProvider = name;
          } else {
            options.errors.push(`--supervisor-provider must be one of: ollama, openai, anthropic.`);
          }
        }
        break;
      }
      case "--supervisor-model":
        options.supervisorModel = value(arg, ++i) ?? options.supervisorModel;
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
        if (String(raw ?? "").trim().toLowerCase() === "auto") {
          options.numCtx = "auto";
          break;
        }
        const n = Number.parseInt(raw ?? "", 10);
        if (Number.isFinite(n) && n > 0) options.numCtx = n;
        else if (raw !== undefined) options.errors.push(`--num-ctx needs a positive integer or 'auto', got '${raw}'.`);
        break;
      }
      case "--wall-clock": {
        const raw = value(arg, ++i);
        const n = Number.parseInt(raw ?? "", 10);
        if (Number.isFinite(n) && n > 0) options.wallClockSeconds = n;
        else if (raw !== undefined) options.errors.push(`--wall-clock needs a positive integer (seconds), got '${raw}'.`);
        break;
      }
      case "--max-prompt-tokens": {
        const raw = value(arg, ++i);
        const n = Number.parseInt(String(raw ?? "").replace(/[_,]/g, "").replace(/k$/i, "000"), 10);
        if (Number.isFinite(n) && n > 0) options.maxPromptTokens = n;
        else if (raw !== undefined) options.errors.push(`--max-prompt-tokens needs a positive integer, got '${raw}'.`);
        break;
      }
      case "--streak-nudge": {
        // Optional count: `--streak-nudge` alone uses the default.
        const next = argv[i + 1];
        if (next !== undefined && /^\d+$/.test(next)) {
          i += 1;
          options.streakNudge = Number.parseInt(next, 10) || DEFAULT_STREAK_NUDGE_AFTER;
        } else {
          options.streakNudge = DEFAULT_STREAK_NUDGE_AFTER;
        }
        break;
      }
      case "--no-streak-nudge":
        options.streakNudge = 0;
        break;
      case "--no-completion-guard":
        options.completionGuard = false;
        break;
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
      case "--auto-approve": {
        const next = argv[i + 1];
        const raw = next !== undefined && !next.startsWith("-") ? argv[++i] : "all";
        const parsed = parseAutoApproveSpec(raw);
        if (parsed.ok) options.autoApprove = parsed.policy;
        else options.errors.push(parsed.error);
        break;
      }
      case "--no-auto-approve":
        options.autoApprove = "off";
        break;
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
      case "--index":
        options.index = true;
        break;
      case "--no-index":
        options.index = false;
        break;
      case "--no-scan":
        options.scan = false;
        break;
      case "--scan":
        options.scan = true;
        break;
      case "--scan-profile": {
        const name = value(arg, ++i);
        if (name !== undefined) options.scanProfile = String(name).trim().toLowerCase();
        break;
      }
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
  console.log(`Bitfield Ollama Agent (bf-agent) v${VERSION} - local agent loop on Ollama

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
  --provider <name>    LLM / nested worker: ${KNOWN_PROVIDERS.join("|")} (default ollama).
                       openai/anthropic need optional peer SDKs; copilot nests GitHub Copilot
                       under a supervisor LLM (default ollama) via delegate_copilot
  --api-key <key>      API key for openai/anthropic (else OPENAI_API_KEY / ANTHROPIC_API_KEY)
  --supervisor-provider <name>  For --provider copilot: ollama|openai|anthropic (default ollama)
  --supervisor-model <name>     Supervisor model when using nested Copilot
  --model <name|auto|tier>  Model for the active provider. For ollama, default auto: with
                       models.yaml, picks the band for --tier; without models.yaml, strongest
                       installed model with thinking + tools that fits in memory. For
                       openai/anthropic, pass an explicit model. For copilot, --model is the
                       Copilot worker model; supervisor uses --supervisor-model (ollama auto)
  --tier-preset <name> Preset for model routing: ${TIER_PRESET_HELP}
  --tier <n>           Task difficulty 0–6 for model routing (default from models.yaml)
  --base-url <url>     Ollama server (default http://127.0.0.1:11434); also OpenAI-compatible base URL
  --max-steps <n>      Max model round-trips (default ${DEFAULT_MAX_STEPS})
  --num-ctx <n|auto>   Context window in tokens sent to Ollama. auto (default) sizes it to the
                       model and this machine's memory: floor ${DEFAULT_NUM_CTX}, ceiling ${MAX_AUTO_NUM_CTX}
  --wall-clock <sec>   Wall-clock budget for the run (also HALO_WALL_CLOCK_SECONDS). Time spent
                       counts toward budget pressure, command timeouts are clamped to what
                       remains, and the loop wraps up before the deadline instead of being killed
  --max-prompt-tokens <n>
                       Cumulative prompt-token budget for the run (e.g. 400k). Steps cost 3k-20k
                       tokens each, so this caps spend where --max-steps cannot; the loop wraps
                       up with a plain-text answer when it is exceeded (exit code 2)
  --streak-nudge [n]   After n (default ${DEFAULT_STREAK_NUDGE_AFTER}) consecutive calls to one read-only tool,
                       tell the model to answer or switch to a one-call tool. Off by default
  --no-completion-guard
                       Do not challenge "done" on create/implement goals when no mutating tools ran
                       (write_file / edit_file / run_command). On by default
  --cwd <path>         Workspace root for file/shell tools (default: current directory)
  --mode <ask|agent>   ask: confirm writes/shell commands (default in a terminal)
                       agent: run them unattended (default when not a TTY, and in serve mode).
                       Unattended runs still block deletes and cleanup writes
                       unless the call is auto-approved
  --auto-approve [p]   Approve gated tools without a prompt. Bare flag or 'all':
                       every gated tool. 'off': none. Or a list: write_file,run_command.
                       Auto-approved calls count as approved, including deletes.
                       In ask mode, tools outside the list still prompt
  --no-auto-approve    Do not auto-approve tools (overrides config)
  --session <name>     Persist/resume this conversation (.bf/bf-agent/sessions/ in the workspace)
  --mcp "<command>"    Attach an MCP server (stdio); repeatable. Tools are listed by name and
                       reached through describe_tool / call_mcp_tool
  --no-scan            Do not embed Halo Scan's code tools (repo_overview, file_outline,
                       get_symbol, symbol_context, ...). They are embedded natively when
                       @bitfieldcreek/halo-scan is installed; their read_file / grep_search /
                       list_dir / find_files replace the builtins
  --scan-profile <p>   Halo Scan tool packs: auto (default; fingerprints the repo), base,
                       full, or a pack name (symbols, quality, web, config)
  --index              Build the local project vector index and register search_project
                       (off by default; needs an Ollama embedding model)
  --embed-model <name> Embedding model for --index and fetch_url (default nomic-embed-text)
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
  bf-agent "delete the scratch files I named" --auto-approve
  bf-agent "edit the readme" --mode ask --auto-approve write_file,edit_file
  bf-agent serve --port 11435
  bf-agent models
  bf-agent models config edit
  bf-agent models --json --base-url http://127.0.0.1:11434
  bf-agent "hard refactor" --tier 4 --tier-preset hybrid
  bf-agent --provider openai --model gpt-5 "summarize this repo"
  bf-agent --provider copilot "fix the failing test"
  bf-agent "frontier coding" --tier 5 --tier-preset cloud-max
  bf-agent "search my notes for X" --mcp "npx -y some-mcp-server"
  bf-agent "what is the latest Node.js LTS version?"

Exit codes:
  0  success        1  usage error      2  stopped at max steps
  3  Ollama error   4  MCP attach failed`);
}

function promptsForApproval(options) {
  return options.mode === "ask" && options.autoApprove !== "all";
}

/**
 * Install the auto-approve policy. Ask-mode prompting is separate: it is
 * skipped entirely when every gated tool is auto-approved.
 * @param {ToolRegistry} registry
 * @param {{autoApprove?: "all"|"off"|string[], quiet?: boolean}} options
 */
function applyAutoApprove(registry, options) {
  const policy = options.autoApprove ?? "off";
  if (policy === "all" || Array.isArray(policy)) registry.setAutoApprove(policy);
  if (options.quiet || policy === "off" || policy == null) return;
  const which = policy === "all" ? "all gated tools" : policy.join(", ");
  console.error(`[approval] auto-approving ${which}`);
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
    `Bitfield Ollama Agent (bf-agent) v${VERSION} | interactive | model: ${options.model} | workspace: ${options.cwd}${sessionLabel}`,
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
        } else if (result.stopReason === "token-budget") {
          console.error(
            `Stopped at the prompt-token budget (${result.promptTokens} of ${options.maxPromptTokens} tokens); the answer below may be incomplete (raise --max-prompt-tokens to allow more).`,
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
    if (step.nudge) {
      console.error(`[nudge] ${step.nudge.tool} x${step.nudge.count}: asked the model to answer or switch tools`);
      return;
    }
    console.error(`[steer] ${step.content}`);
    return;
  }
  if (step.kind === "failed") {
    console.error(`[failed] ${step.content}`);
    return;
  }
  for (const call of step.toolCalls ?? []) {
    const status = call.ok ? "ok" : `error: ${call.error}`;
    if (call.resolvedName && call.resolvedName !== call.name) {
      console.error(`[alias] ${call.name} -> ${call.resolvedName}`);
    }
    console.error(`[step ${step.index}] ${call.resolvedName ?? call.name}(${JSON.stringify(call.args)}) -> ${status}`);
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

  const provider = options.provider ?? "ollama";
  if (options.serve && provider !== "ollama") {
    console.error("bf-agent serve currently supports --provider ollama only.");
    process.exitCode = 1;
    return;
  }

  let providerSetup;
  try {
    providerSetup = await createProviderClient({
      provider,
      model: options.model,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      numCtx: options.numCtx,
      think: options.think,
      supervisorProvider: options.supervisorProvider,
      supervisorModel: options.supervisorModel,
    });
  } catch (err) {
    console.error(err instanceof ProviderClientError || err instanceof OllamaClientError ? err.message : String(err?.message ?? err));
    process.exitCode = 1;
    return;
  }

  const client = providerSetup.client;
  /** Model name used for prompt overlays / logging (supervisor when nested). */
  let loopModel = client.model ?? options.model;
  /** Copilot worker model stays on options.model when nested. */
  const workerModel = providerSetup.kind === "nested" ? options.model : null;

  if (provider !== "ollama" && providerSetup.kind === "llm") {
    if (options.thinkExplicit && !options.quiet) {
      console.error(`[provider] --think is Ollama-only; ignored for ${provider}.`);
    }
    if (options.numCtx !== "auto" && options.numCtx != null && !options.quiet) {
      console.error(`[provider] --num-ctx is Ollama-only; ignored for ${provider}.`);
    }
  }

  // Route to an installed, suitable model up front; skip silently when Ollama is
  // unreachable — the run itself will surface that error clearly.
  if (shouldRouteOllamaModel(providerSetup)) {
    const routeOptions = { ...options, model: providerSetup.kind === "nested" ? (options.supervisorModel ?? "auto") : options.model };
    try {
      if (routeOptions.model === "auto" && !modelsConfigExists && !options.tierPreset && !presetPolicy.cloudOnly) {
        const routed = await resolveModelAuto({ requested: routeOptions.model, client });
        for (const warning of routed.warnings ?? []) console.error(warning);
        loopModel = routed.model;
        client.model = routed.model;
        if (providerSetup.kind !== "nested") options.model = routed.model;
        await configureClientModel(client, routed.model);
      } else {
        const routed = await resolveCliModel(routeOptions, client, modelsConfigValues, modelsConfigExists);
        for (const warning of routed.warnings) console.error(warning);
        loopModel = routed.model;
        client.model = routed.model;
        if (providerSetup.kind !== "nested") options.model = routed.model;
        await configureClientModel(client, routed.model);
      }
      if (client.numCtxAuto && !options.quiet) {
        console.error(`[context] ${client.numCtx} tokens — ${client.numCtxReason ?? "auto"}`);
      }
      for (const warning of client.numCtxWarnings ?? []) console.error(`[context] ${warning}`);
    } catch (err) {
      if (err instanceof ModelRoutingError) {
        console.error(err.message);
        process.exitCode = 1;
        return;
      }
      if (routeOptions.model !== "auto") {
        try {
          assertToolCapable(routeOptions.model);
          await configureClientModel(client, routeOptions.model);
          loopModel = routeOptions.model;
        } catch (routingErr) {
          console.error(routingErr.message);
          process.exitCode = 1;
          return;
        }
      }
      // Ollama unreachable — fall through; the run itself will surface that error.
    }
  } else if (!options.model || options.model === "auto") {
    console.error(`Provider '${provider}' requires an explicit --model (auto-routing is Ollama-only).`);
    process.exitCode = 1;
    return;
  } else {
    loopModel = options.model;
    client.model = options.model;
  }

  const canEmbed = typeof client.embed === "function";
  const useIndex = options.index && canEmbed;
  if (options.index && !useIndex && !options.quiet) {
    console.error(`[provider] project index skipped (${provider} has no embeddings API).`);
  }

  await ensureAgentDataDir(options.cwd);
  const checkpointStore = options.noCheckpoints ? undefined : new CheckpointStore({ workspaceRoot: options.cwd });
  const registry = registerBuiltinTools(new ToolRegistry(), {
    workspaceRoot: options.cwd,
    searchClient: canEmbed ? client : undefined,
    projectIndex: useIndex,
    embeddingModel: options.embedModel,
    checkpoints: checkpointStore,
  });

  let haloScanInfo = null;
  if (options.scan) {
    try {
      haloScanInfo = await registerHaloScanTools(registry, {
        workspaceRoot: options.cwd,
        profile: options.scanProfile,
      });
    } catch (err) {
      if (!options.quiet) console.error(`[scan] halo-scan not embedded: ${err?.message ?? err}`);
    }
    if (haloScanInfo && !options.quiet) {
      const replaced = haloScanInfo.replaced.length ? `; replaced ${haloScanInfo.replaced.join(", ")}` : "";
      console.error(
        `[scan] halo-scan: ${haloScanInfo.names.length} tools (profile ${haloScanInfo.profile ?? "full"}${replaced})`,
      );
    }
  }

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

  if (useIndex) {
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

  /** @type {import("./agent-loop.mjs").AgentHooks} */
  let loopHooks = withHollowCompletionGuard({}, options.completionGuard !== false);
  let nestedOverlay = "";
  if (providerSetup.kind === "nested" && typeof providerSetup.applyNested === "function") {
    const nested = providerSetup.applyNested({
      registry,
      hooks: loopHooks,
      workspaceRoot: options.cwd,
      onDelta: options.quiet ? undefined : (d) => process.stderr.write(d),
      // Approval is wired later; resolve lazily so ask-mode prompts still apply.
      approvalHandler: async (request) => {
        if (typeof registry.approvalHandler === "function") {
          return registry.approvalHandler(request);
        }
        return true;
      },
    });
    loopHooks = nested.hooks ?? loopHooks;
    nestedOverlay = nested.systemOverlay ?? "";
    if (!options.quiet) {
      console.error(
        `[provider] copilot nested | supervisor=${providerSetup.supervisorProvider}:${loopModel}` +
          (workerModel && workerModel !== "auto" ? ` | worker model=${workerModel}` : ""),
      );
    }
  }

  const corePrompt = haloScanInfo
    ? composeSystemPrompt({ contextGuidance: HALO_SCAN_CONTEXT_GUIDANCE })
    : DEFAULT_SYSTEM_PROMPT;
  const systemPrompt = await buildSystemPrompt({
    basePrompt: corePrompt + nestedOverlay,
    modelOverlay: modelPromptOverlay(loopModel),
    workspaceRoot: options.cwd,
    extraContext: formatMcpToolIndex(registry),
  });

  applyAutoApprove(registry, options);

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
      hooks: loopHooks,
    });
    server.listen(options.port, () => {
      const { port } = server.address();
      console.error(`Bitfield Ollama Agent serving OpenAI-compatible API on http://127.0.0.1:${port}/v1`);
      console.error(`workspace: ${options.cwd} | model: ${options.model} | ollama: ${options.baseUrl}`);
    });
    return;
  }

  let approval;
  let interactivePrompt;
  if (options.interactive) {
    interactivePrompt = makeInteractivePrompt();
    if (promptsForApproval(options)) {
      registry.setApprovalHandler(interactivePrompt.approve);
    }
  } else if (promptsForApproval(options)) {
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
    ...(options.maxPromptTokens > 0 ? { maxPromptTokens: options.maxPromptTokens } : {}),
    ...(options.streakNudge > 0
      ? {
          streakNudgeAfter: options.streakNudge,
          ...(haloScanInfo ? { streakNudgeHint: HALO_SCAN_STREAK_HINT } : {}),
        }
      : {}),
    hooks: loopHooks,
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

    if (result.stopReason === "max-steps" || result.stopReason === "token-budget") {
      console.error(
        result.stopReason === "token-budget"
          ? `Stopped at the prompt-token budget (${result.promptTokens} of ${options.maxPromptTokens} tokens); the answer below may be incomplete (raise --max-prompt-tokens to allow more).`
          : result.wallClockExhausted
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
