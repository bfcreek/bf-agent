# /ah-train

Unattended training loop: run **100** single-task Terminal-Bench samples, **assimilate** judge recommendations into halo-agent after each run, then repeat.

This is the tightest feedback loop — one random task per iteration (`-Count 1`), not `/hv-bench-tb` (2 tasks) or `bench-tb-mini` (5 tasks).

## Loop (repeat 100 times unless `-Iterations` is given)

For iteration **N** of **TOTAL** (default TOTAL = 100):

### 1 — Bench + build plan

From the **halo-agent** repo root (PowerShell):

```powershell
.\scripts\commands\ah-train.ps1
```

For an unattended **bench+plan-only** loop (no assimilate/test between iterations):

```powershell
.\scripts\commands\ah-train.ps1 -Iterations 100
.\scripts\commands\ah-train.ps1 -Iterations 89 -StartFrom 12
```

Each call picks a **new random seed** and prints it (`seed N`). To replay one draw: `.\scripts\commands\ah-train.ps1 -Seed N`.

Optional:

```powershell
.\scripts\commands\ah-train.ps1 -DryRun
.\scripts\commands\ah-train.ps1 -SkipJudge
.\scripts\commands\ah-train.ps1 -Compose
.\scripts\commands\ah-train.ps1 -SkipBench
```

| Flag | Meaning |
| --- | --- |
| `-Iterations <n>` | Run **n** bench+plan cycles in one script (default **1**) |
| `-StartFrom <n>` | First iteration index when `-Iterations` > 1 (default **1**) |
| `-Seed <n>` | Reproducible 1-task draw (single-iteration mode only) |
| `-DryRun` | Print Harbor command only |
| `-SkipJudge` | Harbor tests only |
| `-Compose` | Start Compose Ollama before the run |
| `-SkipBench` | Re-process recommendations from the latest TB report only |

Outputs:

- Harbor + judge report: `../halo-agent-benchmark/recognized/terminal-bench/latest.json`
- Implementation plan: `bench-recommendations-plan.json` and `bench-recommendations-plan.md`

Underlying: `bin/bench-tb-mini.ps1 -Count 1 -Seed <random>` → `evals/process-recommendations.mjs`.

### 2 — Assimilate recommendations

Read `bench-recommendations-plan.md` (or the JSON). For each **pending** item:

1. Open the listed **target files** for that judge `area`.
2. Implement the **suggestion** with a minimal, focused diff.
3. Skip items that are vague, duplicate existing behavior, or conflict with `LIMITATIONS.md`.
4. If there are **zero** recommendations, skip to the next iteration — do not stall.

Area → file mapping (also in the plan):

| Area | Primary files |
| --- | --- |
| system prompt | `src/context-builder.mjs`, `src/agent-loop.mjs` |
| tools | `src/tools/builtin.mjs`, `src/tools/shell.mjs`, `src/tools/fs.mjs`, `src/tool-registry.mjs` |
| planning | `src/prompt-enhancements.mjs`, `src/agent-loop.mjs` |
| compaction | `src/compaction.mjs` |
| other | closest related module |

Prefer `src/prompt-enhancements.mjs` for task-type hints and verification nudges.

### 3 — Verify

```powershell
npm test
```

Add a focused test when the change is easy to lock in (especially tools and prompt-enhancements).

### 4 — Continue

Append a one-line summary to `ah-train-log.md` (create if missing):

```text
iteration N/TOTAL | seed S | recs R | assimilated: brief note | tests: pass|fail
```

Then start iteration **N+1**. Do **not** stop early unless a step is unrecoverable (see below).

**On any failure, go to the next iteration — do not stop the loop.** That includes:

- Harbor reward 0 / task not resolved
- Harbor or trial **errors** (not just a low score)
- Judge failure (invalid JSON, timeout, `judgeError`, no grade)
- **Zero** recommendations
- `npm test` failure after assimilate (log and continue)
- `ah-train.ps1` / bench non-zero exit (script still exits **0** so the loop continues)

Only **hard-stop** when prerequisites are missing and the bench cannot run at all (Docker, Harbor, Ollama, `agent` CLI when judging is required).

## Parameters

| User says | Meaning |
| --- | --- |
| `/ah-train` | 100 iterations, random seed each bench |
| `/ah-train 50` | 50 iterations |
| `/ah-train from 12` | Resume from iteration 12 through 100 |

## Unattended rules

- **Do not ask for confirmation** between iterations — keep going until TOTAL is reached or a hard stop applies.
- **Do not commit** unless the user explicitly asks.
- **Any iteration failure → next iteration.** Never stop the loop for a failed task, judge, empty plan, or test failure (see list above).
- On bench non-zero exit: still build/assimilate from the partial plan when possible, then continue.
- On `npm test` failure: fix if obvious and quick; otherwise log the failure, skip remaining assimilations for that iteration, and **continue** the loop.
- On missing Docker/Harbor/Ollama/agent CLI: **stop** and report — do not spin through empty iterations.
- `ah-train.ps1` always exits **0** after a run (except `-DryRun` and missing launcher files) so agents and `-Iterations` loops keep going.
- Prefer small, incremental improvements over large refactors.

## Prerequisites

| Need | Notes |
| --- | --- |
| Node.js 20+ | `node` on PATH |
| Docker Desktop | Harbor sandboxes |
| Harbor | `uv tool install harbor` |
| Ollama | Reachable from containers (`host.docker.internal`) |
| Cursor CLI | `agent` on PATH for judging (unless `-SkipJudge`) |

## Related

- Fast 2-task loop: `/hv-bench-tb`
- 5-task random sample: `.\bin\bench-tb-mini.ps1`
- Full TB suite: `.\bin\bench-tb.ps1`
