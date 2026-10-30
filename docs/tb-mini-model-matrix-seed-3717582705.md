# Terminal-Bench mini — model matrix

**Dataset:** Terminal-Bench 2.1  
**Sample:** 5 of 89 tasks · **seed** `3717582705`  
**Tasks:** `financial-document-processor`, `qemu-startup`, `extract-elf`, `torch-tensor-parallelism`, `sam-cell-seg`  
**Agent:** halo-agent 1.1.25–1.1.26 · `max_steps=80` · `num_ctx=65536`  
**Harness:** Harbor (mechanical reward) + Cursor judge (outcome / process)  
**Concurrency:** Ollama runs used `n_concurrent=1`; OpenAI runs used `n_concurrent=5` (tasks in parallel)

## Scorecard

| Model | Harbor | Outcome | Process | Runtime | Prompt tokens (Σ) | Est. run cost |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `kimi-k2.7-code:cloud` (cloud-max, think:max) | **4/5** | 81.8 | 59.2 | 50m | 2.99M | **~$1.85 – $5.25** |
| `minimax-m3:cloud` | **4/5** | 91.3† | 40.0† | 1h 38m | 7.21M | **~$2.80 – $7.80** |
| `glm-5.3-flash:cloud` | **3/5** | 64.4 | 49.6 | 1h 1m | 3.42M | **~$0.30 – $0.85** |
| `gpt-5.2` (OpenAI) | 1/5 | 50.6 | 58.8 | ~25m‡ | 0.70M | **~$0.95 – $3.20** |
| `gpt-5.4-mini` (OpenAI) | 1/5 | 43.6 | 54.0 | ~11m‡ | 0.29M | **~$0.15 – $0.50** |
| `gpt-5.1` (OpenAI) | 1/5 | 36.4 | 50.2 | ~26m‡ | 0.14M | **~$0.15 – $0.45** |
| `gpt-5.4` (OpenAI) | 0/5 | 36.0 | 53.2 | ~15m‡ | 0.46M | **~$0.75 – $2.50** |
| `gpt-oss:120b-cloud` | 0/5 | 27.6 | 45.8 | 25m | 1.01M | **~$0.10 – $0.30** |
| `gpt-5.4-nano` (OpenAI) | 0/5 | 24.8 | 45.2 | ~12m‡ | 0.31M | **~$0.05 – $0.15** |
| `qwen3-coder:30b` (local 4090) | 0/5 | 30.0 | 51.6 | 55m | 2.07M | **$0** |

† MiniMax: judge failed JSON on `qemu-startup` (4/5 graded); Harbor still 4/5.  
‡ Wall-clock with `--n-concurrent 5` (five Harbor trials at once). Serial Ollama runs are roughly the sum of task times.

## Per-task Harbor results

| Task | Kimi | MiniMax | GLM Flash | gpt-5.2 | gpt-5.4-mini | gpt-5.1 | gpt-5.4 | GPT-OSS 120B | gpt-5.4-nano | Qwen 30B |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| extract-elf | PASS | PASS | PASS | fail | fail | PASS | fail | fail | fail | fail |
| financial-document-processor | PASS | PASS | PASS | fail | fail | fail | fail | fail | ERR | fail |
| qemu-startup | fail | fail | fail | fail | fail | fail | fail | fail | fail | fail |
| sam-cell-seg | PASS | PASS | PASS | PASS | PASS | fail | fail | fail | fail | fail |
| torch-tensor-parallelism | PASS | PASS | fail | fail | fail | fail | fail | ERR | fail | fail |

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
| kimi-k2.7-code | 2.99 | ~$1.85 | ~$5.25 | cloud-max / max think |
| minimax-m3 | 7.21 | ~$2.80 | ~$7.80 | most tokens |
| glm-5.3-flash | 3.42 | ~$0.30 | ~$0.85 | best $/Harbor among models that scored ≥3 |
| gpt-5.2 | 0.70 | ~$0.95 | ~$3.20 | 1/5 (sam); more tokens than minis |
| gpt-5.4-mini | 0.29 | ~$0.15 | ~$0.50 | cheap miss (1/5); few steps |
| gpt-5.1 | 0.14 | ~$0.15 | ~$0.45 | 1/5; stopped early often |
| gpt-5.4 | 0.46 | ~$0.75 | ~$2.50 | **0/5**; flagship underperformed mini |
| gpt-oss:120b | 1.01 | ~$0.10 | ~$0.30 | 0/5 |
| gpt-5.4-nano | 0.31 | ~$0.05 | ~$0.15 | 0/5 |
| qwen3-coder:30b | 2.07 | $0 | $0 | local |

Pre-run estimates that assumed ~3M prompt (Kimi-scale) for OpenAI were **high** for the minis. Level-ups used more tokens (esp. gpt-5.2 on financial) but still did not approach Kimi/MiniMax Harbor scores.

## OpenAI harness notes

Harbor now accepts `--provider openai|anthropic` (peer SDKs bundled into the agent install; `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` forwarded into the container). The CLI no longer treats the default Ollama `baseUrl` as an OpenAI gateway.

## Run artifacts

| Model | Run id |
| --- | --- |
| kimi (cloud-max) | `2026-10-29T03-03-11-723Z` |
| qwen3-coder:30b | `2026-10-29T17-33-09-040Z` |
| gpt-oss:120b-cloud | `2026-10-29T19-15-59-661Z` |
| glm-5.3-flash:cloud | `2026-10-29T20-43-24-454Z` |
| minimax-m3:cloud | `2026-10-29T21-51-49-477Z` |
| gpt-5.4-mini | `2026-10-30T14-09-00-812Z` |
| gpt-5.4-nano | `2026-10-30T14-19-18-069Z` |
| gpt-5.1 | `2026-10-30T14-31-21-458Z` |
| gpt-5.4 | `2026-10-30T15-32-24-770Z` |
| gpt-5.2 | `2026-10-30T15-53-26-170Z` |

Paths: `../halo-agent-benchmark/recognized/terminal-bench/<run-id>/`

## Takeaways

1. **Kimi and MiniMax** still lead this draw at **4/5**; MiniMax burns more tokens so estimated spend can exceed Kimi.
2. **GLM-5.3 Flash** remains the **value** pick among models that clear ≥3 tasks (~$0.30–0.85).
3. **OpenAI level-up did not close the gap.** `gpt-5.2` = **1/5** (sam only, best OpenAI outcome 50.6); flagship `gpt-5.4` = **0/5** — worse Harbor than `gpt-5.4-mini`. Failures look like agent-loop issues (compaction wipe, overwriting inputs, no verify) more than raw model quality.
4. **OpenAI minis / gpt-5.1** still **1/5** (sam vs extract-elf). Cheap because they under-explored.
5. **gpt-5.4-nano** and **local Qwen / gpt-oss 120B** cleared nothing on this seed.
6. Shared miss: **qemu-startup**.
7. **Parallel cloud trials work** — use `--n-concurrent` equal to the sample size when the LLM is not on a local GPU.

## Reproduce

```powershell
# Ollama (serial)
.\bin\bench-tb-mini.ps1 -Count 5 -Seed 3717582705 -Model "kimi-k2.7-code:cloud"
.\bin\bench-tb-mini.ps1 -Count 5 -Seed 3717582705 -Model "minimax-m3:cloud"
.\bin\bench-tb-mini.ps1 -Count 5 -Seed 3717582705 -Model "glm-5.3-flash:cloud"
.\bin\bench-tb-mini.ps1 -Count 5 -Seed 3717582705 -Model "gpt-oss:120b-cloud"
.\bin\bench-tb-mini.ps1 -Count 5 -Seed 3717582705 -Model "qwen3-coder:30b"

# OpenAI (parallel tasks; needs OPENAI_API_KEY)
node evals/recognized/run.mjs terminal-bench --dataset 2.1 --provider openai --model gpt-5.4-mini --sample 5 --seed 3717582705 --n-concurrent 5
node evals/recognized/run.mjs terminal-bench --dataset 2.1 --provider openai --model gpt-5.4-nano --sample 5 --seed 3717582705 --n-concurrent 5
node evals/recognized/run.mjs terminal-bench --dataset 2.1 --provider openai --model gpt-5.1 --sample 5 --seed 3717582705 --n-concurrent 5
node evals/recognized/run.mjs terminal-bench --dataset 2.1 --provider openai --model gpt-5.4 --sample 5 --seed 3717582705 --n-concurrent 5
node evals/recognized/run.mjs terminal-bench --dataset 2.1 --provider openai --model gpt-5.2 --sample 5 --seed 3717582705 --n-concurrent 5
```
