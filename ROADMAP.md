# Bitfield Ollama Agent — product roadmap

Turn Ollama's completion API into a local agent runtime. Work through this list in order.

## North star

A free-to-nearly-free, super-flexible agent: free on local Ollama, near-free when
paired with **Aura Wire** routing to cheap backends. Two product surfaces — **CLI**
and **SDK** — with maximum compatibility at every angle (OpenAI API, standard tool
schemas, MCP, any Ollama model). **IDE integration ships via Wire**, not as
Bitfield Ollama Agent extensions: editors point at Wire's `/v1` door and Wire routes here.

| # | Area | Status | Notes |
|---|------|--------|-------|
| 1 | **Agent loop** | done (v2) | Thin Cursor-style loop: model -> tool calls -> execute -> repeat until the model stops. Hooks (`beforeToolCall`, `afterToolCall`, `stop`), `steer()` / `queue()`, transient retries, tool-call parse recovery, step + wall-clock safety caps with a plain-text wrap-up. No built-in planning, grading, nudging, or mid-run model swaps — those are the model's job and the caller's hooks |
| 2 | **Ollama client** | done (v1) | `/api/chat` with tools; `chatStream` NDJSON + loop/`serve` live SSE |
| 3 | **Builtin tools** | done (v2) | `read_file`, `write_file`, `edit_file`, `list_dir`, `grep_search`, `find_files`, `search_project`, `fetch_rule`, `web_search`, `fetch_url`, `run_command` + diagnostics; workspace-scoped paths, command timeouts. Long output spills to `.bf/bf-agent/tool-output/` (head + tail + path) instead of being truncated. Files are checkpointed before writes (`bf-agent checkpoints list\|restore`) |
| 4 | **Tool registry** | done (v1) | Schema + executor dispatch; MCP later |
| 5 | **CLI** | done (v1) | `bf-agent "prompt"` against local Ollama |
| 6 | **Context builder** | done (v2) | Cursor-shaped context: short core prompt + model overlay; instruction files inlined, other rules indexed for `fetch_rule`, nested `AGENTS.md` listed; environment with git snapshot and top-level listing; MCP tool index. Nothing task-specific in the prompt, no first-turn README/RAG injection — the model gathers context with tools |
| 7 | **Compaction** | done (v2) | Token/char-budget trigger; old turns summarized by the model, original request kept verbatim, session transcript path referenced so dropped detail is recoverable; system + recent turns kept verbatim |
| 8 | **Safety / approvals** | done (v1) | Ask vs agent mode; write/shell tools gated behind y/N prompt in a TTY; sandbox still future work |
| 9 | **Session persistence** | done (v1) | `--session <name>`: transcript, step log, changed-files summary under `.bf/bf-agent/sessions/` |
| 10 | **OpenAI-compatible server** | done (v1) | `bf-agent serve`: `/v1/chat/completions` (+live SSE via `onDelta`, `/v1/models`) facade over the loop; the door Wire routes IDE traffic through |
| 11 | **SDK** | done (v1) | `src/index.mjs` public surface + `createAgent()` one-call setup; package `exports` wired |
| 12 | **Model routing** | done (v2) | Tool/thinking/vision detection via `/api/show`; `auto` picks the strongest installed model that fits (VRAM-aware), cloud only when no local model qualifies; tier presets and `models.yaml` bands. Routing happens once at startup — no mid-run escalation ladder |
| 13 | **RAG / memory** | resolved (no build) | Not Bitfield Ollama Agent's job: internal state is covered by compaction (7) + sessions (9); corpus RAG is Terran's domain via Aura Wire / MCP. Web facts use builtin `web_search` (DuckDuckGo). Local project index remains as the `search_project` tool; the model calls it when useful |
| 14 | **MCP** | done (v2) | Stdio MCP client (initialize, tools/list, tools/call); `--mcp "<command>"` attaches servers. Tools are listed by name + one line in the prompt and reached through `describe_tool` / `call_mcp_tool`, so schemas cost nothing until used (`registerMcpTools(..., { lazy: false })` for the eager `mcp_<name>` bridge) |
| 15 | **Provider clients / Copilot supervisor** | done (v1) | `--provider ollama\|openai\|anthropic\|copilot`. Ollama remains zero-dep default; openai/anthropic load optional peer SDKs as thin LLM adapters; copilot nests `@github/copilot-sdk` under a supervisor loop (`delegate_copilot` + completion-guard stop hook). Does **not** replace Aura Wire for routed paid `/v1` / IDE. `serve` stays Ollama-backed |

## Compatibility commitments

- **OpenAI API** — `/v1/chat/completions` in and out (item 10); clients need no Bitfield Ollama Agent awareness.
- **Tool schemas** — OpenAI function shape everywhere (already true in the registry).
- **MCP** — external tools plug in without forking the runtime (item 14).
- **Models** — any Ollama model; degrade gracefully when native tool calling is weak (item 12).
- **Wire** — reachable as a stock custom provider; no Wire-specific protocol.

## Agent loop contract (item 1)

```
messages = [system, user goal]
repeat:
  response = model(messages, tools)
  if no tool_calls:
      hooks.stop may return { followupMessage } -> append as user, continue
      else: turn over; a queue()d follow-up starts a new turn, otherwise return text
  for each tool call:
      hooks.beforeToolCall may return { block } -> error result, tool not run
      execute tool; hooks.afterToolCall may return { note }
      append role=tool result
  deliver steer() messages as user turns
```

Stop conditions: the model stops calling tools, `maxSteps` or `wallClockMs`
exhausted (the loop asks for a plain-text wrap-up first), cancellation.
Tool failures do not stop the loop — the error is returned to the model as the
tool result so it can recover or report. Transient Ollama failures are
retried; malformed tool calls get one correction and a retry. Nothing else is
injected: verification, planning, and task knowledge come from the model,
rules files, and hooks.
