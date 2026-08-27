# halo-agent — product roadmap

Turn Ollama's completion API into a local agent runtime. Work through this list in order.

## North star

A free-to-nearly-free, super-flexible agent: free on local Ollama, near-free when
paired with **Aura Wire** routing to cheap backends. Two product surfaces — **CLI**
and **SDK** — with maximum compatibility at every angle (OpenAI API, standard tool
schemas, MCP, any Ollama model). **IDE integration ships via Wire**, not as
halo-agent extensions: editors point at Wire's `/v1` door and Wire routes here.

| # | Area | Status | Notes |
|---|------|--------|-------|
| 1 | **Agent loop** | done (v1) | ReAct loop: model -> tool calls -> execute -> repeat until done |
| 2 | **Ollama client** | done (v1) | `/api/chat` with tools; `chatStream` NDJSON + loop/`serve` live SSE |
| 3 | **Builtin tools** | done (v1) | `read_file`, `write_file`, `edit_file`, `list_dir`, `run_command` + diagnostics; workspace-scoped paths, output caps, command timeouts. Approvals land with item 8 |
| 4 | **Tool registry** | done (v1) | Schema + executor dispatch; MCP later |
| 5 | **CLI** | done (v1) | `halo-agent "prompt"` against local Ollama |
| 6 | **Context builder** | done (v1) | System prompt gets platform/shell/cwd + top-level listing; head+tail trimming for command output |
| 7 | **Compaction** | done (v1) | Char-budget trigger; old turns summarized by the model, system + recent turns kept verbatim |
| 8 | **Safety / approvals** | done (v1) | Ask vs agent mode; write/shell tools gated behind y/N prompt in a TTY; sandbox still future work |
| 9 | **Session persistence** | done (v1) | `--session <name>`: transcript, step log, changed-files summary under `.halo-agent/sessions/` |
| 10 | **OpenAI-compatible server** | done (v1) | `halo-agent serve`: `/v1/chat/completions` (+live SSE via `onDelta`, `/v1/models`) facade over the loop; the door Wire routes IDE traffic through |
| 11 | **SDK** | done (v1) | `src/index.mjs` public surface + `createAgent()` one-call setup; package `exports` wired |
| 12 | **Model routing** | done (v1) | Tool-capable family detection; requested model resolved against installed list with fallback + warnings at startup |
| 13 | **RAG / memory** | resolved (no build) | Not halo-agent's job: internal state is covered by compaction (7) + sessions (9); corpus RAG is Terran's domain via Aura Wire / MCP. Web facts use builtin `web_search` (DuckDuckGo). Local project index remains for workspace retrieval |
| 14 | **MCP** | done (v1) | Stdio MCP client (initialize, tools/list, tools/call); `--mcp "<command>"` attaches servers, tools bridge in as `mcp_<name>` |

## Compatibility commitments

- **OpenAI API** — `/v1/chat/completions` in and out (item 10); clients need no halo-agent awareness.
- **Tool schemas** — OpenAI function shape everywhere (already true in the registry).
- **MCP** — external tools plug in without forking the runtime (item 14).
- **Models** — any Ollama model; degrade gracefully when native tool calling is weak (item 12).
- **Wire** — reachable as a stock custom provider; no Wire-specific protocol.

## Agent loop contract (item 1)

```
User goal
  -> append to messages[]
  -> POST Ollama /api/chat (with tool schemas)
  -> if assistant message has tool_calls:
        execute each tool
        append role=tool messages
        goto loop (max N steps)
  -> else return final assistant text
```

Stop conditions: no tool calls, `maxSteps` exceeded, cancellation.
Tool failures do not stop the loop — the error is returned to the model as the
tool result so it can recover or report.
