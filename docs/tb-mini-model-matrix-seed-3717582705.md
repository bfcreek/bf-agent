# Terminal-Bench mini — model matrix

**Dataset:** Terminal-Bench 2.1  
**Sample:** 5 of 89 tasks · **seed** `3717582705`  
**Tasks:** `financial-document-processor`, `qemu-startup`, `extract-elf`, `torch-tensor-parallelism`, `sam-cell-seg`  
**Agent:** halo-agent 1.1.26 · `max_steps=80` · `num_ctx=65536`  
**Harness:** Harbor (mechanical reward) + Cursor judge (outcome / process)  
**Concurrency:** current Ollama-cloud + OpenAI runs use `n_concurrent=5`; older Ollama rows below were serial (`n_concurrent=1`)

## Scorecard (current)

After the deliverable-guard fix (inputs no longer forced as `write_file` targets). Ollama cloud re-runs used `--n-concurrent 5`.

| Model | Harbor | Outcome | Process | Runtime‡ | Prompt tokens (Σ) | Est. run cost |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `kimi-k2.7-code:cloud` (cloud-max, think:max) | **4/5** | 83.0 | **72.0** | ~45m / 1h 10m | 3.54M | **~$2.20 – $6.20** |
| `glm-5.3-flash:cloud` | **4/5** | 83.2 | **69.6** | ~24m / 46m | 2.52M | **~$0.22 – $0.63** |
| `minimax-m3:cloud` | **3/5** | 72.6 | 51.2 | ~45m / 1h 34m | 6.44M | **~$2.50 – $6.95** |
| `gpt-5.2` (OpenAI) | 1/5 | 50.6 | 58.8 | ~25m | 0.70M | **~$0.95 – $3.20** |
| `gpt-5.4-mini` (OpenAI) | 1/5 | 43.6 | 54.0 | ~11m | 0.29M | **~$0.15 – $0.50** |
| `gpt-5.1` (OpenAI) | 1/5 | 36.4 | 50.2 | ~26m | 0.14M | **~$0.15 – $0.45** |
| `gpt-5.4` (OpenAI) | 0/5 | 36.0 | 53.2 | ~15m | 0.46M | **~$0.75 – $2.50** |
| `gpt-oss:120b-cloud` | 0/5 | 27.6 | 45.8 | 25m§ | 1.01M | **~$0.10 – $0.30** |
| `glm-4.7-flash` (local 4090) | 0/5 | 25.6 | 40.2 | ~51m§ | 3.56M | **$0** |
| `gpt-5.4-nano` (OpenAI) | 0/5 | 24.8 | 45.2 | ~12m | 0.31M | **~$0.05 – $0.15** |
| `qwen3-coder:30b` (local 4090) | 0/5 | 30.0 | 51.6 | 55m§ | 2.07M | **$0** |

‡ Harbor job wall-clock / report elapsed (judge included) when both logged.  
§ Serial `n_concurrent=1` (local GPU / pre-parallel baseline).

## Deliverable-guard re-run (before → after)

Same seed; after = 2026-10-30 runs with conservative `extractDeliverablePaths`.

| Model | Harbor | Outcome | Process | Prompt (Σ) |
| --- | :---: | :---: | :---: | :---: |
| Kimi cloud-max | 4/5 → **4/5** | 81.8 → **83.0** | 59.2 → **72.0** (+12.8) | 2.99M → 3.54M |
| GLM-5.3 Flash | 3/5 → **4/5** | 64.4 → **83.2** | 49.6 → **69.6** (+20.0) | 3.42M → **2.52M** |
| MiniMax M3 | 4/5 → **3/5** | 91.3 → 72.6 | 40.0 → **51.2** (+11.2) | 7.21M → **6.44M** |

Per-task process (tasks the false-positive guard was poisoning):

| Task | Kimi process | GLM process | Notes |
| --- | :---: | :---: | --- |
| extract-elf | 68 → **76** | 64 → **76** | no more `/app/a.out` write theater |
| qemu-startup | 58 → **74** | 28 → **62** | no more `/app/alpine.iso` write theater |
| torch-tensor-parallelism | 48 → **76** | 12 → **48** | GLM previously empty-failed; now PASS |
| sam-cell-seg | 64 → 62 | 72 → **82** | MiniMax lost Harbor on this re-run |
| financial-document-processor | 58 → **72** | 72 → **80** | summary.csv was already a real deliverable |

## Per-task Harbor results (current)

| Task | Kimi | MiniMax | GLM Flash cloud | gpt-5.2 | gpt-5.4-mini | gpt-5.1 | gpt-5.4 | GPT-OSS 120B | glm-4.7-flash local | gpt-5.4-nano | Qwen 30B |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| extract-elf | PASS | PASS | PASS | fail | fail | PASS | fail | fail | fail | fail | fail |
| financial-document-processor | PASS | PASS | PASS | fail | fail | fail | fail | fail | fail | ERR | fail |
| qemu-startup | fail | fail | fail | fail | fail | fail | fail | fail | fail | fail | fail |
| sam-cell-seg | PASS | fail | PASS | PASS | PASS | fail | fail | fail | fail | fail | fail |
| torch-tensor-parallelism | PASS | PASS | PASS | fail | fail | fail | fail | ERR | fail | fail | fail |

Every model failed `qemu-startup` on this seed.

## Parallelism (cloud)

Yes — with cloud LLM backends, Harbor can run the five tasks concurrently via `--n-concurrent 5`.

- **Ollama local / single-GPU:** keep `n_concurrent=1` (VRAM / one model load).
- **Ollama cloud / OpenAI / Anthropic:** raise concurrency; wall-clock approaches the slowest task instead of the sum. OpenAI minis here finished in ~11–26 minutes vs ~50–100 minutes for serial Ollama cloud runs.
- Limits: Docker CPU/RAM for concurrent sandboxes, provider rate limits, and API spend (parallel does not reduce tokens — it only overlaps waiting).

```powershell
# Example: OpenAI mini with parallel tasks
node evals/recognized/run.mjs terminal-bench --dataset 2.1 `
  --provider openai --model gpt-5.4-mini `
  --sample 5 --seed 3717582705 --n-concurrent 5
```

## Cost estimate method

Prompt totals are the sum of per-step `prompt_eval_count` from each task session (already cumulative across the agent loop). Completion / thinking tokens were **not** logged in these reports, so they are estimated.

### Ollama Cloud list prices ($/1M)

| Model | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| kimi-k2.7-code | $0.95 | $0.19 | $4.00 |
| minimax-m3 | $0.60 | $0.12 | $2.40 |
| glm-5.3-flash | $0.15 | $0.03 | $0.50 |
| gpt-oss:120b | $0.15 | $0.014 | $0.60 |
| qwen3-coder:30b | — | — | local / free |

### OpenAI API list prices ($/1M)

| Model | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| gpt-5.4 | $2.50 | $0.25 | $15.00 |
| gpt-5.2 | $1.75 | $0.175 | $14.00 |
| gpt-5.4-mini | $0.75 | $0.075 | $4.50 |
| gpt-5.1 | $1.25 | $0.125 | $10.00 |
| gpt-5.4-nano | $0.20 | $0.02 | $1.25 |

**Range assumptions:**

| Bound | Prompt billing | Completion estimate |
| --- | --- | --- |
| **Low** | 30% at full input + 70% at cached input | 5% of prompt tokens × output rate |
| **High** | 100% at full input (no cache credit) | 20% of prompt tokens × output rate |

```
low  = prompt/1e6 × (0.30×input + 0.70×cached) + prompt/1e6 × 0.05 × output
high = prompt/1e6 × input                     + prompt/1e6 × 0.20 × output
```

| Model | Prompt (M) | Low | High | Notes |
| --- | ---: | ---: | ---: | --- |
| kimi-k2.7-code | 3.54 | ~$2.20 | ~$6.20 | post-guard; cloud-max / max think |
| glm-5.3-flash | 2.52 | ~$0.22 | ~$0.63 | post-guard; best $/Harbor at 4/5 |
| minimax-m3 | 6.44 | ~$2.50 | ~$6.95 | post-guard; still highest volume |
| gpt-5.2 | 0.70 | ~$0.95 | ~$3.20 | 1/5 (sam); more tokens than minis |
| gpt-5.4-mini | 0.29 | ~$0.15 | ~$0.50 | cheap miss (1/5); few steps |
| gpt-5.1 | 0.14 | ~$0.15 | ~$0.45 | 1/5; stopped early often |
| gpt-5.4 | 0.46 | ~$0.75 | ~$2.50 | **0/5**; flagship underperformed mini |
| gpt-oss:120b | 1.01 | ~$0.10 | ~$0.30 | 0/5 |
| gpt-5.4-nano | 0.31 | ~$0.05 | ~$0.15 | 0/5 |
| qwen3-coder:30b | 2.07 | $0 | $0 | local |

Pre-run estimates that assumed ~3M prompt (Kimi-scale) for OpenAI were **high** for the minis. Level-ups used more tokens (esp. gpt-5.2 on financial) but still did not approach Kimi/GLM Harbor scores.

## OpenAI harness notes

Harbor now accepts `--provider openai|anthropic` (peer SDKs bundled into the agent install; `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` forwarded into the container). The CLI no longer treats the default Ollama `baseUrl` as an OpenAI gateway.

## Run artifacts

| Model | Run id | Notes |
| --- | --- | --- |
| kimi (cloud-max) **post-guard** | `2026-10-30T16-40-35-263Z` | n-concurrent 5 |
| minimax-m3:cloud **post-guard** | `2026-10-30T17-32-40-869Z` | n-concurrent 5 |
| glm-5.3-flash:cloud **post-guard** | `2026-10-30T18-22-49-231Z` | n-concurrent 5; 5-task |
| glm-5.3-flash:cloud **10-task** | `2026-10-30T21-19-34-889Z` | n-concurrent 5; sample 10; 6/10 |
| glm-5.3-flash:cloud **10-task re-run** | `2026-10-31T01-26-55-633Z` | after command fraction-cap; 5/10 |
| glm-5.3-flash:cloud **10-task + trunc fix** | `2026-10-31T02-51-33-552Z` | hardened empty/trunc retries; 6/10 |
| glm-4.7-flash (local 4090) | `2026-10-30T19-44-29-118Z` | serial; 0/5 |
| kimi (cloud-max) pre-guard | `2026-10-29T03-03-11-723Z` | serial |
| qwen3-coder:30b | `2026-10-29T17-33-09-040Z` | |
| gpt-oss:120b-cloud | `2026-10-29T19-15-59-661Z` | |
| glm-5.3-flash:cloud pre-guard | `2026-10-29T20-43-24-454Z` | serial |
| minimax-m3:cloud pre-guard | `2026-10-29T21-51-49-477Z` | serial |
| gpt-5.4-mini | `2026-10-30T14-09-00-812Z` | |
| gpt-5.4-nano | `2026-10-30T14-19-18-069Z` | |
| gpt-5.1 | `2026-10-30T14-31-21-458Z` | |
| gpt-5.4 | `2026-10-30T15-32-24-770Z` | |
| gpt-5.2 | `2026-10-30T15-53-26-170Z` | |

Paths: `../halo-agent-benchmark/recognized/terminal-bench/<run-id>/`

## 10-task expansion (same seed) — GLM Flash cloud

Same seed `3717582705` with `--sample 10` is a **superset** of the 5-task mini (seeded shuffle + take-N). `--tier-preset cloud` · `n_concurrent=5`.

| Run | Harbor | Outcome | Process | Prompt (Σ) | Cached | Est. cost | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `2026-10-30T21-19-34-889Z` | **6/10** | 68.2 | 63.7 | 4.37M | 3.88M (89%) | ≈ $0.34 | first 10-task; pre fraction-cap |
| `2026-10-31T01-26-55-633Z` | **5/10** | 56.5 | 57.6 | 3.64M | 3.29M (90%) | ≈ $0.34 | post fraction-cap; cobol/torch empty-failed |
| `2026-10-31T02-51-33-552Z` | **6/10** | **69.3** | 62.7 | 3.77M | ~90% | ≈ $0.34 | post truncated-retry harden; cobol+torch recovered |

Per-task Harbor (R1 → R2 → R3):

| Task | R1 | R2 | R3 | Outcome / process (R3) | Steps (R3) |
| --- | :---: | :---: | :---: | ---: | ---: |
| count-dataset-tokens *(new)* | PASS | PASS | PASS | 96 / 70 | 21 |
| extract-elf | PASS | PASS | PASS | 94 / 58 | 26 |
| financial-document-processor | PASS | PASS | PASS | 93 / 78 | 28 |
| git-leak-recovery *(new)* | PASS | PASS | PASS | 96 / 93 | 8 |
| cobol-modernization *(new)* | PASS | fail | **PASS** | 93 / 84 | 21 |
| torch-tensor-parallelism | PASS | fail | **PASS** | 93 / 56 | 17 |
| sam-cell-seg | fail | PASS | fail | 28 / 42 | 33 |
| qemu-startup | fail | fail | fail | 46 / 74 | 28 |
| extract-moves-from-video *(new)* | fail | fail | fail | 24 / 34 | 37 |
| feal-differential-cryptanalysis *(new)* | fail | fail | fail | 30 / 38 | 13 |

Stable PASS across all three: financial, extract-elf, count-dataset-tokens, git-leak. R3 recovered the R2 empty-stops on **cobol** and **torch** after the truncated/empty retry prompts were hardened (no plain-text escape; name missing deliverables → `write_file`). `feal` still fails but progressed (4 → 13 steps, 7 tools, outcome 5 → 30). `truncated-turns` still on 5 tasks; `empty-retries` down 5 → 3 vs R2. `sam` flipped again (fail this run).

### What `think` the cloud preset actually sends

Checked against this run + Ollama `/api/show` for `glm-5.3-flash:cloud`:

| Layer | Value |
| --- | --- |
| Harbor `--ak` / adapter CLI | no `--think` flag (comment: “Think mode follows CLI defaults”) |
| `--tier-preset cloud` policy | `think: null` — only **`cloud-max`** forces `think: max` |
| CLI / report `flags.think` | **`auto`** (default) |
| Model capabilities | `completion, thinking, tools, vision` |
| Resolved Ollama body field | **`think: true`** (`auto` → boolean on for thinking-capable non-gpt-oss models) |

So the value cloud pin **does** reason; it does **not** run at `think: max` (that is Kimi / `cloud-max` only). Five tasks still flagged `truncated-turns`: the cutoffs matched the 12k `num_predict` output reserve (e.g. feal dumped ~12k completion tokens of FEAL analysis into the **content** channel with almost empty `thinking`), not runaway thinking-channel spend. `extract-moves-from-video` burned wall clock on one `timeout_seconds: 1800` tesseract blast; the deadline clamp only reserved 45s then, so the command could still take ~23 minutes — tightened to also cap any single command at **50% of usable remaining** wall clock (`DEADLINE_MAX_COMMAND_FRACTION`).

```powershell
node evals/recognized/run.mjs terminal-bench --dataset 2.1 --model auto --tier-preset cloud `
  --sample 10 --seed 3717582705 --n-concurrent 5
```

## Recommended publish pins (this seed) — now in `PINNED_MODELS`

| Role | Model | Harbor | Wiring |
| --- | --- | ---: | --- |
| **Cloud value** | `glm-5.3-flash:cloud` | **4/5** | `PINNED_MODELS.cloud` · `--tier-preset cloud` · hybrid tier 4+ |
| **Cloud max** | `kimi-k2.7-code:cloud` + think max | **4/5** | `PINNED_MODELS.cloudMax` · `--tier-preset cloud-max` |
| **Local (4090)** | `qwen3-coder:30b` | **0/5** | `PINNED_MODELS.local` · `local` / hybrid tiers ≤3 (vision: `devstral-small-2`) |

**Hybrid:** tiers 0–3 → local pin; tier 4+ → GLM Flash. No mid-run escalation. Local `glm-4.7-flash` also **0/5** on this seed — cloud Flash quality does not transfer to the local tag.

## Takeaways

1. **Deliverable-guard fix raised process scores** on all three Ollama cloud models (+11 to +20) by stopping post-success “write the input file” steers. GLM Flash cloud also cut prompt tokens ~26% and picked up torch (3/5 → **4/5**).
2. **Kimi and GLM Flash cloud** tie at **4/5**; GLM is the clear **value** pick (~$0.22–0.63 vs Kimi ~$2–6).
3. **Local 4090 models failed this mini:** `qwen3-coder:30b` and `glm-4.7-flash` both **0/5**. Cloud quality does not come with the Flash local tag.
4. **MiniMax** process improved post-guard but Harbor dropped to **3/5** on this re-run (lost sam).
5. **OpenAI** still ≤**1/5** on this seed.
6. Shared miss: **qemu-startup**.
7. **Parallel cloud trials work** — use `--n-concurrent` equal to the sample size when the LLM is not on a local GPU.
8. **10-task GLM Flash** on this seed: **6/10 → 5/10 → 6/10**. Hardened trunc/empty retries recovered cobol+torch empty-stops; feal still hard. Cache ~**90%** → ≈ **$0.34**/run. Remaining misses: qemu, extract-moves, feal, sam (flippy).

## Reproduce

```powershell
# Ollama cloud (parallel tasks; post-guard baseline)
node evals/recognized/run.mjs terminal-bench --dataset 2.1 --model auto --tier-preset cloud-max --sample 5 --seed 3717582705 --n-concurrent 5
node evals/recognized/run.mjs terminal-bench --dataset 2.1 --model minimax-m3:cloud --sample 5 --seed 3717582705 --n-concurrent 5
node evals/recognized/run.mjs terminal-bench --dataset 2.1 --model glm-5.3-flash:cloud --sample 5 --seed 3717582705 --n-concurrent 5

# Local / serial (4090)
.\bin\bench-tb-mini.ps1 -Count 5 -Seed 3717582705 -Model "glm-4.7-flash"
.\bin\bench-tb-mini.ps1 -Count 5 -Seed 3717582705 -Model "qwen3-coder:30b"
.\bin\bench-tb-mini.ps1 -Count 5 -Seed 3717582705 -Model "gpt-oss:120b-cloud"

# OpenAI (parallel tasks; needs OPENAI_API_KEY)
node evals/recognized/run.mjs terminal-bench --dataset 2.1 --provider openai --model gpt-5.4-mini --sample 5 --seed 3717582705 --n-concurrent 5
node evals/recognized/run.mjs terminal-bench --dataset 2.1 --provider openai --model gpt-5.4-nano --sample 5 --seed 3717582705 --n-concurrent 5
node evals/recognized/run.mjs terminal-bench --dataset 2.1 --provider openai --model gpt-5.1 --sample 5 --seed 3717582705 --n-concurrent 5
node evals/recognized/run.mjs terminal-bench --dataset 2.1 --provider openai --model gpt-5.4 --sample 5 --seed 3717582705 --n-concurrent 5
node evals/recognized/run.mjs terminal-bench --dataset 2.1 --provider openai --model gpt-5.2 --sample 5 --seed 3717582705 --n-concurrent 5
```
