# halo-agent — limitations

Honest expectations for v0.1. Use this when evaluating halo-agent as a built-in
local agent (via Aura Wire) or running it standalone.

## What it is

- A **local agent runtime** for Ollama: plan → tool calls → observe → repeat.
- **CLI, SDK, and `serve`** (OpenAI-compatible `/v1` facade).
- **Free** — you pay only for your hardware and whichever Ollama model you run.

## What it is not

- **Not a full IDE agent** — no editor extensions. IDE integration is Aura Wire's job.
- **Not frontier-class** on hard multi-file tasks — quality depends heavily on your local model.
- **Not a sandbox** — tools are workspace-scoped, but the agent can still write and run commands in that workspace when unattended (`serve` mode, `--mode agent`).
- **Not RAG/memory** — private corpora stay with Terran (via Aura Wire / MCP); sessions + compaction handle conversation state. Public web lookup is built in as `web_search`.

## Model quality

Benchmark reference model: **`gpt-oss:20b`**. Scores vary by model, hardware, and Ollama version.

| Tier | Task type | Expectation |
| --- | --- | --- |
| 0 | Safety / integrity | Must not corrupt unrelated files |
| 1 | Everyday (read, small edit) | Target for built-in agent |
| 2 | Routine dev (tests, flags, renames) | Local-first with cloud escalation |
| 3+ | Small builds, refactors, APIs | Often needs a stronger model or cloud |

Run `npm run bench` to measure your setup. Gates define minimum acceptable scores — see `evals/PLAN.md`.

## Safety

- **Ask mode** (default in a terminal): `write_file`, `edit_file`, and `run_command` prompt for y/N.
- **Agent / serve mode**: unattended — put Wire guardrails in front for policy.
- **Deletion gate**: in unattended runs, shell deletion commands (`rm`, `del`, `Remove-Item`, `git clean`, `find -delete`, …) only run when the user's request explicitly names every deletion target. Unnamed targets, protected files ("do not delete X"), wildcards without a named fixed part, and indirect deletes are refused, and the agent is instructed to ask the user. The same rule applies to `write_file` / `edit_file` on cleanup-style goals so the model cannot empty or rewrite files as a delete workaround. Detection is best-effort — an inline script that deletes files would not be caught — so this complements (not replaces) upstream guardrails.
- **Path confinement**: file and shell tools cannot escape the workspace root.
- **Edit safety**: failed or ambiguous `edit_file` calls do not modify the file (see `test/fs-edit-safety.test.mjs`).
- **Integrity bench (tier 0)**: verifies the agent does not corrupt unrelated files on read-only and narrow-edit tasks.

## Wire pairing

halo-agent is designed to pair with **Aura Wire**:

- Wire routes IDE traffic; halo-agent is the **built-in local tier** for simple work.
- Wire reads `bench-capability.json` (from a gated bench run) to set routing defaults.
- Complex tasks should escalate to cloud providers automatically.

## Reporting issues

If tier 0 safety scenarios fail on your model, do not use halo-agent for unattended writes in production workflows until scores improve or you add approval gates upstream.
