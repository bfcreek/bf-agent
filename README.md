# Bitfield Agent (`bf-agent`)

Local agent runtime that turns Ollama's completion API into a multi-step agent:
the model calls tools, observes results, and repeats until the task is done —
all on this machine. The harness is modeled on Cursor's: a short system
prompt plus your rules files, a tool set the model uses to find its own
context, and a thin loop with hooks where callers add policy.

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
| **IDE integration via Wire** | Bitfield Agent ships no IDE extensions. Editors reach it through Aura Wire's `/v1` door and routing rules — Wire owns the IDE story |
| **Local-first, private** | Prompts, tools, and files stay on this machine unless you explicitly route elsewhere |

## Requirements

- Node.js 20+
- [Ollama](https://ollama.com) running locally (default `http://127.0.0.1:11434`)
- A tool-capable model installed, e.g. `ollama pull llama3.2` or `ollama pull qwen3-coder:30b`

No npm dependencies — the runtime uses only Node built-ins.

## Install

Published releases:

```powershell
npm install -g @bitfieldcreek/bf-agent
bf-agent models
bf-agent "what time is it right now?"
```

Try without installing:

```powershell
npx @bitfieldcreek/bf-agent "summarize README.md"
```

Or download the zip from [Explore](https://www.bitfieldcreek.com/explore#bf-agent) and use the `bin/` launchers below.

**Bitfield Agent** (`bf-agent`) is proprietary software — free for personal, non-commercial use. See [LICENSE](LICENSE) and the [Bitfield Creek EULA](https://www.bitfieldcreek.com/eula).

From a git checkout, use `node src/cli.mjs` or the launchers in `bin/`.

## Quick start

```powershell
node src/cli.mjs "what time is it right now?"
```

Or use the launchers in `bin/`, which check that Node.js 20+ is installed
(and print install instructions if not) before forwarding every argument to
the CLI:

```powershell
.\bin\bf-agent.ps1 "what time is it right now?"   # PowerShell
bin\bf-agent.cmd "what time is it right now?"      # cmd
./bin/bf-agent.sh "what time is it right now?"     # macOS / Linux
```

Options:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--model <name\|auto>` | `auto` | Ollama model to drive the loop; `auto` picks the best installed model (see below) |
| `--base-url <url>` | `http://127.0.0.1:11434` | Ollama server |
| `--max-steps <n>` | `100` | Safety cap on model round-trips per turn (the model decides when it is done; this only stops runaways) |
| `--wall-clock <sec>` | off | Wall-clock budget for the run; the loop wraps up before the deadline instead of being killed |
| `--num-ctx <n>` | `16384` | Context window (tokens) sent to Ollama on every call — Ollama's own default is small and overflows silently |
| `--cwd <path>` | current directory | Workspace root that file and shell tools are confined to |
| `--mode <ask\|agent>` | `ask` in a terminal, `agent` otherwise | `ask` confirms each write/shell call with a y/N prompt; `agent` runs unattended |
| `--session <name>` | off | Persist and resume this conversation (`.halo-agent/sessions/` in the workspace) |
| `--mcp "<command>"` | none | Attach an MCP server over stdio (repeatable); tools are listed by name and fetched on demand |
| `--no-checkpoints` | off | Do not snapshot files before `write_file` / `edit_file` |
| `--quiet` | off | Suppress step trace; print only the final answer |
| `--think <mode>` | `auto` | Native model reasoning: `auto`, `true`, `false`/`off`, or `low`/`medium`/`high`/`max` |

The model is resolved against Ollama's installed list at startup. With
`auto` (the default), Bitfield Agent picks the strongest installed model that
supports both tool calling and thinking, has at least 7B parameters, and
fits comfortably in this machine's memory — a model too weak to finish agent
tasks wastes more than it saves. When no local model qualifies, an installed
[Ollama cloud](https://ollama.com/cloud) model is used instead: local-first,
cloud only when we must. Explicit `--model` names are always honored
(untagged names match their tags, so `llama3.2` finds `llama3.2:latest`)
with a warning when the choice looks too weak; missing names fall back to
auto-selection. Capabilities are asked of Ollama itself (`/api/show`), so
new models classify correctly; a family-name list is the fallback for older
Ollama versions. `bf-agent models` shows the classification and what
`auto` would pick.

Sessions store the full transcript, an accumulated step log, and the list of
files the agent changed. Re-running with the same `--session` name continues
the conversation with prior context.

**Checkpoints:** before `write_file` or `edit_file` touches a file, its
pre-edit contents are copied under `.halo-agent/checkpoints/<run-id>/` (first
snapshot per file per run). `bf-agent checkpoints list` shows runs;
`bf-agent checkpoints restore <run-id>` puts every file in that run back
(files the run created are deleted). Sessions record the run id.

## OpenAI-compatible server

```powershell
node src/cli.mjs serve --port 11435
```

Exposes the agent loop behind the standard OpenAI API so any existing client
(or Aura Wire routing rule) can use it with no Bitfield Agent awareness:

- `POST /v1/chat/completions` — messages in, agent loop (with tools) runs,
  `chat.completion` out. `stream: true` forwards content tokens live from
  Ollama as SSE chunks (falls back to replaying the finished answer when the
  backend has no `chatStream`). A `model` in the request overrides the default.
- `GET /v1/models` — installed Ollama models.

Serve mode always runs unattended (`agent` mode): there is no terminal to
prompt for approvals. Put Wire's guardrails in front if you need policy.

## Docker Compose

Ollama + `bf-agent serve` (`/v1` on port 11435). The agent workspace is
`./workspace` → `/workspace`. Bench and test output use the sibling
`halo-agent-benchmark` folder → `/halo-agent-benchmark` (same tree as
`npm run bench` and `.\bin\bench-tb.ps1`). Copy `.env.example` to `.env` to
change model, ports, or those paths.

```powershell
docker compose up --build
docker compose --profile pull up ollama-pull
docker compose exec ollama ollama pull llama3.2
docker compose run --rm bf-agent models
docker compose run --rm bf-agent "what time is it right now?"
```

NVIDIA GPU for Ollama:

```powershell
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build
```

Already running Ollama on the host (typical for Terminal-Bench / Harbor, which
reach it at `host.docker.internal:11434`):

```powershell
docker compose -f docker-compose.host-ollama.yml up --build
```

## SDK

The same machinery is embeddable — `createAgent()` wires up the client,
builtin tools, context-built system prompt, checkpoints, and compaction in
one call:

```js
import { createAgent } from "@bitfieldcreek/bf-agent";

const agent = await createAgent({
  model: "qwen3-coder:30b",
  workspaceRoot: "/path/to/project",
  tools: [{ name: "deploy", description: "Deploy the app.", execute: () => "done" }],
  approvalHandler: async ({ name, args }) => confirmSomehow(name, args),
  hooks: {
    // Refuse a tool call; the reason goes back to the model as the result.
    beforeToolCall: ({ name, args }) =>
      name === "run_command" && /git push/.test(args.command) ? { block: "no pushes from CI" } : undefined,
    // Keep the turn going when the model stops too early (Cursor's stop hook).
    stop: ({ text, steps }) =>
      steps.some((s) => s.toolCalls.some((c) => c.name === "run_command")) ? undefined : { followupMessage: "Run the tests before finishing." },
  },
});

const run = agent.run("run the tests and fix any failure");
agent.steer("also check the lint output");   // delivered after the next tool results
agent.queue("then summarize what changed");  // runs as a new turn once this one ends
const { text, steps } = await run;
```

Hooks are the policy surface: `beforeToolCall` (block or observe),
`afterToolCall` (annotate a result), and `stop` (send a follow-up user
message, bounded by `maxStopHookLoops`). Verification, planning, and
"keep going until X" belong there and in rules files, not in the loop.

Every piece is also exported individually (`AgentLoop`, `ToolRegistry`,
`OllamaClient`, `createOpenAIServer`, `SessionStore`, `CheckpointStore`,
`McpClient`, ...) for setups that need different wiring. External MCP tools
bridge in via `registerMcpTools(agent.registry, await McpClient.connect({ command: "..." }))`.

## Builtin tools

| Tool | What it does |
| --- | --- |
| `read_file` | Read a file (optionally a line range) |
| `list_dir` | List a directory; subdirectory names end with `/` |
| `grep_search` | Regex search over file contents (`path:line: text`); prunes `node_modules`, `.git`, etc., skips binaries |
| `find_files` | Find files by glob (`*.mjs`, `src/**/*.js`) |
| `search_project` | Semantic search over the local project index (when an embedding model is available) |
| `fetch_rule` | Read a `.cursor/rules` rule the system prompt listed by name |
| `web_search` | Search the public web via DuckDuckGo (titles, URLs, snippets) |
| `fetch_url` | Fetch a page and return text; optional `query` runs micro-RAG for top passages |
| `write_file` | Create or overwrite a file, creating parent directories (checkpointed) |
| `edit_file` | Replace an exact snippet in a file (unique match or `replace_all`; checkpointed) |
| `run_command` | Run a shell command with captured output and a hard timeout |
| `describe_tool`, `call_mcp_tool` | Fetch an MCP tool's schema and invoke it (present when `--mcp` servers are attached) |
| `get_time`, `echo` | Diagnostics |

All file and shell tools are confined to the workspace root (`--cwd`): paths
that resolve outside it are rejected, and commands are killed (whole process
tree) after a timeout, 30s by default. Long tool output is never silently
truncated: past 32k characters the full text is written to
`.halo-agent/tool-output/` and the model gets the head, the tail, and the
path, so it can `read_file` or `grep_search` the rest.

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

## Context

Context follows Cursor's model: a small static block up front, everything
else discovered on demand with tools. The system prompt is built per run:

1. **Core instructions** — a short prompt about how to work (gather context
   with tools, read before editing, verify, keep going until done),
   communication, scope, and git/deletion safety. No task-type text lives
   here; that belongs in your rules files.
2. **Model overlay** — a few lines of family-specific guidance (e.g. for
   `gpt-oss`) when the model needs it.
3. **Instruction files** — user `instructions.md`, workspace `AGENTS.md` /
   `CLAUDE.md` / `.cursorrules`, and always-apply `.cursor/rules` inlined;
   described or file-scoped rules listed by name for `fetch_rule`; nested
   `AGENTS.md` files listed by path for `read_file`.
4. **Environment** — platform, shell, workspace root, current date, a git
   snapshot (branch + short status, like Cursor's `git_status` block), and
   the top-level directory listing.
5. **MCP tool index** — attached MCP tools by name and one-line description.

The user's message is sent as written — no hints, plans, or wrappers are
added. README contents, project search results, and everything else come
in through the model's own tool calls, so the prompt stays small and the
model sees exactly what it asked for.

Thinking-capable models get Ollama's native `think` mode enabled
automatically (`--think` to control). Long transcripts are compacted
automatically — older turns are summarized by the model while the system
message and recent turns are kept verbatim; the summary keeps the original
request word for word and, with `--session`, points at the transcript file
so dropped details can be re-read. Compaction triggers on real token usage:
every request carries an explicit `num_ctx` (default 16384, `--num-ctx` to
change), and the loop watches the token counts Ollama reports to compact
before the window overflows.

## Instruction files

Each run loads Cursor-style instruction files into the system prompt (after
the core instructions, before the environment snapshot). Missing files are
skipped. Inlined text is capped at 6000 characters per file and 12000
characters total.

**Apply order**

1. User `instructions.md` (if present)
2. Workspace root files, in this order: `AGENTS.md`, `CLAUDE.md`, `.cursorrules`
3. Always-apply rules from `.cursor/rules/` (`.mdc` or `.md`, sorted by name)
4. An index of the remaining rules (name, globs, description) the model can
   pull in with `fetch_rule`, and of nested `AGENTS.md` files (up to four
   directories deep, skipping `node_modules`, `.git`, build output) the model
   should `read_file` before working in that directory

**User instructions** — persistent personal rules, like Cursor user rules.
Create `instructions.md` in the agent config directory (same folder as
`config.yaml`):

| Platform | Default path |
| --- | --- |
| Windows | `%APPDATA%\halo-agent\instructions.md` |
| macOS / Linux | `~/.config/halo-agent/instructions.md` |

Override the directory with `HALO_AGENT_CONFIG_DIR`. `bf-agent config edit`
creates `config.yaml` there; `instructions.md` is optional and is not
created automatically.

**Workspace instructions** — project rules checked into the repo:

| File | When it applies |
| --- | --- |
| `AGENTS.md` | Always, if present at the workspace root (`--cwd`) |
| `CLAUDE.md` | Always, if present at the workspace root |
| `.cursorrules` | Always, if present at the workspace root |
| `.cursor/rules/*.mdc` or `*.md` | When the rule is always-apply (see below) |

Cursor `.mdc` frontmatter is honored:

```markdown
---
description: Core coding standards
alwaysApply: true
---

Match existing style. Do not add docs the user did not ask for.
```

| Frontmatter | Inlined? |
| --- | --- |
| `alwaysApply: true` | Yes |
| `alwaysApply: false` | No — listed for `fetch_rule` |
| `globs:` (and no `alwaysApply: true`) | No — listed with its globs for `fetch_rule` |
| `description:` only | No — listed with its description for `fetch_rule` (Cursor's "apply intelligently") |
| No frontmatter / no globs / no description | Yes |

Put cross-cutting project rules in `AGENTS.md` or an `alwaysApply: true`
`.mdc`. Give task-specific rules a `description` so the model can decide when
to fetch them; they cost nothing in the prompt until used.

## How the loop works

```
messages = [system, user goal]
repeat:
  response = model(messages, tools)
  if no tool calls:
      stop hook may send a follow-up user message and continue
      otherwise the turn is over (queued follow-ups start a new turn)
  execute each tool call (beforeToolCall may block, afterToolCall may annotate)
  append role=tool results
  deliver any steer() message the caller sent meanwhile
stop conditions: model stops calling tools, max steps / wall clock (with a
plain-text wrap-up), cancellation
```

The loop owns only transport robustness (retries on transient errors,
tool-call parse recovery), compaction, the step and wall-clock safety caps,
and the steer/queue channels. It does not plan, grade, nudge, or swap
models mid-run — the model does the work, rules files carry the task
knowledge, and hooks carry the caller's policy.

See `ROADMAP.md` for what is built and what is next.

## Release (maintainers)

Staging (R2 zip upload only — no npm):

```powershell
.\scripts\release\publish-release.ps1 -BumpPatch
```

Production (after [admin promote](https://www.bitfieldcreek.com/admin/releases)):

```powershell
.\scripts\release\publish-production.ps1
```

`publish-production.ps1` verifies production `latest.yml` matches `package.json`, then runs `npm publish`. Credentials: `scripts/release/.env.release` (`R2_*` for staging, `NPM_TOKEN` for production npm).

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

Host-only. No Harbor. Recommendations and scores come from this run.

```powershell
.\bin\bench-local.ps1
.\bin\bench-local.ps1 -SkipJudge
.\bin\bench-local.ps1 -Tier 2
.\bin\bench.ps1
npm run bench
node evals/dev-bench.mjs --tier 2
node evals/dev-bench.mjs --scenario greet-module --keep-workspace
```

Development benchmarks with **increasing complexity tiers** (simple module →
multi-file fixes → small CLI → HTTP API → refactor → log/CSV tools). Each
scenario runs Bitfield Agent in a fresh temp workspace, then grades the outcome with
the **Cursor CLI** (`agent --model auto`) in read-only ask mode.

**Config:** `bench.config.json` in the project root, or `evals/bench.config.json`
— loaded automatically when present. CLI flags override config values.
`npm run bench` picks it up with no extra flags.

**Tier progression** (on by default): runs tier 1, then tier 2, … with a
per-tier summary. Stops early if the tier average score falls below
`progression.stopBelowScore` (default 50). Use `--flat` to run all scenarios
without pausing between tiers.

When complete, prints an **assessment report** with overall score, per-tier
breakdown, per-scenario scores, and ranked judge recommendations. Reports
are also written to `../halo-agent-benchmark/local/latest.json` and
`latest.md` (configurable via `report` in `evals/bench.config.json`). Scenario
workspaces live under `../halo-agent-benchmark/<language>/…`; recognized
(Terminal-Bench) reports under `../halo-agent-benchmark/recognized/`.

### How a run is graded

Every scenario gets two scores, kept separate on purpose:

- **Outcome (0–100)** — did the deliverable satisfy the task. When the
  scenario has a mechanical oracle (the scenario `precheck`, or the Harbor
  hidden-test reward on Terminal-Bench), that result fixes the band: a pass
  lands in 70–100, a fail in 0–50, and the judge places the score within the
  band. The judge's own number is kept as `outcome.judgeScore`, and
  `agreesWithOracle` is recorded so a loose or flaky precheck shows up as a
  disagreement rather than as agent quality.
- **Process (0–100)** — how efficiently it got there. This is the
  "meta-judge" and it has two layers. `evals/efficiency.mjs` computes
  deterministic metrics straight from the trace (steps, tool calls by
  category, tokens, time, and waste flags such as `spinning`,
  `redundant-reads`, `blind-edit`, `no-verification`, `budget-exhausted`).
  Those numbers go into the judge prompt as evidence, and the Cursor judge
  adds the qualitative read — detours, disproportionate exploration, steps it
  considers wasted — as `process.score`, `process.notes`, and
  `process.wastedSteps`. The deterministic `heuristicScore` is a comparison
  aid across runs, not a grade.

The judge sees the task, the agent's final answer, a step summary, the
efficiency block, and the **change set**: a unified diff of every file the
agent touched, built from the run's checkpoints (`.halo-agent/checkpoints/`)
paired with the final workspace. Files changed only through shell commands
are not checkpointed, so a paths-and-sizes listing of the workspace is
included as a fallback, and Harbor trials with no collected `/app` artifact
fall back to the trial directory. The judge input (artifacts JSON, step
summary, full prompt) is written to `.halo-bench/` inside the scenario
workspace, so `--keep-workspace` leaves everything needed to re-derive a
verdict.

The scoreboard (`../halo-agent-benchmark/local/scoreboard-history.jsonl`) records `avgScore`,
`avgProcessScore`, `passRate`, `avgSteps`, `avgToolCalls`,
`avgPromptTokens`, `verifiedRate`, `avgHeuristicScore`, and `flagCounts` per
run, so a prompt or tool change can be judged on cost as well as correctness.

To re-analyze a report or the scoreboard history alone:

```bash
npm run bench:patterns -- --report ../halo-agent-benchmark/local/latest.json
npm run bench:patterns -- --scoreboard ../halo-agent-benchmark/local/scoreboard-history.jsonl
```

| Flag | Meaning |
| --- | --- |
| `--config <path>` | Config file (default: `bench.config.json` or `evals/bench.config.json` if present) |
| `--tier <n>` | Run scenarios up to tier *n* |
| `--progression` / `--flat` | Enable or disable tier-by-tier progression |
| `--stop-below <score>` | Halt progression when tier average is below *score* |
| `--scenario <name>` | Run one scenario |
| `--scenarios a,b,c` | Run a subset |
| `--model <name\|auto>` | Ollama model for Bitfield Agent |
| `--skip-judge` | Run agent only (no Cursor CLI) |
| `--judge-model auto` | Judge model (default `auto`) |
| `--keep-workspace` | Leave temp dir for inspection |
| `--json` / `--markdown` | Report output paths |
| `--no-report` | Skip writing report files |

Requires Ollama for the agent and the Cursor CLI (`agent`) for judging. Not a
release gate — run while iterating on the runtime.

## Recognized benchmarks (on demand)

Public leaderboard suites, **separate from the local development bench**.
Harbor runs each Terminal-Bench task in Docker; that is why this launcher
uses Docker. For scores and recommendations without Harbor, use
`.\bin\bench-local.ps1`.

```powershell
.\bin\bench-tb.ps1
.\bin\bench-tb.ps1 -Check
.\bin\bench-tb.ps1 -SkipJudge
.\bin\bench-tb.ps1 -Include openssl-selfsigned-cert
.\bin\bench-tb-mini.ps1
.\bin\bench-tb-mini.ps1 -Count 5 -Seed 42
.\bin\bench-tb.ps1 -FromJob path\to\harbor\job
.\bin\bench-tb.ps1 -Compose
npm run bench:tb:mini
npm run bench:recognized -- --list
```

`bench-tb-mini` shuffles the Terminal-Bench 2.1 catalog and runs **5** tasks (override with `-Count`). That is not Harbor `--n-tasks`, which takes the first N after filters. The chosen names and RNG seed are printed (`sample: … (seed N)`); pass `-Seed` / `--seed` to repeat the same draw. `--include` still works: the sample is drawn from that list instead of the full catalog.

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
| `src/agent-loop.mjs` | Thin Cursor-style loop: model -> tools -> repeat, with hooks, steer/queue, retries, safety caps |
| `src/ollama-client.mjs` | Thin `/api/chat` client |
| `src/tool-registry.mjs` | Tool schema + executor dispatch, approval gating |
| `src/context-builder.mjs` | System prompt: instruction files, rule index, git snapshot, environment |
| `src/compaction.mjs` | Summarizes old turns when the transcript outgrows its budget |
| `src/checkpoints.mjs` | Pre-edit file snapshots under `.halo-agent/checkpoints/` with list/restore |
| `src/model-tuning.mjs` | Per-model-family settings: think mode, prompt overlay |
| `src/openai-server.mjs` | `/v1/chat/completions` facade over the loop |
| `src/session-store.mjs` | Persist/resume sessions with step log and changed files |
| `src/model-routing.mjs` | Tool-capable detection and installed-model resolution |
| `src/mcp-client.mjs` | Stdio MCP client + lazy registry bridge (`describe_tool` / `call_mcp_tool`) |
| `src/index.mjs` | SDK entry point (`createAgent` and all public exports) |
| `src/tools/builtin.mjs` | Registers the standard tool set (diagnostics + file + search + rules + shell) |
| `src/tools/fs.mjs` | Workspace-scoped file tools and path guards |
| `src/tools/output.mjs` | Spills long tool output to `.halo-agent/tool-output/` (head + tail + path) |
| `src/tools/search.mjs` | `grep_search` and `find_files` over the workspace tree |
| `src/tools/web-search.mjs` | `web_search` via DuckDuckGo HTML results |
| `src/tools/fetch-url.mjs` | `fetch_url` with HTML extract + micro-RAG |
| `src/tools/shell.mjs` | `run_command` with tree-kill timeout |
| `src/cli.mjs` | Command-line entry point |
| `Dockerfile` | Image for `bf-agent serve` (and one-shot CLI via `compose run`) |
| `docker-compose.yml` | Ollama + Bitfield Agent; see `docker-compose.gpu.yml` and `docker-compose.host-ollama.yml` |
| `evals/` | Live-model eval harness (`evals/run.mjs`), dev bench (`evals/dev-bench.mjs`), recognized benches (`evals/recognized/`) |

## Relationship to Aura Wire

Bitfield Agent is a standalone product, but **Wire is the pairing that completes it**:
Wire provides the OpenAI `/v1` front door, routing rules, cost observability,
compression, and guardrails; Bitfield Agent provides the loop and local tool execution.
IDE integration is deliberately Wire's job — editors point at Wire, and Wire
routes to Bitfield Agent as a custom provider via `bf-agent serve` (the
OpenAI-compatible door, roadmap item 10). Composition is HTTP only, no shared
code. Details from the Aura Wire side: `aura-wire/docs/halo-agent-integration.md`.
