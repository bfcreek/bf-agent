# Context window spec

What halo-agent puts in front of the model on every call, what that costs in
tokens, and the smallest window in which the loop still works. The numbers are
enforced by `src/context-spec.mjs`; this file is the measurement and the
reasoning behind them. Change one, change the other.

## Why a spec

Ollama's context window is a hard wall with silent failure modes on both
sides:

- If the prompt outgrows `num_ctx`, Ollama drops the *front* — the system
  prompt and tool schemas — without an error. The model loses its instructions
  and tool surface and keeps going.
- If the prompt fits but the model's output does not, the turn ends with
  `done_reason: "length"`. For a thinking model that means the reasoning ran
  the window dry before a tool call was emitted: an empty turn.

The second mode is what the 2026-09-21 Terminal-Bench runs hit at
`num_ctx 16384`: `feal-differential-cryptanalysis` spent 3,115 prompt +
13,269 completion tokens (exactly 16,384) in one turn and never acted, and the
compaction summarizer on `dna-insert` did the same thing, so the transcript was
never compacted.

## Accounting model

One model call:

```
prompt  = fixed + transcript
fixed   = chat template + core prompt & environment + tool schemas
          + rules/instructions + task message
transcript (right after a compaction) = recap + keepRecent messages
output  = thinking + tool call (or answer)            ≤ num_ctx − prompt
```

Compaction fires when the estimated transcript passes 75% of `num_ctx`
(`DEFAULT_CONTEXT_FRACTION`). The remaining 25% is the output reserve for the
call that follows. That reserve is where thinking models overrun, so it is
the binding constraint.

## Measurements

Real tokenizer counts via Ollama `prompt_eval_count`, on a Harbor-like
workspace (three files, no rules), 12 builtin tools, no MCP.

| Item | gpt-oss:20b | qwen3:14b | Spec constant |
| --- | ---: | ---: | ---: |
| Chat template scaffolding | 68 | 17 | 100 |
| Core prompt + model overlay + workspace listing + git status | 681 | 635 | 800 |
| 12 builtin tool schemas (7.2k chars) | 1,285 | 1,581 | 1,700 |
| **Fixed total** (with a one-line task) | **2,034** | **2,233** | — |
| Max spilled tool result (12k head + 8k tail, code) | 6,612 | 6,943 | 6,767 |
| Code / log density (chars per token) | 3.05 | 2.93 | 3 |
| Prose density (chars per token) | 5.41 | 5.23 | 5 (text blend 4) |
| Rules cap `MAX_INSTRUCTION_CHARS` = 12k chars at code density | — | — | 4,000 |

Observed across the recorded Terminal-Bench sessions (49 steps with token
telemetry):

| Signal | p50 | p90 | max |
| --- | ---: | ---: | ---: |
| First prompt (fixed + task + listing) | 2,195 | 2,421 | 2,421 |
| Completion tokens on a tool-call step (thinking included) | 112 | 3,210 | — |
| Completion tokens on a step that produced nothing | — | — | 13,269 |
| Tool message size (chars) | 136 | 7,238 | 7,267 |

Two template facts that matter for budgeting, both verified on gpt-oss and
qwen3:

- **Thinking from earlier turns is not re-sent.** Only the most recent
  assistant message's `thinking` is rendered into the next prompt (the pending
  tool exchange). So a heavy reasoning step costs its size twice — once as
  output, once as prompt on the next call — and then disappears.
- **Tool schemas are re-rendered on every call** and their size depends on
  the template: qwen-family templates spend ~20% more tokens on the same JSON.

## Spec constants (`src/context-spec.mjs`)

```
FIXED_COST       chatTemplate 100 · systemPrompt 800 · toolSchemas 1,700
                 perMcpTool 150 · rulesCap 4,000 · task 1,000
EXCHANGE_COST    toolResultMax 6,767 · toolResultTypical 2,500 · assistantCall 400
COMPACTION_COST  summary 1,500 (SUMMARY_MAX_TOKENS) · recapFraming 1,200 · keepRecent 6
OUTPUT_RESERVE   toolCall 4,000 · thinking 12,000
```

`toolResultTypical` is the p90 tool message (7.2k chars) at code density.
`OUTPUT_RESERVE.thinking` is sized to the largest observed reasoning turn
(13k) less the small tool call that should have followed; a model that needs
more than this on one step is the wrong model for the window, not a budget
problem.

## Derivation

The steady-state worst case is the prompt right after a compaction, with the
output reserve on top. Two constraints must hold:

1. **Reserve fits:** `fixed + recap + ⌈keepRecent/2⌉ exchanges + reserve ≤ num_ctx`
2. **Trigger is above the steady prompt** (otherwise compaction fires on every
   step, paying a summarizer call each time):
   `fixed + recap + ⌈keepRecent/2⌉ exchanges ≤ 0.75 · num_ctx`

`deriveMinimumContext()` evaluates both and rounds up to 1,024:

| Configuration | fixed | transcript after compaction | reserve | minimum `num_ctx` |
| --- | ---: | ---: | ---: | ---: |
| Non-thinking model, typical tool output | 3,600 | 11,400 | 4,000 | **20,480** |
| Thinking model, typical tool output | 3,600 | 11,400 | 12,000 | **27,648** |
| Thinking model, tool output routinely spilling | 3,600 | 24,201 | 12,000 | **39,936** |
| Thinking model + 12k of rules + 10 MCP tools | 9,100 | 11,400 | 12,000 | **32,768** |

## The spec

| Level | Value | Meaning |
| --- | ---: | --- |
| `MIN_NUM_CTX` (= `DEFAULT_NUM_CTX`) | 16,384 | Hard floor and the `auto` starting point. Below this a single max tool result plus the fixed cost crosses the trigger and `keepRecent` prevents compaction from reclaiming it — the loop thrashes. At exactly the floor the agent works on typical tool output with a non-thinking model (or thinking forced low); spilled results cause repeated compaction and thinking models truncate. |
| `RECOMMENDED_NUM_CTX` | 24,576 | Non-thinking model, typical work. |
| `RECOMMENDED_NUM_CTX_THINKING` | 32,768 | Thinking model at its default level. |
| `MAX_AUTO_NUM_CTX` | 65,536 | Ceiling for `auto`. Past this, local models lose long-context accuracy faster than the room helps and per-step prompt evaluation slows; compaction covers the rest. |

`checkContextWindow(numCtx, { thinking })` returns a warning when a window is
under the derived minimum for its configuration; the CLI prints it as
`[context] …` at startup for both explicit and auto windows.

## How `auto` sizes the window

`configureClientModel` (via `sizeContextWindow` → `resolveAutoNumCtx`):

1. Read `/api/show` `model_info` for the trained `context_length` and the KV
   geometry (`block_count`, `head_count_kv`, `key_length`, `value_length`).
   KV bytes/token = `blocks × kv_heads × (key + value) × 2` (f16). gpt-oss:20b
   ≈ 48 KB/token, qwen3:14b ≈ 160 KB/token.
2. Memory available for the cache = `(fit budget − model file size) × 0.6`,
   where the fit budget is the same one model routing uses (80% of VRAM when
   a usable GPU exists, else 50% of RAM). The other 40% covers compute
   buffers, the embedding model, and Ollama overhead.
3. `num_ctx` = the largest multiple of 4,096 whose cache fits, clamped to
   `[MIN_NUM_CTX, min(MAX_AUTO_NUM_CTX, context_length)]`. Cloud models keep no
   local cache and get the ceiling.

When the agent runs in a container but Ollama runs on the host (the Harbor
adapter), the container's own memory is irrelevant; the bench runner forwards
the host's figures as `HALO_TOTAL_MEM_BYTES` / `HALO_VRAM_BYTES`, which both
model routing and window sizing honor.

On the reference machine (64 GB RAM, 24 GB GPU): gpt-oss:20b → 65,536;
qwen3:14b → 40,960 (its own limit); llama3.1:70b → 16,384 with a warning
(no room after 40 GB of weights).

## Related mechanisms that lean on this spec

- **Transcript estimator** (`estimateTokens`) counts tool messages at 3
  chars/token and everything else at 4. A flat chars/4 undercounted a spilled
  build log by a quarter — 1.7k tokens of the output reserve gone before
  compaction noticed.
- **Compaction summarizer** runs with the model's minimal thinking setting and
  `num_predict: 1500`, so it cannot itself run the window dry.
- **Per-call output cap**: every agent call carries
  `num_predict = OUTPUT_RESERVE.thinking` (12k, `DEFAULT_MAX_OUTPUT_TOKENS`;
  `maxOutputTokens: 0` disables it). A turn that needs more output than the
  reserve has already broken the accounting above, so it is cut off there and
  re-asked instead of being allowed to run the window dry. Observed without
  it at `num_ctx 65536`: gpt-oss:20b spent 56k tokens and six minutes reciting
  a 3.6 kb DNA sequence in its reasoning channel, then apologized.
- **Truncated-turn retry**: when a call ends on `done_reason: "length"` with
  no text or tool call, the loop drops that turn's partial thinking (it never
  reached an action; keeping it inflates the estimate and feeds the
  summarizer the same runaway text) and re-asks once with thinking at its
  minimum rather than repeating the same overrun.
- **Efficiency flags**: `truncated-turns` and `compaction-failed` mark runs
  where the window was exhausted rather than managed; `tokens.window` in the
  metrics records what the run actually had.

## Re-measuring

The measurement script is not in the repo (it needs a live Ollama). To redo
it: build the system prompt with `buildSystemPrompt` + `DEFAULT_SYSTEM_PROMPT`
+ `modelPromptOverlay`, take `registry.schemas()` from `registerBuiltinTools`,
and post `{ messages, tools, options: { num_predict: 1 } }` to `/api/chat`
for each model, reading `prompt_eval_count`. Difference the calls (no system /
system / system + tools / + one spilled tool message) to isolate each row.
