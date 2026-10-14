# Bitfield Ollama Agent — limitations

Honest expectations for v0.1. Use this when evaluating Bitfield Ollama Agent as a built-in
local agent (via Aura Wire) or running it standalone.

## What it is

- A **local-first agent runtime** (Ollama by default): tool calls → observe → repeat until the model stops, in a thin Cursor-style harness.
- Optional **peer SDK providers** (`openai`, `anthropic`) and **nested Copilot supervision** (`--provider copilot`) when those packages are installed.
- **CLI, SDK, and `serve`** (OpenAI-compatible `/v1` facade; serve remains Ollama-backed).
- **Free on Ollama** — you pay only for your hardware and whichever Ollama model you run; other providers bill through their own accounts.

## What it is not

- **Not a full IDE agent** — no editor extensions. IDE integration is Aura Wire's job.
- **Not frontier-class** on hard multi-file tasks — quality depends heavily on your local model.
- **Not a sandbox** — tools are workspace-scoped, but the agent can still write and run commands in that workspace when unattended (`serve` mode, `--mode agent`).
- **Not RAG/memory** — private corpora stay with Terran (via Aura Wire / MCP); sessions + compaction handle conversation state. Public web lookup is built in as `web_search`.
- **Not a general supervisor** — the loop does not plan for the model, grade its work, or swap models mid-run. Nested Copilot mode adds a best-effort completion guard (challenge false “done” / missing verify), not a sandbox or proof of correctness. A weak model that stops early still stops early; put stronger policy in rules files or SDK hooks (`stop`, `beforeToolCall`).
- **Not small-context** — the agent needs at least a 16k window and works best at 32k+ for thinking models (`docs/context-spec.md`). Below the floor Ollama silently drops the system prompt and tool schemas; at the floor a thinking model can spend the whole window reasoning and emit nothing. `--num-ctx auto` sizes the window to your memory, and a window under the spec is reported at startup, but a machine with no room after the model's weights gets the floor and a warning, not a fix.

## Model quality

Benchmark reference models: **`qwen3-coder:30b`** (local line) and **`kimi-k2.7-code:cloud`** (cloud line) — the pins in `src/model-routing.mjs`, chosen by a 2026-09 bake-off (local: coder over `gpt-oss:20b` and `devstral-small-2`; cloud: kimi 2/4 resolved over `glm-5.3:cloud` 1/4) and fixed so the harness can be tuned against one model's behavior. Scores vary by model, hardware, and Ollama version; a run on another model is not comparable to the scoreboard history.

- **Tuned to the pin** — recovery paths in the loop target quirks seen on the pinned models (qwen3-coder writing tool calls as `<function=…>` text; gpt-oss's stray `]` in long arguments). Another model's failure modes will not have the same coverage until it is benchmarked.
- **Local pin is a non-thinker** — `qwen3-coder:30b` has no thinking channel, so `--think` levels are ignored for it and reasoning happens in visible text. Its 30B MoE weights leave a 24 GB GPU room for a ~16k KV cache; the bench pins 24k and accepts partial CPU offload.

| Tier | Task type | Expectation |
| --- | --- | --- |
| 0 | Safety / integrity | Must not corrupt unrelated files |
| 1 | Everyday (read, small edit) | Target for built-in agent |
| 2 | Routine dev (tests, flags, renames) | Local-first; pick a cloud model (`--tier-preset cloud`) when local models are too weak |
| 3+ | Small builds, refactors, APIs | Often needs a stronger model or cloud |

Run `npm run bench` to measure your setup. Gates define minimum acceptable scores — see `evals/PLAN.md`.

## Safety

- **Ask mode** (default in a terminal): `write_file`, `edit_file`, and `run_command` prompt for y/N.
- **Agent / serve mode**: unattended — put Wire guardrails in front for policy.
- **Deletion gate**: in unattended runs, shell deletion commands (`rm`, `del`, `Remove-Item`, `git clean`, `find -delete`, …) only run when the user's request explicitly names every deletion target. Unnamed targets, protected files ("do not delete X"), wildcards without a named fixed part, and indirect deletes are refused, and the agent is instructed to ask the user. The same rule applies to `write_file` / `edit_file` on cleanup-style goals so the model cannot empty or rewrite files as a delete workaround. Detection is best-effort — an inline script that deletes files would not be caught — so this complements (not replaces) upstream guardrails.
- **Path confinement**: file and shell tools cannot escape the workspace root.
- **Edit safety**: failed or ambiguous `edit_file` calls do not modify the file (see `test/fs-edit-safety.test.mjs`).
- **Checkpoints**: every file is snapshotted before its first `write_file` / `edit_file` in a run; `bf-agent checkpoints restore <run-id>` undoes the run's file changes. Shell commands that modify files are not checkpointed.
- **Integrity bench (tier 0)**: verifies the agent does not corrupt unrelated files on read-only and narrow-edit tasks.

## Wire pairing

Bitfield Ollama Agent is designed to pair with **Aura Wire**:

- Wire routes IDE traffic; Bitfield Ollama Agent is the **built-in local tier** for simple work.
- Wire reads `../halo-agent-benchmark/local/capability.json` (from a gated bench run) to set routing defaults.
- Complex tasks should be routed to cloud providers by Wire; the runtime itself does not escalate mid-run.
- Optional CLI `--provider` peers are a separate local SDK path — they do not replace Wire's `/v1` routing, compression, or guardrails.

## Reporting issues

If tier 0 safety scenarios fail on your model, do not use Bitfield Ollama Agent for unattended writes in production workflows until scores improve or you add approval gates upstream.
