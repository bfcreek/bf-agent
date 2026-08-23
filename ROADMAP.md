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
| 2 | **Ollama client** | done (v1) | `/api/chat` with tools; streaming deferred |
| 3 | **Builtin tools** | done (v1) | `read_file`, `write_file`, `edit_file`, `list_dir`, `run_command` + diagnostics; workspace-scoped paths, output caps, command timeouts. Approvals land with item 8 |
| 4 | **Tool registry** | done (v1) | Schema + executor dispatch; MCP later |
| 5 | **CLI** | done (v1) | `halo-agent "prompt"` against local Ollama |
| 6 | **Context builder** | pending | cwd, selective files, output trimming |
| 7 | **Compaction** | pending | Summarize old turns when context fills |
| 8 | **Safety / approvals** | pending | Ask vs agent mode, write gates, sandbox |
| 9 | **Session persistence** | pending | Resume tasks, step log, diff summary |
| 10 | **OpenAI-compatible server** | pending | `/v1/chat/completions` facade over the loop; the door Wire routes IDE traffic through |
| 11 | **SDK** | pending | Public embedding API over loop/registry/client (today's modules are the seed); semver, typed, examples |
| 12 | **Model routing** | pending | Tool-capable model detection, fallbacks |
| 13 | **RAG / memory** | pending | Local index or Terran integration |
| 14 | **MCP** | pending | Extension point for external tools |

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
