# /hv-bench-tb

Bare `/hv-bench-tb` means: run **2** random Terminal-Bench tasks (Harbor / Docker), grade with the Cursor CLI judge, then **process the recommendations** into halo-agent source changes.

This is a fast iteration loop — not the full TB suite (`.\bin\bench-tb.ps1`) or the 5-task mini (`.\bin\bench-tb-mini.ps1`).

## Step 1 — Run bench + build plan

From the **halo-agent** repo root (PowerShell):

```powershell
.\scripts\commands\hv-bench-tb.ps1
```

Optional:

```powershell
.\scripts\commands\hv-bench-tb.ps1 -Seed 42
.\scripts\commands\hv-bench-tb.ps1 -DryRun
.\scripts\commands\hv-bench-tb.ps1 -SkipJudge
.\scripts\commands\hv-bench-tb.ps1 -Compose
.\scripts\commands\hv-bench-tb.ps1 -SkipBench
```

| Flag | Meaning |
| --- | --- |
| `-Seed <n>` | Reproducible 2-task draw (omit for a random seed printed in the bench log) |
| `-DryRun` | Print Harbor command only |
| `-SkipJudge` | Harbor tests only |
| `-Compose` | Start Compose Ollama before the run |
| `-SkipBench` | Re-process recommendations from the latest TB report only |

Outputs:

- Harbor + judge report: `../halo-agent-benchmark/recognized/terminal-bench/latest.json`
- Implementation plan: `bench-recommendations-plan.json` and `bench-recommendations-plan.md`

Underlying: `bin/bench-tb-mini.ps1 -Count 2` → `evals/process-recommendations.mjs`.

## Step 2 — Process recommendations (implement)

Read `bench-recommendations-plan.md` (or the JSON). For each **pending** item:

1. Open the listed **target files** for that judge `area`.
2. Implement the **suggestion** with a minimal, focused diff.
3. Skip items that are vague, duplicate existing behavior, or conflict with `LIMITATIONS.md`.
4. Mark mentally as done when implemented (do not edit the plan file unless the user asks).

Area → file mapping (also in the plan):

| Area | Primary files |
| --- | --- |
| system prompt | `src/context-builder.mjs`, `src/agent-loop.mjs` |
| tools | `src/tools/builtin.mjs`, `src/tools/shell.mjs`, `src/tools/fs.mjs`, `src/tool-registry.mjs` |
| planning | `src/prompt-enhancements.mjs`, `src/agent-loop.mjs` |
| compaction | `src/compaction.mjs` |
| other | closest related module |

Prefer `src/prompt-enhancements.mjs` for task-type hints and verification nudges.

## Step 3 — Verify

```powershell
npm test
```

Add a focused test when the change is easy to lock in (especially tools and prompt-enhancements).

## Prerequisites

| Need | Notes |
| --- | --- |
| Node.js 20+ | `node` on PATH |
| Docker Desktop | Harbor sandboxes |
| Harbor | `uv tool install harbor` |
| Ollama | Reachable from containers (`host.docker.internal`) |
| Cursor CLI | `agent` on PATH for judging (unless `-SkipJudge`) |

On bench failure, still read the plan — partial runs write `latest.json`. On implementation failure, stop and report; do not commit unless asked.

## Related

- Pattern train loop: `/ha-train`
- Full TB suite: `.\bin\bench-tb.ps1`
- 5-task random sample: `.\bin\bench-tb-mini.ps1`
- Local dev bench (no Harbor): `.\bin\bench-local.ps1`
