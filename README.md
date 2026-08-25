# halo-agent

Local agent runtime that turns Ollama's completion API into a multi-step agent:
the model plans, calls tools, observes results, and repeats until the task is done —
all on this machine.

## Vision

A **free-to-nearly-free, super-flexible agent** — cost depends only on how you use it:

- On local Ollama models, running the agent costs nothing.
- Paired with **Aura Wire**, the same agent reaches routed, compressed, guarded
  traffic to any backend you choose — you pay only for what you route to paid providers.

Product shape:

| Principle | Meaning |
| --- | --- |
| **CLI + SDK** | Two first-class surfaces: a command line for humans and scripts, an SDK for embedding the loop in other software |
| **Compatible at every angle** | OpenAI-compatible API façade, standard tool schemas, MCP for external tools, any Ollama model — integrate with what already exists rather than inventing formats |
| **IDE integration via Wire** | halo-agent ships no IDE extensions. Editors reach it through Aura Wire's `/v1` door and routing rules — Wire owns the IDE story |
| **Local-first, private** | Prompts, tools, and files stay on this machine unless you explicitly route elsewhere |

## Requirements

- Node.js 20+
- [Ollama](https://ollama.com) running locally (default `http://127.0.0.1:11434`)
- A tool-capable model installed, e.g. `ollama pull llama3.2` or `ollama pull qwen3-coder:30b`

No npm dependencies — the runtime uses only Node built-ins.

## Quick start

```powershell
node src/cli.mjs "what time is it right now?"
```

Or use the launchers in `bin/`, which check that Node.js 20+ is installed
(and print install instructions if not) before forwarding every argument to
the CLI:

```powershell
.\bin\halo-agent.ps1 "what time is it right now?"   # PowerShell
bin\halo-agent.cmd "what time is it right now?"      # cmd
./bin/halo-agent.sh "what time is it right now?"     # macOS / Linux
```

Options:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--model <name\|auto>` | `auto` | Ollama model to drive the loop; `auto` picks the best installed model (see below) |
| `--base-url <url>` | `http://127.0.0.1:11434` | Ollama server |
| `--max-steps <n>` | `10` | Max model round-trips before the loop stops |
| `--num-ctx <n>` | `16384` | Context window (tokens) sent to Ollama on every call — Ollama's own default is small and overflows silently |
| `--cwd <path>` | current directory | Workspace root that file and shell tools are confined to |
| `--mode <ask\|agent>` | `ask` in a terminal, `agent` otherwise | `ask` confirms each write/shell call with a y/N prompt; `agent` runs unattended |
| `--session <name>` | off | Persist and resume this conversation (`.halo-agent/sessions/` in the workspace) |
| `--mcp "<command>"` | none | Attach an MCP server over stdio (repeatable); its tools appear as `mcp_<name>` |
| `--quiet` | off | Suppress step trace; print only the final answer |
| `--think <mode>` | `auto` | Native model reasoning: `auto`, `true`, `false`/`off`, or `low`/`medium`/`high`/`max` |
| `--no-plan` | off | Skip the planning pre-pass on the first turn |
| `--no-hints` | off | Skip task-type constraint hints in the user message |

The model is resolved against Ollama's installed list at startup. With
`auto` (the default), halo-agent picks the strongest installed model that
supports both tool calling and thinking, has at least 7B parameters, and
fits comfortably in this machine's memory — a model too weak to finish agent
tasks wastes more than it saves. When no local model qualifies, an installed
[Ollama cloud](https://ollama.com/cloud) model is used instead: local-first,
cloud only when we must. Explicit `--model` names are always honored
(untagged names match their tags, so `llama3.2` finds `llama3.2:latest`)
with a warning when the choice looks too weak; missing names fall back to
auto-selection. Capabilities are asked of Ollama itself (`/api/show`), so
new models classify correctly; a family-name list is the fallback for older
Ollama versions. `halo-agent models` shows the classification and what
`auto` would pick.

Sessions store the full transcript, an accumulated step log, and the list of
files the agent changed. Re-running with the same `--session` name continues
the conversation with prior context.

## OpenAI-compatible server

```powershell
node src/cli.mjs serve --port 11435
```

Exposes the agent loop behind the standard OpenAI API so any existing client
(or Aura Wire routing rule) can use it with no halo-agent awareness:

- `POST /v1/chat/completions` — messages in, agent loop (with tools) runs,
  `chat.completion` out. `stream: true` is honored by replaying the finished
  answer as SSE chunks. A `model` in the request overrides the default.
- `GET /v1/models` — installed Ollama models.

Serve mode always runs unattended (`agent` mode): there is no terminal to
prompt for approvals. Put Wire's guardrails in front if you need policy.

## SDK

The same machinery is embeddable — `createAgent()` wires up the client,
builtin tools, context-built system prompt, and compaction in one call:

```js
import { createAgent } from "halo-agent";

const agent = await createAgent({
  model: "qwen3-coder:30b",
  workspaceRoot: "/path/to/project",
  tools: [{ name: "deploy", description: "Deploy the app.", execute: () => "done" }],
  approvalHandler: async ({ name, args }) => confirmSomehow(name, args),
});

const { text, steps } = await agent.run("run the tests and fix any failure");
```

Every piece is also exported individually (`AgentLoop`, `ToolRegistry`,
`OllamaClient`, `createOpenAIServer`, `SessionStore`, `McpClient`, ...) for
setups that need different wiring. External MCP tools bridge in via
`registerMcpTools(agent.registry, await McpClient.connect({ command: "..." }))`.

## Builtin tools

| Tool | What it does |
| --- | --- |
| `read_file` | Read a file (optionally a line range); long output is truncated |
| `list_dir` | List a directory; subdirectory names end with `/` |
| `grep_search` | Regex search over file contents (`path:line: text`); prunes `node_modules`, `.git`, etc., skips binaries |
| `find_files` | Find files by glob (`*.mjs`, `src/**/*.js`) |
| `web_search` | Search the public web via DuckDuckGo (titles, URLs, snippets) |
| `fetch_url` | Fetch a page and return text; optional `query` runs micro-RAG for top passages |
| `write_file` | Create or overwrite a file, creating parent directories |
| `edit_file` | Replace an exact snippet in a file (unique match or `replace_all`) |
| `run_command` | Run a shell command with captured output and a hard timeout |
| `get_time`, `echo` | Diagnostics |

All file and shell tools are confined to the workspace root (`--cwd`): paths
that resolve outside it are rejected, output is capped (command output keeps
head and tail so errors at the end of long logs survive), and commands are
killed (whole process tree) after a timeout, 30s by default.

**Approvals:** in a terminal, `write_file`, `edit_file`, and `run_command`
each ask for y/N confirmation before running (`--mode ask`, the default).
Pass `--mode agent` to run unattended. Non-TTY and serve-mode runs are
always unattended.

**Deletions:** in unattended runs, file-deletion commands (`rm`, `del`,
`Remove-Item`, `git clean`, `find -delete`, …) only run when every deletion
target is explicitly named in the user's request. Deletes the user asked for
("delete junk-notes.txt") go ahead; conflicts and ambiguity are refused so
the agent asks instead — files the request says to keep, files it never
named (a bare "clean up"), wildcard-only targets, and indirect deletes
(`git clean`, piped `Remove-Item`). In `--mode ask` the y/N prompt decides,
as for any shell command.

The system prompt is built per run by the context builder: platform, shell,
workspace root, and a top-level file listing, so the model starts oriented
instead of spending steps exploring. On the first turn, a planning pre-pass
asks the model for a short numbered plan before any tools run (skipped only
for empty prompts and simple read-and-answer goals). Task-type
heuristics (test-fix, debug, refactor, etc.) append focused constraints to
the user message. Thinking-capable models get Ollama's native `think` mode
enabled automatically (`--think` to control). Long transcripts are compacted
automatically — older turns are summarized by the model while the system
message and recent turns are kept verbatim. Compaction triggers on real
token usage: every request carries an explicit `num_ctx` (default 16384,
`--num-ctx` to change), and the loop watches the token counts Ollama reports
to compact before the window overflows.

## How the loop works

```
user goal
  -> POST /api/chat with tool schemas
  -> assistant replies with tool_calls?
       yes: execute each tool locally, append role=tool results, repeat
       no:  final answer, stop
stop conditions: no tool calls, max steps, cancellation
```

See `ROADMAP.md` for what is built and what is next.

## Tests

```powershell
node --test
```

Tests mock the Ollama client — no server or model required.

## Evals

```powershell
node evals/run.mjs --models llama3.2,qwen3-coder:30b
```

Runs real end-to-end tasks (answer from a README, create/edit files, find a
definition, run a command, fix a failing test) against live Ollama models in
throwaway temp workspaces, and reports pass rate, steps, and duration per
model. Use this to measure whether a runtime change actually improves agent
quality. `--task <name>` runs one task, `--json <file>` saves results,
`--verbose` traces tool calls. Exit code 2 means at least one task failed.

## Dev bench (agent + judge)

```powershell
npm run bench
node evals/dev-bench.mjs --tier 2
node evals/dev-bench.mjs --scenario greet-module --keep-workspace
```

Development benchmarks with **increasing complexity tiers** (simple module →
multi-file fixes → small CLI → HTTP API → refactor → log/CSV tools). Each
scenario runs halo-agent in a fresh temp workspace, then grades the outcome with
the **Cursor CLI** (`agent --model auto`) in read-only ask mode.

**Config:** `bench.config.json` in the project root, or `evals/bench.config.json`
— loaded automatically when present. CLI flags override config values.
`npm run bench` picks it up with no extra flags.

**Tier progression** (on by default): runs tier 1, then tier 2, … with a
per-tier summary. Stops early if the tier average score falls below
`progression.stopBelowScore` (default 50). Use `--flat` to run all scenarios
without pausing between tiers.

When complete, prints an **assessment report** with overall score, per-tier
breakdown, per-scenario scores, and ranked recommendations for improving
halo-agent. Reports are also written to `bench-latest.json` and
`bench-latest.md` (configurable).

| Flag | Meaning |
| --- | --- |
| `--config <path>` | Config file (default: `bench.config.json` or `evals/bench.config.json` if present) |
| `--tier <n>` | Run scenarios up to tier *n* |
| `--progression` / `--flat` | Enable or disable tier-by-tier progression |
| `--stop-below <score>` | Halt progression when tier average is below *score* |
| `--scenario <name>` | Run one scenario |
| `--scenarios a,b,c` | Run a subset |
| `--model <name\|auto>` | Ollama model for halo-agent |
| `--skip-judge` | Run agent only (no Cursor CLI) |
| `--judge-model auto` | Judge model (default `auto`) |
| `--keep-workspace` | Leave temp dir for inspection |
| `--json` / `--markdown` | Report output paths |
| `--no-report` | Skip writing report files |

Requires Ollama for the agent and the Cursor CLI (`agent`) for judging. Not a
release gate — run while iterating on the runtime.

## Recognized benchmarks (on demand)

Public leaderboard suites, **separate from the development bench**. Harbor
runs the hidden tests; the Cursor CLI then judges **each task** the same way
`npm run bench` does (score, grade, process notes, runtime recommendations).

```powershell
npm run bench:recognized -- --list
npm run bench:recognized -- --check
npm run bench:tb -- --include openssl-selfsigned-cert
node evals/recognized/run.mjs terminal-bench --dataset 2.1
node evals/recognized/run.mjs terminal-bench --from-job path\to\harbor\job
```

`--skip-judge` records only Harbor pass/fail. Default is to judge every trial.

Needs Docker, [Harbor](https://harborframework.com/) (`uv tool install harbor`),
Ollama reachable from containers (`host.docker.internal`), and the Cursor CLI
unless you skip the judge. Reports (JSON + markdown) go to
`../halo-agent-benchmark/recognized/<suite>/<run-id>/` plus `latest.json` /
`latest.md`.

SWE-bench Verified is listed as planned (`--list`); it is not wired yet.

## Layout

| Path | Purpose |
| --- | --- |
| `src/agent-loop.mjs` | Core plan/act/observe loop |
| `src/ollama-client.mjs` | Thin `/api/chat` client |
| `src/tool-registry.mjs` | Tool schema + executor dispatch, approval gating |
| `src/context-builder.mjs` | Environment + workspace snapshot for the system prompt |
| `src/compaction.mjs` | Summarizes old turns when the transcript outgrows its budget |
| `src/prompt-enhancements.mjs` | Task hints, planning pre-pass, Ollama think resolution |
| `src/openai-server.mjs` | `/v1/chat/completions` facade over the loop |
| `src/session-store.mjs` | Persist/resume sessions with step log and changed files |
| `src/model-routing.mjs` | Tool-capable detection and installed-model resolution |
| `src/mcp-client.mjs` | Stdio MCP client + registry bridge for external tools |
| `src/index.mjs` | SDK entry point (`createAgent` and all public exports) |
| `src/tools/builtin.mjs` | Registers the standard tool set (diagnostics + file + shell) |
| `src/tools/fs.mjs` | Workspace-scoped file tools and path/output guards |
| `src/tools/search.mjs` | `grep_search` and `find_files` over the workspace tree |
| `src/tools/web-search.mjs` | `web_search` via DuckDuckGo HTML results |
| `src/tools/fetch-url.mjs` | `fetch_url` with HTML extract + micro-RAG |
| `src/tools/shell.mjs` | `run_command` with tree-kill timeout |
| `src/cli.mjs` | Command-line entry point |
| `evals/` | Live-model eval harness (`evals/run.mjs`), dev bench (`evals/dev-bench.mjs`), recognized benches (`evals/recognized/`) |

## Relationship to Aura Wire

halo-agent is a standalone product, but **Wire is the pairing that completes it**:
Wire provides the OpenAI `/v1` front door, routing rules, cost observability,
compression, and guardrails; halo-agent provides the loop and local tool execution.
IDE integration is deliberately Wire's job — editors point at Wire, and Wire
routes to halo-agent as a custom provider via `halo-agent serve` (the
OpenAI-compatible door, roadmap item 10). Composition is HTTP only, no shared
code. Details from the Aura Wire side: `aura-wire/docs/halo-agent-integration.md`.
