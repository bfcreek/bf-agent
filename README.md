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

Options:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--model <name>` | `llama3.2` | Ollama model to drive the loop |
| `--base-url <url>` | `http://127.0.0.1:11434` | Ollama server |
| `--max-steps <n>` | `10` | Max model round-trips before the loop stops |
| `--cwd <path>` | current directory | Workspace root that file and shell tools are confined to |
| `--quiet` | off | Suppress step trace; print only the final answer |

## Builtin tools

| Tool | What it does |
| --- | --- |
| `read_file` | Read a file (optionally a line range); long output is truncated |
| `list_dir` | List a directory; subdirectory names end with `/` |
| `write_file` | Create or overwrite a file, creating parent directories |
| `edit_file` | Replace an exact snippet in a file (unique match or `replace_all`) |
| `run_command` | Run a shell command with captured output and a hard timeout |
| `get_time`, `echo` | Diagnostics |

All file and shell tools are confined to the workspace root (`--cwd`): paths
that resolve outside it are rejected, command output is capped, and commands
are killed (whole process tree) after a timeout, 30s by default.

**No approval gate yet** — the agent reads, writes, and runs commands in the
workspace without asking. Point `--cwd` at a directory you are comfortable
letting the model modify. Interactive approvals and write gates are roadmap
item 8.

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

## Layout

| Path | Purpose |
| --- | --- |
| `src/agent-loop.mjs` | Core plan/act/observe loop |
| `src/ollama-client.mjs` | Thin `/api/chat` client |
| `src/tool-registry.mjs` | Tool schema + executor dispatch |
| `src/tools/builtin.mjs` | Registers the standard tool set (diagnostics + file + shell) |
| `src/tools/fs.mjs` | Workspace-scoped file tools and path/output guards |
| `src/tools/shell.mjs` | `run_command` with tree-kill timeout |
| `src/cli.mjs` | Command-line entry point |

## Relationship to Aura Wire

halo-agent is a standalone product, but **Wire is the pairing that completes it**:
Wire provides the OpenAI `/v1` front door, routing rules, cost observability,
compression, and guardrails; halo-agent provides the loop and local tool execution.
IDE integration is deliberately Wire's job — editors point at Wire, and Wire routes
to halo-agent as a custom provider once the OpenAI-compatible server ships
(roadmap item 10). Composition is HTTP only, no shared code. Details from the
Aura Wire side: `aura-wire/docs/halo-agent-integration.md`.
