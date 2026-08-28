# /ha-train

Unattended training loop: run a **random Terminal-Bench sample**, look for **architecture patterns** (approach-level levers, not task-specific cases), **assimilate** those levers into halo-agent after each run, then repeat.

This is not `/hv-bench-tb` (2-task judge punch list) and not the old 1-task `/ah-train` loop.

## Loop (repeat 100 times unless a smaller iteration count is given)

For iteration **N** of **TOTAL** (default TOTAL = 100):

### 1 — Bench + pattern plan

From the **halo-agent** repo root (PowerShell):

```powershell
.\scripts\commands\ha-train.ps1
```

Default sample is **5** random TB 2.1 tasks (`-Count 5`). Override:

```powershell
.\scripts\commands\ha-train.ps1 -Count 3
.\scripts\commands\ha-train.ps1 -Iterations 100
.\scripts\commands\ha-train.ps1 -Iterations 89 -StartFrom 12
```

Each call picks a **new random seed** and prints it (`seed N`). To replay one draw: `.\scripts\commands\ha-train.ps1 -Seed N`.

Optional:

```powershell
.\scripts\commands\ha-train.ps1 -DryRun
.\scripts\commands\ha-train.ps1 -SkipJudge
.\scripts\commands\ha-train.ps1 -Compose
.\scripts\commands\ha-train.ps1 -SkipBench
```

| Flag | Meaning |
| --- | --- |
| `-Count <n>` | Random TB tasks per iteration (default **5**, minimum **2**) |
| `-Iterations <n>` | Run **n** bench+plan cycles in one script (default **1**) |
| `-StartFrom <n>` | First iteration index when `-Iterations` > 1 (default **1**) |
| `-Seed <n>` | Reproducible sample draw (single-iteration mode only) |
| `-DryRun` | Print Harbor command only |
| `-SkipJudge` | Harbor tests only (patterns still use Harbor pass/fail + session telemetry) |
| `-Compose` | Start Compose Ollama before the run |
| `-SkipBench` | Re-process patterns from the latest TB report only |

Outputs:

- Harbor + judge report: `../halo-agent-benchmark/recognized/terminal-bench/latest.json`
- Pattern plan: `bench-recommendations-plan.json` and `bench-recommendations-plan.md`

Underlying: `bin/bench-tb-mini.ps1 -Count <n> -Seed <random>` → `evals/process-recommendations.mjs --patterns`.

### 2 — Assimilate pattern levers

Read `bench-recommendations-plan.md` (or the JSON). For each **pending** item:

1. Treat **Pattern** as evidence and **Lever** as the change to consider.
2. Open the listed **target files**.
3. Implement a **minimal, approach-level** diff (acceptance gating, escalation policy, memory curation, critique timing — not a hint for this sample's task names).
4. Skip items with status `skip`, levers that duplicate existing behavior, or anything that conflicts with `LIMITATIONS.md`.
5. Ignore the **Judge notes** section as a punch list. If a note only fits one TB task, discard it.
6. If there are **zero** pending levers, skip to the next iteration — do not stall, and do not invent task-specific prompt rules.

Area → file mapping (also in the plan):

| Area | Primary files |
| --- | --- |
| acceptance | `src/acceptance.mjs`, `src/agent-loop.mjs` |
| escalation | `src/escalation.mjs`, `src/agent-loop.mjs`, `src/model-routing.mjs` |
| memory | `src/memory-store.mjs` |
| planning | `src/prompt-enhancements.mjs`, `src/agent-loop.mjs` |
| system prompt | `src/context-builder.mjs`, `src/agent-loop.mjs` |
| tools | `src/tools/builtin.mjs`, `src/tools/shell.mjs`, `src/tools/fs.mjs`, `src/tool-registry.mjs` |
| compaction | `src/compaction.mjs` |
| other | closest related module |

Do **not** add `TASK_HINT_RULES` entries keyed to a Terminal-Bench task from this sample.

### 3 — Verify

```powershell
npm test
```

Add a focused test when the change is easy to lock in (especially acceptance, escalation, and memory).

### 4 — Continue

Append a one-line summary to `ha-train-log.md` (create if missing):

```text
iteration N/TOTAL | seed S | count C | levers L | assimilated: brief note | tests: pass|fail
```

Then start iteration **N+1**. Do **not** stop early unless a step is unrecoverable (see below).

**On any failure, go to the next iteration — do not stop the loop.** That includes:

- Harbor reward 0 / task not resolved
- Harbor or trial **errors** (not just a low score)
- Judge failure (invalid JSON, timeout, `judgeError`, no grade)
- **Zero** pending pattern levers
- `npm test` failure after assimilate (log and continue)
- `ha-train.ps1` / bench non-zero exit (script still exits **0** so the loop continues)

Only **hard-stop** when prerequisites are missing and the bench cannot run at all (Docker, Harbor, Ollama, `agent` CLI when judging is required).

## Parameters

| User says | Meaning |
| --- | --- |
| `/ha-train` | 100 iterations, 5 random TB tasks each |
| `/ha-train 50` | 50 iterations, 5 tasks each |
| `/ha-train count 10` | 100 iterations of 10-task samples |
| `/ha-train 20 count 3` | 20 iterations of 3-task samples |
| `/ha-train from 12` | Resume from iteration 12 through 100 |

When the user names a count, pass it through:

```powershell
.\scripts\commands\ha-train.ps1 -Count 10
```

## Unattended rules

- **Do not ask for confirmation** between iterations — keep going until TOTAL is reached or a hard stop applies.
- **Do not commit** unless the user explicitly asks.
- **Any iteration failure → next iteration.** Never stop the loop for a failed task, judge, empty plan, or test failure (see list above).
- On bench non-zero exit: still build/assimilate from the partial pattern plan when possible, then continue.
- On `npm test` failure: fix if obvious and quick; otherwise log the failure, skip remaining assimilations for that iteration, and **continue** the loop.
- On missing Docker/Harbor/Ollama/agent CLI: **stop** and report — do not spin through empty iterations.
- `ha-train.ps1` always exits **0** after a run (except `-DryRun` and missing launcher files) so agents and `-Iterations` loops keep going.
- Prefer small, incremental closed-loop improvements over large refactors and over task-specific prompt rules.

## Prerequisites

| Need | Notes |
| --- | --- |
| Node.js 20+ | `node` on PATH |
| Docker Desktop | Harbor sandboxes |
| Harbor | `uv tool install harbor` |
| Ollama | Reachable from containers (`host.docker.internal`) |
| Cursor CLI | `agent` on PATH for judging (unless `-SkipJudge`) |

## Related

- Fast 2-task judge punch list: `/hv-bench-tb`
- 5-task random sample (no assimilate loop): `.\bin\bench-tb-mini.ps1`
- Full TB suite: `.\bin\bench-tb.ps1`
- Local pattern analysis: `npm run bench:patterns`
