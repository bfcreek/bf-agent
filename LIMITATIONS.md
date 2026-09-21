# Bitfield Agent — limitations

Honest expectations for v0.1. Use this when evaluating Bitfield Agent as a built-in
local agent (via Aura Wire) or running it standalone.

## What it is

- A **local agent runtime** for Ollama: tool calls → observe → repeat until the model stops, in a thin Cursor-style harness.
- **CLI, SDK, and `serve`** (OpenAI-compatible `/v1` facade).
- **Free** — you pay only for your hardware and whichever Ollama model you run.

## What it is not

- **Not a full IDE agent** — no editor extensions. IDE integration is Aura Wire's job.
- **Not frontier-class** on hard multi-file tasks — quality depends heavily on your local model.
- **Not a sandbox** — tools are workspace-scoped, but the agent can still write and run commands in that workspace when unattended (`serve` mode, `--mode agent`).
- **Not RAG/memory** — private corpora stay with Terran (via Aura Wire / MCP); sessions + compaction handle conversation state. Public web lookup is built in as `web_search`.
- **Not a supervisor** — the loop does not plan for the model, grade its work, nudge it, or swap models mid-run. A weak model that stops early stops early; put that policy in rules files or SDK hooks (`stop`, `beforeToolCall`) rather than expecting the runtime to compensate.
- **Not small-context** — the agent needs at least a 16k window and works best at 32k+ for thinking models (`docs/context-spec.md`). Below the floor Ollama silently drops the system prompt and tool schemas; at the floor a thinking model can spend the whole window reasoning and emit nothing. `--num-ctx auto` sizes the window to your memory, and a window under the spec is reported at startup, but a machine with no room after the model's weights gets the floor and a warning, not a fix.

## Model quality

Benchmark reference models: **`qwen3-coder:30b`** (local line) and **`kimi-k2.7-code:cloud`** (cloud line) — the pins in `src/model-routing.mjs`, chosen by a 2026-09 bake-off and fixed so the harness can be tuned against one model's behavior. Scores vary by model, hardware, and Ollama version; a run on another model is not comparable to the scoreboard history.

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

Bitfield Agent is designed to pair with **Aura Wire**:

- Wire routes IDE traffic; Bitfield Agent is the **built-in local tier** for simple work.
- Wire reads `../halo-agent-benchmark/local/capability.json` (from a gated bench run) to set routing defaults.
- Complex tasks should be routed to cloud providers by Wire; the runtime itself does not escalate mid-run.

## Reporting issues

If tier 0 safety scenarios fail on your model, do not use Bitfield Agent for unattended writes in production workflows until scores improve or you add approval gates upstream.
