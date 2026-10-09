# Final comparison: planning line A/B

Measured 2026-10-09. `optimization-audit.md` ranks the bottlenecks on the 83-run baseline (Claude Code 2.1.293) and picks this optimization; this report measures it. Machine-readable results: `optimization-results.json` (look vs control), `ablation-results.json` (brief vs control, look vs brief) and `baseline-results.json` (the baseline, native vs Token Forge).

## Setup

- Model `claude-opus-5-5`, Claude Code 2.1.295, plugin build `c9de32debeea` (`plugin_sha256` in `bench/environments/token-forge/manifest.json`: commit `415385f` plus uncommitted changes), lean `balanced`, subscription login (`--use-local-login`).
- Three arms, each the full suite of 36 tasks with one run per task, `--jobs 2`, seed 9105. All three started together at 16:29:33 UTC, so they share the same hours of provider load.

| Arm | Planning line | Session |
|---|---|---|
| control | none (the default when the A/B ran) | `bench/runs/2026-10-09T16-29-32-5c82` |
| plan-brief (ablation) | `TFORGE_PLAN=brief` | `bench/runs/2026-10-09T16-29-32-15b5` |
| plan-look (the optimization) | `TFORGE_PLAN=look`, now the default | `bench/runs/2026-10-09T16-29-32-ce47` |

- Commands, as run in `bench/`:

  ```sh
  T=architecture,banking-transfers,banking-web,bash-tool,c-cli,cpp-cli,cross-module-debug,csharp-api,dart-cli,elixir-app,fsharp-cli,go-api,go-feature,go-mock-api,haskell-cli,java-http,kotlin-cli,lua-cli,luau-inventory,node-ssg,ocaml-cli,paper-proofread,pdf-paper-qa,perl-cli,php-api,pr-review,python-cli,r-cli,refactor,rust-cli,rust-debug,rust-tui,swift-cli,ts-lib,vite-landing,zig-cli
  python3 runner/bench.py run --task $T --agent token-forge --jobs 2 --seed 9105 --use-local-login
  python3 runner/bench.py run --task $T --agent token-forge --jobs 2 --seed 9105 --use-local-login --variant plan-brief --tf-env TFORGE_PLAN=brief
  python3 runner/bench.py run --task $T --agent token-forge --jobs 2 --seed 9105 --use-local-login --variant plan-look --tf-env TFORGE_PLAN=look
  python3 scripts/optimization.py -a control=runs/2026-10-09T16-29-32-5c82 -a plan-look=runs/2026-10-09T16-29-32-ce47 -p plan-look:control -o reports/optimization-results.json
  python3 scripts/optimization.py -a control=runs/2026-10-09T16-29-32-5c82 -a plan-brief=runs/2026-10-09T16-29-32-15b5 -a plan-look=runs/2026-10-09T16-29-32-ce47 -p plan-brief:control -p plan-look:plan-brief -o reports/ablation-results.json
  ```

  To repeat it now that `look` is the default, run `python3 runner/bench.py env build` first and give control `--variant no-plan --tf-env TFORGE_PLAN=0`. Every `bench.py run` also rebuilds the tracked `benchmark-report.*` (E6).
- Where each number comes from:
  - Provider-reported (the API usage in the transcripts, final entry per request): input, cache reads, cache writes by TTL, output, and thinking (`output_tokens_details.thinking_tokens`).
  - Computed: `list_cost_usd` prices that usage at `benchmark.config.json` → `pricing`, the Opus 5.5 list prices effective 2026-10-09 ([Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Claude Opus 5.5](https://www.anthropic.com/claude-opus-5-5)). It agrees with Claude Code's own `total_cost_usd` within 0.5% on 108 of 108 runs. That figure is Claude Code's calculation, not an invoice: a subscription login has no per-run invoice, and list cost is roughly what usage limits count.
  - Measured locally: wall-clock, CPU seconds and peak RSS (`wait4` rusage: the largest resident set of any process in the agent's tree, not the tree's total), hook time as Claude Code logs it, requests and tool calls.
  - Quality: each task's `eval.json` checks (build, tests, lint, format, typecheck), scored for correctness 40, regression 20, architecture 15, completeness 15 and cleanliness 10, plus its hidden tests.
  - Estimates: the cost attribution, the code vs prose split of visible output (by characters) and the 5-minute TTL break-even (E2; no cache entry expired in any run). The attribution charges every token's whole cost (generated, written to the cache, re-read on each later call) to where it came from: initial context, thinking, visible output or tool results. It sums to `list_cost_usd` within $0.00001 on every run.
  - Unavailable: an invoice, the agent tree's total memory, and a price for local compute.
- Objective, weights in `benchmark.config.json` → `objective`: J = α·cost + β·wall-clock + γ·CPU + δ·failure, with α = 1, β = $0.001 per second, γ = 0, δ = $2 and failure = 1 − quality/100 (1 for a run without a score).
- Statistics: one run per task and arm, so n = 36 paired tasks. Geo-mean change = exp(mean of log(new/base)) − 1 with a 95% t-interval; pooled = ratio of the suite totals − 1; sign test = exact two-sided binomial over tasks, ties dropped. Per-run tables give mean / median / stdev. A cold-start run is one whose first request read nothing from the cache (2 per arm); C reports cold and warm runs separately.
- Caveats:
  - TTL: all 108 runs wrote every cache entry with the 1-hour TTL (2× input). By a static reading of Claude Code 2.1.295, a subscription login's main thread gets 1 hour and API-key sessions get 5 minutes (1.25×). API-key users therefore see other absolute costs and cache-write shares. The line cuts output and cache reads either way, but it was not measured under 5-minute TTLs.
  - Load: the arms overlapped. The mean number of runs in progress (all arms, at most 6) during each arm's runs was 5.19 for control, 5.63 for brief and 5.83 for look. Look ran under the most load, so its wall-clock gain is if anything understated.
  - Versions: the baseline ran on 2.1.293 and the A/B on 2.1.295, and control's up-front thinking changed between them (B2). Every comparison here is within 2.1.295; native was not re-run on it.
  - State left behind: the environment manifests are as `bench.py env build` rebuilt them for the A/B (2.1.295, `c9de32debeea`); `bench/reports/benchmark-report.*` still hold the 2.1.293 baseline (E6).

## A. Bottlenecks ranked by measured impact

Baseline (`optimization-audit.md`, section 5): Token Forge, 40 runs on 36 tasks, Claude Code 2.1.293, as shares of its list cost.

| Rank | Bottleneck | Share of cost | Finding |
|---|---|---:|---|
| 1 | Visible output | 45.8% | By characters (an estimate), about 96% is tool-call input (file content and commands) and 4% prose. It is the deliverable, and already 33% below native |
| 2 | 1-hour cache writes | 39.6% | A price component that cuts across the other rows. Every write was a 1-hour write; with 5-minute writes and no expiry the suite would cost 14.8% less (a model) |
| 3 | Thinking | 31.8% | Token Forge's only regression against native: +$0.042 per task (95% CI +$0.005 to +$0.079). First-request thinking was higher on 17 of 23 tasks (p = 0.035), and it caused both tasks that cost more than native: `c-cli` +9.5%, `perl-cli` +5.4% |
| 4 | Tool results + initial context | 13.5% + 9.0% | Already 37–50% below native |
| 5 | Cache misses | none | None in Token Forge; one in native (483 tokens) |

Rows 1, 3 and 4 partition the cost (the attribution). The price components, output 54.1%, 1-hour writes 39.6% and cache reads 6.3%, are a second cut of the same total.

The same split on the A/B (2.1.295, from C):

| Part | control | look | Change, suite total |
|---|---:|---:|---:|
| Initial context | 8.5% | 10.3% | −$0.05 |
| Thinking | 35.3% | 24.1% | −$5.28 |
| Visible output | 44.1% | 51.0% | −$0.89 |
| Tool results | 12.2% | 14.6% | −$0.11 |
| Price components: output / 1-hour writes / cache reads | 54.8% / 37.8% / 7.4% | 52.4% / 40.5% / 7.1% | |

83% of the $6.33 saved on the suite is attributed to thinking. The initial context costs less despite the longer policy, because fewer requests re-read it. After `look`, the order is visible output (51.0%), 1-hour writes (40.5%, price component), thinking (24.1%), tool results (14.6%) and initial context (10.3%).

The audit's three highest-impact opportunities (section 6) are:

1. Up-front planning thinking: implemented here (B2).
2. 5-minute cache writes: not implemented, conditional (E2).
3. Tool-result and context volume: not implemented (E1).

## B. What was changed

### B1. Measurement pipeline (correctness of the numbers, not a cost change)

- Problem:
  - The benchmark's only cost figure (`input_equivalent_tokens`) used fixed weights that do not match Opus 5.5: cache reads at 0.1× instead of 0.05×, and cache writes at 1.25× although every main-session write was a 1-hour write at 2×.
  - Nothing checked that figure against Claude Code's own cost.
  - Output of streamed responses could be undercounted.
  - Thinking, the cache-write TTL, the cold first request, hook time, memory and CPU were not recorded.
  - There were no confidence intervals.
- Root cause: the parser predates per-TTL cache pricing and was never reconciled with Claude Code's own cost.
- Implementation:
  - `pricing` per model, with source and effective date, in `benchmark.config.json`; no price is in the code.
  - `list_cost_usd` per request from the logged TTL split, reconciled with Claude Code's `total_cost_usd` (0.5% tolerance), using the final usage entry per `requestId`.
  - New fields: TTL split, thinking, first request, cache misses and idle gaps, hook time, and `peak_rss_mb` and `cpu_seconds` from `wait4` rusage.
  - `bench.py retelemetry` re-derives telemetry from saved transcripts without re-running agents.
  - The preflight validator accepts the `autoCompactWindow` value the current build writes.
  - `scripts/optimization.py` produces the paired statistics, cold vs warm, the objective J and the cost attribution.
- Complexity: `telemetry.py` +122/−22 lines, `bench.py` +88/−17, `report.py` +50/−8, `isolation.py` +13/−1, config +16, `bench/README.md` +18/−4. New files: `scripts/optimization.py` (363 lines), `runner/test_telemetry.py` (130) and `runner/test_optimization.py` (86). No new dependency (standard library only).
- Effect on tokens, cache and latency: none. It changes what is measured, not what is spent.
- Risks: the legacy field is kept unchanged, so old comparisons still work; `retelemetry` only adds fields unless given `--force`.
- Test evidence:
  - 18/18 Python tests (`python3 -m unittest discover -s bench/runner -p 'test_*.py'`).
  - 83/83 baseline runs and 108/108 A/B runs (36/36 per arm) reconcile with Claude Code's own cost.
  - The attribution sums to `list_cost_usd` within $0.00001 on every run.

### B2. The planning line, now the default (`TFORGE_PLAN=look`)

- Problem: thinking is Token Forge's only cost regression against plain Claude Code (A, rank 3). It was concentrated in the first request of greenfield tasks, which planned 23–27k tokens before looking at the repository (`c-cli` 23,273 and `perl-cli` 26,545 first-request thinking tokens).
- Root cause (the hypothesis tested): the policy asks for few calls and small results but says nothing about thinking. Thinking is billed as output (5× input), stays in the conversation, and is written to the cache and re-read on every later call. Asking for fewer calls pushed the work into one long plan up front.
- What the A/B found:
  - On Claude Code 2.1.295 the up-front spike did not reproduce in control (first-request thinking: mean 352, median 14 tokens).
  - Thinking was still 43.9% of control's output tokens and 35.3% of its cost, spread over the whole session.
  - The line cut it there: thinking −44% pooled, lower on 33 of 36 tasks, and with it cache reads −23%, tool calls −20% and wall-clock −21%.
  - So the line works on thinking throughout the session, not only on the first plan.
- Implementation: one line of policy text in `kitPolicy` (`hooks/session-start.mjs`), the default in main sessions:

  > Planning: thinking is output, priced like the code you write and re-read on every later call (a few hundred tokens ≈ one extra tool call). Look before you plan: the first call lists the repo and reads the key files, with little thinking; then plan briefly (key decisions only) and write. Never draft code in thinking; write it into the files.

  - It adds 106 input tokens to the first request (median of 36 paired tasks, range 97–112). They are written to the cache once and read from it after that, and every cost figure below includes them.
  - `TFORGE_PLAN=0` drops the line; `TFORGE_PLAN=brief` uses the shorter opt-in line from 0.8.0 instead.
  - Subagents (SubagentStart) get no planning line unless `TFORGE_PLAN` names one, because the default was measured on main sessions only.
- Complexity:
  - `kitPolicy(quiet, subagent = false)` with the default `process.env.TFORGE_PLAN ?? (subagent ? '' : 'look')`.
  - The line is one array entry under a 3-line comment.
  - SubagentStart calls `kitPolicy(true, true)`.
  - The header comment's size note changed.
  - No code path, file read, cache or tool behaviour changes.
  - Tests: 5 new assertions in `test/hooks.test.mjs` (the default line, `brief`, `0`, and a subagent without and with `TFORGE_PLAN`), plus two raised size bounds (policy < 1,575 characters, the whole session-start context < 1,905; measured 1,552 and 1,880).
- Effect (look vs control, C):

  | Metric | Change |
  |---|---|
  | List cost | −15.5% per task (geometric mean, 95% CI −20.8% to −9.8%), −18.8% pooled ($33.68 → $27.35 for the suite); lower on 27 of 36 tasks (sign test p = 0.0039) |
  | J | −14.4% [−20.5, −7.8] |
  | Total tokens | −21.6% pooled |
  | Thinking | −43.9% |
  | Cache | reads −22.7%, writes −12.9% |
  | Tool calls | −20.2% |
  | Wall-clock | −20.9% pooled (−16.4% geo, p = 0.0013) |
  | Quality | −0.26 points [−1.03, +0.52]; hidden tests 1215/1219 in both arms |
  | Local compute | CPU −1.7%, peak RSS −3.6%, mean hook time 317 → 276 ms: no change beyond noise |
- Risks:
  - Less planning could lower quality on design-heavy tasks.
  - A longer look phase could add tool calls on existing codebases.
  - Measured: quality held within resolution (D2 lists the four drops). Tool calls fell overall but rose on some tasks (`go-feature` 11 → 24), and nine tasks cost more (D1).
  - Unmeasured: subagents, large repositories, compacted or resumed sessions, and API-key sessions (E4).
- Test evidence: JS suite 81/81 (`npm test`) and the A/B in C.

### B3. Ablation: `TFORGE_PLAN=brief`

The opt-in line from 0.8.0 ("Planning: think briefly (key decisions only), then write; let the files carry the detail. Re-plan only when a check fails.") is the brevity part of `look` alone. `brief` vs control isolates brevity. `look` vs `brief` isolates the rest of `look`: the price framing, looking first and no code in thinking. The ablation is not factorial, so those three parts are not separated from each other.

| Comparison (36 paired tasks) | List cost, geo-mean [95% CI] | Pooled | Lower / higher (sign p) | Thinking, pooled | First-request thinking, pooled | Wall-clock, pooled | Quality, mean diff [95% CI] |
|---|---|---:|---|---:|---:|---:|---|
| brief vs control | −7.2% [−12.8, −1.1] | −8.2% | 22 / 14 (0.243) | −25.7% | +217.6% | −11.2% | −0.51 [−1.42, +0.41] |
| look vs brief | −9.0% [−13.5, −4.2] | −11.6% | 25 / 11 (0.029) | −24.5% | −99.4% | −11.0% | +0.25 [−0.40, +0.90] |
| look vs control | −15.5% [−20.8, −9.8] | −18.8% | 27 / 9 (0.0039) | −43.9% | −98.1% | −20.9% | −0.26 [−1.03, +0.52] |

Brevity alone buys about half of the cost reduction. But it moves thinking to the start of the session: first-request thinking rose on 17 of the 23 tasks where it differed (`bash-tool` 43 → 10,907 tokens), which is the up-front plan the line was meant to prevent. With brief, 14 tasks cost more than control, up to `rust-cli` +26.7% and `go-feature` +24.0%. The rest of `look` removes the up-front plan (−99%) and leaves 9 tasks costlier than control instead of 14.

## C. Before / after (measured)

Generated by `scripts/optimization.py` from the three sessions (`optimization-results.json`, `ablation-results.json`). Token counts are provider-reported; list cost and J are computed from them; the attribution is an estimate (Setup). n = 36 runs per arm, one per task.

### Per arm

| Metric (mean / median / stdev) | control (n=36, 36 tasks) | plan-brief (n=36, 36 tasks) | plan-look (n=36, 36 tasks) |
|---|---:|---:|---:|
| Total tokens | 417,821 / 341,702 / 334,419 | 406,680 / 332,464 / 361,326 | 327,525 / 282,586 / 218,063 |
| Input tokens (all) | 392,211 / 299,762 / 327,236 | 383,934 / 302,600 / 355,602 | 307,636 / 256,388 / 212,714 |
|   uncached input | 20 / 18 / 10 | 20 / 19 / 10 | 18 / 16 / 7 |
|   cache reads | 347,993 / 255,104 / 314,798 | 341,966 / 261,568 / 340,011 | 269,110 / 222,741 / 198,730 |
|   cache writes | 44,198 / 41,638 / 17,533 | 41,947 / 41,962 / 19,199 | 38,508 / 35,078 / 15,809 |
|     5-minute writes | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
|     1-hour writes | 44,198 / 41,638 / 17,533 | 41,947 / 41,962 / 19,199 | 38,508 / 35,078 / 15,809 |
| Output tokens | 25,609 / 23,854 / 16,562 | 22,747 / 22,362 / 13,411 | 19,889 / 18,130 / 11,212 |
|   thinking | 11,248 / 8,333 / 10,428 | 8,353 / 6,382 / 7,124 | 6,306 / 3,536 / 5,965 |
|   visible | 14,361 / 14,838 / 7,342 | 14,394 / 15,292 / 7,077 | 13,583 / 13,770 / 6,617 |
| First-request thinking | 352 / 14 / 1,362 | 1,119 / 16 / 3,002 | 7 / 6 / 7 |
| API cost, list (USD) | 0.9355 / 0.8538 / 0.4722 | 0.8590 / 0.8131 / 0.4186 | 0.7597 / 0.6935 / 0.3345 |
| API cost, Claude Code reported (USD) | 0.9355 / 0.8538 / 0.4722 | 0.8590 / 0.8131 / 0.4186 | 0.7597 / 0.6935 / 0.3345 |
|   first request (USD) | 0.0666 / 0.0619 / 0.0319 | 0.0823 / 0.0627 / 0.0626 | 0.0606 / 0.0612 / 0.0153 |
|   rest (USD) | 0.8689 / 0.7944 / 0.4722 | 0.7767 / 0.7274 / 0.4208 | 0.6991 / 0.6348 / 0.3299 |
| API requests | 10 / 9 / 5 | 10 / 10 / 5 | 9 / 8 / 3 |
| Tool calls | 12 / 10 / 7 | 11 / 11 / 6 | 10 / 8 / 5 |
| Wall-clock (s) | 234.0 / 215.1 / 144.4 | 207.8 / 187.6 / 118.4 | 185.1 / 157.5 / 101.7 |
| CPU, agent process (s) | 15.7 / 9.1 / 19.0 | 15.4 / 9.8 / 17.4 | 15.4 / 8.0 / 19.9 |
| Peak RSS (MB) | 324.5 / 277.2 / 144.4 | 315.4 / 279.2 / 113.9 | 312.8 / 276.1 / 110.4 |
| Hook time (ms) | 317 / 278 / 156 | 328 / 280 / 181 | 276 / 243 / 123 |
| Quality score | 99.50 / 100.00 / 1.38 | 98.99 / 100.00 / 2.65 | 99.24 / 100.00 / 1.93 |
| Failure (1 - quality/100) | 0.0050 / 0.0000 / 0.0138 | 0.0101 / 0.0000 / 0.0265 | 0.0076 / 0.0000 / 0.0193 |
| Objective J (USD) | 1.1795 / 1.0691 / 0.6148 | 1.0870 / 1.0132 / 0.5241 | 0.9600 / 0.8235 / 0.4272 |

| Arm | statuses | sum list cost | sum J | quality mean | hidden tests | reconciled | attribution sums | cold-start runs |
|---|---|---:|---:|---:|---|---|---|---|
| control | completed 36 | 33.6763 | 42.4613 | 99.50 | 1215/1219 | 36/36 | 36/36 | 2 |
| plan-brief | completed 36 | 30.9235 | 39.1337 | 98.99 | 1214/1219 | 36/36 | 36/36 | 2 |
| plan-look | completed 36 | 27.3504 | 34.5603 | 99.24 | 1215/1219 | 36/36 | 36/36 | 2 |

Cold vs warm (list cost, mean / median / stdev):

| Arm | first-request share of cost | cold-start runs | warm-start runs |
|---|---:|---|---|
| control | 0.0712 | 0.9106 / 0.9106 / 0.5493 (n=2) | 0.9369 / 0.8538 / 0.4767 (n=34) |
| plan-brief | 0.0958 | 0.8429 / 0.8429 / 0.3509 (n=2) | 0.8599 / 0.8131 / 0.4267 (n=34) |
| plan-look | 0.0798 | 0.8523 / 0.8523 / 0.4120 (n=2) | 0.7543 / 0.6935 / 0.3362 (n=34) |

Attribution (model-based estimate, USD and share):

| Arm | initial | thinking | visible | results | rewrite |
|---|---:|---:|---:|---:|---:|
| control | 2.8612 (8.5%) | 11.8785 (35.3%) | 14.8399 (44.1%) | 4.0967 (12.2%) | 0.0000 (0.0%) |
| plan-brief | 2.8638 (9.3%) | 8.8349 (28.6%) | 14.8444 (48.0%) | 4.3803 (14.2%) | 0.0000 (0.0%) |
| plan-look | 2.8136 (10.3%) | 6.6019 (24.1%) | 13.9501 (51.0%) | 3.9848 (14.6%) | 0.0000 (0.0%) |

Cache:
- control: read share 0.8873, writes by TTL: 5-minute 0, 1-hour 1,591,123, unsplit 0, misses 0 (0 tokens), idle gaps >300 s 1, max idle 371.7 s
- plan-brief: read share 0.8907, writes by TTL: 5-minute 0, 1-hour 1,510,097, unsplit 0, misses 0 (0 tokens), idle gaps >300 s 0, max idle 193.7 s
- plan-look: read share 0.8748, writes by TTL: 5-minute 0, 1-hour 1,386,296, unsplit 0, misses 0 (0 tokens), idle gaps >300 s 0, max idle 179.2 s

### plan-look vs control (36 tasks paired)

| Metric | base sum | new sum | pooled | geo-mean change [95% CI] | mean diff per task [95% CI] | lower / higher / equal | sign p |
|---|---:|---:|---:|---|---|---|---:|
| list_cost_usd | 33.6763 | 27.3504 | -18.78% | -15.49% [-20.80, -9.82] | -0.1757 [-0.2490, -0.1025] | 27 / 9 / 0 | 0.0039 |
| objective_j_usd | 42.4613 | 34.5603 | -18.61% | -14.37% [-20.51, -7.75] | -0.2195 [-0.3124, -0.1265] | 28 / 8 / 0 | 0.0012 |
| total_tokens | 15,041,548 | 11,790,904 | -21.61% | -17.17% [-26.92, -6.11] | -90,296 [-158,277, -22,314] | 23 / 13 / 0 | 0.1325 |
| output_tokens | 921,941 | 715,990 | -22.34% | -16.87% [-22.20, -11.18] | -5,721 [-8,087, -3,354] | 28 / 8 / 0 | 0.0012 |
| thinking_tokens | 404,940 | 226,998 | -43.94% | -39.45% [-47.73, -29.88] | -4,943 [-6,924, -2,961] | 33 / 3 / 0 | 0.0 |
| visible_output_tokens | 517,001 | 488,992 | -5.42% | -3.77% [-7.28, -0.13] | -778 [-1,342, -215] | 24 / 12 / 0 | 0.0652 |
| first_request_thinking_tokens | 12,685 | 236 | -98.14% | n/a (zeros) | -346 [-807, 115] | 25 / 1 / 10 | 0.0 |
| cached_input_tokens | 12,527,754 | 9,687,954 | -22.67% | -17.75% [-29.18, -4.47] | -78,883 [-144,866, -12,901] | 23 / 13 / 0 | 0.1325 |
| cache_creation_input_tokens | 1,591,123 | 1,386,296 | -12.87% | -12.38% [-17.34, -7.13] | -5,690 [-8,320, -3,059] | 26 / 10 / 0 | 0.0113 |
| tool_calls | 445 | 355 | -20.22% | -18.49% [-31.29, -3.31] | -2 [-5, -0] | 21 / 12 / 3 | 0.1628 |
| api_requests | 365 | 332 | -9.04% | -6.72% [-14.92, +2.27] | -1 [-2, 0] | 16 / 12 / 8 | 0.5716 |
| duration_seconds | 8,422.4 | 6,661.9 | -20.90% | -16.41% [-22.16, -10.23] | -48.9 [-69.9, -27.9] | 26 / 7 / 3 | 0.0013 |
| cpu_seconds | 563.5 | 553.9 | -1.70% | -7.30% [-15.27, +1.41] | -0.3 [-2.1, 1.6] | 19 / 17 / 0 | 0.8679 |
| peak_rss_mb | 11,683.2 | 11,261.4 | -3.61% | -1.91% [-4.91, +1.19] | -11.7 [-28.7, 5.2] | 23 / 13 / 0 | 0.1325 |
| quality_score | 3581.87 | 3572.60 | -0.26% | -0.27% [-1.07, +0.54] | -0.26 [-1.03, 0.52] | 4 / 2 / 30 | 0.6875 |

Cost increases (9): architecture 0.4252→0.5362 (+26.1%), rust-tui 0.5223→0.5609 (+7.4%), r-cli 1.0491→1.1247 (+7.2%), rust-cli 0.8762→0.9265 (+5.7%), go-feature 1.4202→1.4933 (+5.1%), ts-lib 0.6094→0.6408 (+5.1%), luau-inventory 0.4380→0.4507 (+2.9%), pr-review 0.3454→0.3511 (+1.7%), pdf-paper-qa 0.4691→0.4715 (+0.5%)

Quality drops (4): ocaml-cli 100.0→97.0, perl-cli 100.0→96.83, php-api 100.0→96.57, rust-debug 100.0→90.0

| Task | cost base → new | change | thinking base → new | first-req thinking | tool calls | quality |
|---|---|---:|---|---|---|---|
| architecture | 0.4252 → 0.5362 | +26.1% | 362 → 431 | 0 → 0 | 8 → 10 | 100.0 → 100.0 |
| banking-transfers | 1.5909 → 1.3618 | -14.4% | 6,240 → 4,933 | 16 → 0 | 28 → 18 | 100.0 → 100.0 |
| banking-web | 1.0665 → 0.7832 | -26.6% | 4,902 → 2,684 | 14 → 0 | 22 → 12 | 100.0 → 100.0 |
| bash-tool | 1.5941 → 1.0159 | -36.3% | 32,135 → 18,883 | 43 → 12 | 18 → 6 | 100.0 → 100.0 |
| c-cli | 1.6481 → 1.1020 | -33.1% | 22,962 → 8,213 | 238 → 12 | 31 → 19 | 100.0 → 100.0 |
| cpp-cli | 0.7068 → 0.5510 | -22.1% | 5,706 → 1,639 | 5,340 → 0 | 17 → 7 | 100.0 → 100.0 |
| cross-module-debug | 0.2171 → 0.1822 | -16.1% | 126 → 112 | 0 → 0 | 7 → 6 | 100.0 → 100.0 |
| csharp-api | 1.3268 → 0.9553 | -28.0% | 18,919 → 10,575 | 17 → 14 | 9 → 15 | 100.0 → 100.0 |
| dart-cli | 0.8607 → 0.6062 | -29.6% | 8,451 → 1,931 | 12 → 0 | 21 → 10 | 100.0 → 100.0 |
| elixir-app | 0.8469 → 0.6137 | -27.5% | 10,654 → 3,467 | 12 → 12 | 10 → 9 | 100.0 → 100.0 |
| fsharp-cli | 1.4152 → 0.8663 | -38.8% | 23,628 → 6,461 | 79 → 12 | 22 → 12 | 100.0 → 100.0 |
| go-api | 0.7704 → 0.7463 | -3.1% | 1,187 → 1,181 | 11 → 0 | 9 → 10 | 100.0 → 100.0 |
| go-feature | 1.4202 → 1.4933 | +5.1% | 10,686 → 8,314 | 16 → 14 | 11 → 24 | 100.0 → 100.0 |
| go-mock-api | 0.7438 → 0.6199 | -16.7% | 8,215 → 3,606 | 12 → 0 | 10 → 9 | 100.0 → 100.0 |
| haskell-cli | 1.2554 → 0.8379 | -33.3% | 22,166 → 12,830 | 14 → 22 | 9 → 5 | 100.0 → 100.0 |
| java-http | 2.0067 → 1.2258 | -38.9% | 40,223 → 15,383 | 68 → 12 | 17 → 19 | 97.01 → 97.01 |
| kotlin-cli | 1.3632 → 1.1294 | -17.2% | 24,898 → 18,522 | 14 → 12 | 15 → 8 | 100.0 → 100.0 |
| lua-cli | 1.2990 → 1.1436 | -12.0% | 22,092 → 17,152 | 14 → 12 | 9 → 17 | 100.0 → 100.0 |
| luau-inventory | 0.4380 → 0.4507 | +2.9% | 1,478 → 1,264 | 0 → 0 | 9 → 6 | 100.0 → 100.0 |
| node-ssg | 0.4724 → 0.4676 | -1.0% | 2,968 → 2,018 | 19 → 0 | 4 → 4 | 100.0 → 100.0 |
| ocaml-cli | 1.0062 → 0.7938 | -21.1% | 18,076 → 10,789 | 42 → 12 | 7 → 7 | 100.0 → 97.0 |
| paper-proofread | 0.4728 → 0.4242 | -10.3% | 3,798 → 2,582 | 0 → 0 | 7 → 6 | 95.53 → 100.0 |
| pdf-paper-qa | 0.4691 → 0.4715 | +0.5% | 129 → 121 | 0 → 0 | 4 → 4 | 100.0 → 100.0 |
| perl-cli | 1.3763 → 0.9614 | -30.2% | 26,591 → 12,883 | 36 → 12 | 16 → 14 | 100.0 → 96.83 |
| php-api | 1.4193 → 1.1385 | -19.8% | 16,112 → 9,835 | 43 → 12 | 27 → 9 | 100.0 → 96.57 |
| pr-review | 0.3454 → 0.3511 | +1.7% | 1,378 → 1,045 | 0 → 0 | 7 → 6 | 98.12 → 98.12 |
| python-cli | 0.8044 → 0.5106 | -36.5% | 8,710 → 2,209 | 12 → 0 | 16 → 3 | 100.0 → 100.0 |
| r-cli | 1.0491 → 1.1247 | +7.2% | 16,657 → 17,695 | 14 → 12 | 6 → 7 | 94.14 → 100.0 |
| refactor | 0.4844 → 0.4686 | -3.3% | 1,662 → 1,101 | 0 → 0 | 10 → 11 | 100.0 → 100.0 |
| rust-cli | 0.8762 → 0.9265 | +5.7% | 2,964 → 2,027 | 13 → 0 | 11 → 13 | 100.0 → 100.0 |
| rust-debug | 0.1989 → 0.1959 | -1.5% | 698 → 423 | 0 → 0 | 6 → 5 | 100.0 → 90.0 |
| rust-tui | 0.5223 → 0.5609 | +7.4% | 2,790 → 2,362 | 12 → 12 | 6 → 8 | 100.0 → 100.0 |
| swift-cli | 0.8372 → 0.6101 | -27.1% | 12,161 → 5,651 | 43 → 12 | 5 → 6 | 100.0 → 100.0 |
| ts-lib | 0.6094 → 0.6408 | +5.1% | 6,610 → 6,117 | 6,385 → 12 | 6 → 5 | 100.0 → 100.0 |
| vite-landing | 0.3330 → 0.3218 | -3.3% | 783 → 940 | 14 → 0 | 8 → 6 | 100.0 → 100.0 |
| zig-cli | 1.4048 → 1.1619 | -17.3% | 17,823 → 11,619 | 132 → 18 | 17 → 19 | 97.07 → 97.07 |

### plan-brief vs control (36 tasks paired)

| Metric | base sum | new sum | pooled | geo-mean change [95% CI] | mean diff per task [95% CI] | lower / higher / equal | sign p |
|---|---:|---:|---:|---|---|---|---:|
| list_cost_usd | 33.6763 | 30.9235 | -8.17% | -7.16% [-12.84, -1.11] | -0.0765 [-0.1467, -0.0062] | 22 / 14 / 0 | 0.243 |
| objective_j_usd | 42.4613 | 39.1337 | -7.84% | -5.51% [-12.58, +2.14] | -0.0924 [-0.1810, -0.0038] | 22 / 14 / 0 | 0.243 |
| total_tokens | 15,041,548 | 14,640,489 | -2.67% | -4.88% [-16.22, +8.01] | -11,141 [-79,081, 56,800] | 21 / 15 / 0 | 0.405 |
| output_tokens | 921,941 | 818,882 | -11.18% | -8.19% [-13.65, -2.39] | -2,863 [-4,955, -771] | 24 / 12 / 0 | 0.0652 |
| thinking_tokens | 404,940 | 300,710 | -25.74% | -24.17% [-32.70, -14.57] | -2,895 [-4,646, -1,145] | 29 / 7 / 0 | 0.0003 |
| visible_output_tokens | 517,001 | 518,172 | +0.23% | +0.76% [-3.38, +5.07] | 33 [-584, 649] | 17 / 19 / 0 | 0.8679 |
| first_request_thinking_tokens | 12,685 | 40,291 | +217.63% | n/a (zeros) | 767 [-219, 1,752] | 6 / 17 / 13 | 0.0347 |
| cached_input_tokens | 12,527,754 | 12,310,788 | -1.73% | -4.47% [-17.58, +10.73] | -6,027 [-71,004, 58,951] | 18 / 18 / 0 | 1.0 |
| cache_creation_input_tokens | 1,591,123 | 1,510,097 | -5.09% | -6.19% [-11.51, -0.54] | -2,251 [-5,276, 775] | 23 / 13 / 0 | 0.1325 |
| tool_calls | 445 | 411 | -7.64% | -7.95% [-22.32, +9.09] | -1 [-3, 1] | 20 / 14 / 2 | 0.3915 |
| api_requests | 365 | 361 | -1.10% | -1.00% [-10.38, +9.37] | -0 [-1, 1] | 14 / 17 / 5 | 0.7201 |
| duration_seconds | 8,422.4 | 7,482.4 | -11.16% | -8.18% [-13.98, -1.99] | -26.1 [-45.2, -7.1] | 23 / 9 / 4 | 0.0201 |
| cpu_seconds | 563.5 | 553.9 | -1.71% | -0.06% [-7.66, +8.15] | -0.3 [-2.0, 1.5] | 17 / 19 / 0 | 0.8679 |
| peak_rss_mb | 11,683.2 | 11,354.8 | -2.81% | -1.25% [-3.67, +1.24] | -9.1 [-24.0, 5.7] | 16 / 20 / 0 | 0.6177 |
| quality_score | 3581.87 | 3563.61 | -0.51% | -0.54% [-1.49, +0.43] | -0.51 [-1.42, 0.41] | 4 / 2 / 30 | 0.6875 |

Cost increases (14): rust-cli 0.8762→1.1105 (+26.7%), go-feature 1.4202→1.7613 (+24.0%), luau-inventory 0.4380→0.5199 (+18.7%), architecture 0.4252→0.5000 (+17.6%), r-cli 1.0491→1.2319 (+17.4%), rust-tui 0.5223→0.5948 (+13.9%), csharp-api 1.3268→1.5060 (+13.5%), rust-debug 0.1989→0.2196 (+10.4%), node-ssg 0.4724→0.5197 (+10.0%), refactor 0.4844→0.5100 (+5.3%), php-api 1.4193→1.4773 (+4.1%), elixir-app 0.8469→0.8721 (+3.0%), banking-transfers 1.5909→1.6377 (+2.9%), swift-cli 0.8372→0.8408 (+0.4%)

Quality drops (4): bash-tool 100.0→92.78, go-mock-api 100.0→97.5, perl-cli 100.0→97.0, rust-debug 100.0→87.0

| Task | cost base → new | change | thinking base → new | first-req thinking | tool calls | quality |
|---|---|---:|---|---|---|---|
| architecture | 0.4252 → 0.5000 | +17.6% | 362 → 190 | 0 → 0 | 8 → 8 | 100.0 → 100.0 |
| banking-transfers | 1.5909 → 1.6377 | +2.9% | 6,240 → 5,780 | 16 → 16 | 28 → 32 | 100.0 → 100.0 |
| banking-web | 1.0665 → 0.8188 | -23.2% | 4,902 → 3,843 | 14 → 16 | 22 → 13 | 100.0 → 100.0 |
| bash-tool | 1.5941 → 1.0386 | -34.8% | 32,135 → 13,496 | 43 → 10,907 | 18 → 16 | 100.0 → 92.78 |
| c-cli | 1.6481 → 1.3905 | -15.6% | 22,962 → 19,657 | 238 → 14 | 31 → 11 | 100.0 → 100.0 |
| cpp-cli | 0.7068 → 0.6897 | -2.4% | 5,706 → 6,076 | 5,340 → 5,653 | 17 → 16 | 100.0 → 100.0 |
| cross-module-debug | 0.2171 → 0.1722 | -20.7% | 126 → 54 | 0 → 0 | 7 → 6 | 100.0 → 100.0 |
| csharp-api | 1.3268 → 1.5060 | +13.5% | 18,919 → 21,540 | 17 → 52 | 9 → 12 | 100.0 → 100.0 |
| dart-cli | 0.8607 → 0.7613 | -11.6% | 8,451 → 7,342 | 12 → 7,092 | 21 → 9 | 100.0 → 100.0 |
| elixir-app | 0.8469 → 0.8721 | +3.0% | 10,654 → 8,958 | 12 → 40 | 10 → 19 | 100.0 → 100.0 |
| fsharp-cli | 1.4152 → 1.2161 | -14.1% | 23,628 → 17,417 | 79 → 17 | 22 → 19 | 100.0 → 100.0 |
| go-api | 0.7704 → 0.7422 | -3.7% | 1,187 → 1,331 | 11 → 16 | 9 → 11 | 100.0 → 100.0 |
| go-feature | 1.4202 → 1.7613 | +24.0% | 10,686 → 8,517 | 16 → 16 | 11 → 16 | 100.0 → 100.0 |
| go-mock-api | 0.7438 → 0.7056 | -5.1% | 8,215 → 6,687 | 12 → 12 | 10 → 5 | 100.0 → 97.5 |
| haskell-cli | 1.2554 → 1.0684 | -14.9% | 22,166 → 13,903 | 14 → 18 | 9 → 12 | 100.0 → 100.0 |
| java-http | 2.0067 → 1.2885 | -35.8% | 40,223 → 18,739 | 68 → 44 | 17 → 18 | 97.01 → 100.0 |
| kotlin-cli | 1.3632 → 1.1812 | -13.4% | 24,898 → 16,697 | 14 → 14 | 15 → 18 | 100.0 → 100.0 |
| lua-cli | 1.2990 → 1.0910 | -16.0% | 22,092 → 18,269 | 14 → 24 | 9 → 5 | 100.0 → 100.0 |
| luau-inventory | 0.4380 → 0.5199 | +18.7% | 1,478 → 2,054 | 0 → 14 | 9 → 5 | 100.0 → 100.0 |
| node-ssg | 0.4724 → 0.5197 | +10.0% | 2,968 → 2,550 | 19 → 19 | 4 → 14 | 100.0 → 100.0 |
| ocaml-cli | 1.0062 → 0.8074 | -19.8% | 18,076 → 12,269 | 42 → 12,016 | 7 → 5 | 100.0 → 100.0 |
| paper-proofread | 0.4728 → 0.3919 | -17.1% | 3,798 → 2,326 | 0 → 0 | 7 → 6 | 95.53 → 100.0 |
| pdf-paper-qa | 0.4691 → 0.4622 | -1.5% | 129 → 115 | 0 → 0 | 4 → 3 | 100.0 → 100.0 |
| perl-cli | 1.3763 → 1.1098 | -19.4% | 26,591 → 17,193 | 36 → 50 | 16 → 10 | 100.0 → 97.0 |
| php-api | 1.4193 → 1.4773 | +4.1% | 16,112 → 18,176 | 43 → 52 | 27 → 26 | 100.0 → 100.0 |
| pr-review | 0.3454 → 0.2984 | -13.6% | 1,378 → 981 | 0 → 0 | 7 → 6 | 98.12 → 98.12 |
| python-cli | 0.8044 → 0.4784 | -40.5% | 8,710 → 2,011 | 12 → 14 | 16 → 4 | 100.0 → 100.0 |
| r-cli | 1.0491 → 1.2319 | +17.4% | 16,657 → 18,532 | 14 → 14 | 6 → 11 | 94.14 → 94.14 |
| refactor | 0.4844 → 0.5100 | +5.3% | 1,662 → 1,072 | 0 → 0 | 10 → 12 | 100.0 → 100.0 |
| rust-cli | 0.8762 → 1.1105 | +26.7% | 2,964 → 2,516 | 13 → 16 | 11 → 17 | 100.0 → 100.0 |
| rust-debug | 0.1989 → 0.2196 | +10.4% | 698 → 467 | 0 → 0 | 6 → 7 | 100.0 → 87.0 |
| rust-tui | 0.5223 → 0.5948 | +13.9% | 2,790 → 3,940 | 12 → 16 | 6 → 6 | 100.0 → 100.0 |
| swift-cli | 0.8372 → 0.8408 | +0.4% | 12,161 → 9,578 | 43 → 21 | 5 → 8 | 100.0 → 100.0 |
| ts-lib | 0.6094 → 0.5367 | -11.9% | 6,610 → 4,227 | 6,385 → 3,860 | 6 → 5 | 100.0 → 100.0 |
| vite-landing | 0.3330 → 0.2939 | -11.7% | 783 → 702 | 14 → 168 | 8 → 6 | 100.0 → 100.0 |
| zig-cli | 1.4048 → 1.0790 | -23.2% | 17,823 → 13,505 | 132 → 80 | 17 → 14 | 97.07 → 97.07 |

### plan-look vs plan-brief (36 tasks paired)

| Metric | base sum | new sum | pooled | geo-mean change [95% CI] | mean diff per task [95% CI] | lower / higher / equal | sign p |
|---|---:|---:|---:|---|---|---|---:|
| list_cost_usd | 30.9235 | 27.3504 | -11.55% | -8.98% [-13.54, -4.17] | -0.0993 [-0.1490, -0.0495] | 25 / 11 / 0 | 0.0288 |
| objective_j_usd | 39.1337 | 34.5603 | -11.69% | -9.38% [-13.96, -4.55] | -0.1270 [-0.1888, -0.0653] | 24 / 12 / 0 | 0.0652 |
| total_tokens | 14,640,489 | 11,790,904 | -19.46% | -12.92% [-22.10, -2.66] | -79,155 [-144,884, -13,426] | 23 / 13 / 0 | 0.1325 |
| output_tokens | 818,882 | 715,990 | -12.56% | -9.45% [-14.03, -4.63] | -2,858 [-4,273, -1,444] | 27 / 9 / 0 | 0.0039 |
| thinking_tokens | 300,710 | 226,998 | -24.51% | -20.16% [-32.35, -5.77] | -2,048 [-3,293, -802] | 25 / 11 / 0 | 0.0288 |
| visible_output_tokens | 518,172 | 488,992 | -5.63% | -4.50% [-7.85, -1.02] | -811 [-1,368, -253] | 22 / 14 / 0 | 0.243 |
| first_request_thinking_tokens | 40,291 | 236 | -99.41% | n/a (zeros) | -1,113 [-2,128, -97] | 28 / 1 / 7 | 0.0 |
| cached_input_tokens | 12,310,788 | 9,687,954 | -21.31% | -13.90% [-24.61, -1.67] | -72,856 [-136,889, -8,824] | 24 / 12 / 0 | 0.0652 |
| cache_creation_input_tokens | 1,510,097 | 1,386,296 | -8.20% | -6.61% [-11.08, -1.91] | -3,439 [-5,653, -1,225] | 24 / 12 / 0 | 0.0652 |
| tool_calls | 411 | 355 | -13.63% | -11.45% [-26.00, +5.96] | -2 [-4, 1] | 17 / 14 / 5 | 0.7201 |
| api_requests | 361 | 332 | -8.03% | -5.78% [-14.23, +3.50] | -1 [-2, 0] | 14 / 9 / 13 | 0.4049 |
| duration_seconds | 7,482.4 | 6,661.9 | -10.97% | -8.96% [-14.58, -2.97] | -22.8 [-37.5, -8.1] | 23 / 8 / 5 | 0.0107 |
| cpu_seconds | 553.9 | 553.9 | +0.00% | -7.24% [-16.22, +2.69] | 0.0 [-1.7, 1.7] | 20 / 16 / 0 | 0.6177 |
| peak_rss_mb | 11,354.8 | 11,261.4 | -0.82% | -0.67% [-2.21, +0.90] | -2.6 [-7.5, 2.3] | 23 / 12 / 1 | 0.0895 |
| quality_score | 3563.61 | 3572.60 | +0.25% | +0.27% [-0.40, +0.95] | 0.25 [-0.40, 0.90] | 4 / 4 / 28 | 1.0 |

Cost increases (11): ts-lib 0.5367→0.6408 (+19.4%), pr-review 0.2984→0.3511 (+17.6%), vite-landing 0.2939→0.3218 (+9.5%), paper-proofread 0.3919→0.4242 (+8.3%), zig-cli 1.0790→1.1619 (+7.7%), architecture 0.5000→0.5362 (+7.2%), python-cli 0.4784→0.5106 (+6.7%), cross-module-debug 0.1722→0.1822 (+5.8%), lua-cli 1.0910→1.1436 (+4.8%), pdf-paper-qa 0.4622→0.4715 (+2.0%), go-api 0.7422→0.7463 (+0.5%)

Quality drops (4): java-http 100.0→97.01, ocaml-cli 100.0→97.0, perl-cli 97.0→96.83, php-api 100.0→96.57

| Task | cost base → new | change | thinking base → new | first-req thinking | tool calls | quality |
|---|---|---:|---|---|---|---|
| architecture | 0.5000 → 0.5362 | +7.2% | 190 → 431 | 0 → 0 | 8 → 10 | 100.0 → 100.0 |
| banking-transfers | 1.6377 → 1.3618 | -16.8% | 5,780 → 4,933 | 16 → 0 | 32 → 18 | 100.0 → 100.0 |
| banking-web | 0.8188 → 0.7832 | -4.4% | 3,843 → 2,684 | 16 → 0 | 13 → 12 | 100.0 → 100.0 |
| bash-tool | 1.0386 → 1.0159 | -2.2% | 13,496 → 18,883 | 10,907 → 12 | 16 → 6 | 92.78 → 100.0 |
| c-cli | 1.3905 → 1.1020 | -20.7% | 19,657 → 8,213 | 14 → 12 | 11 → 19 | 100.0 → 100.0 |
| cpp-cli | 0.6897 → 0.5510 | -20.1% | 6,076 → 1,639 | 5,653 → 0 | 16 → 7 | 100.0 → 100.0 |
| cross-module-debug | 0.1722 → 0.1822 | +5.8% | 54 → 112 | 0 → 0 | 6 → 6 | 100.0 → 100.0 |
| csharp-api | 1.5060 → 0.9553 | -36.6% | 21,540 → 10,575 | 52 → 14 | 12 → 15 | 100.0 → 100.0 |
| dart-cli | 0.7613 → 0.6062 | -20.4% | 7,342 → 1,931 | 7,092 → 0 | 9 → 10 | 100.0 → 100.0 |
| elixir-app | 0.8721 → 0.6137 | -29.6% | 8,958 → 3,467 | 40 → 12 | 19 → 9 | 100.0 → 100.0 |
| fsharp-cli | 1.2161 → 0.8663 | -28.8% | 17,417 → 6,461 | 17 → 12 | 19 → 12 | 100.0 → 100.0 |
| go-api | 0.7422 → 0.7463 | +0.5% | 1,331 → 1,181 | 16 → 0 | 11 → 10 | 100.0 → 100.0 |
| go-feature | 1.7613 → 1.4933 | -15.2% | 8,517 → 8,314 | 16 → 14 | 16 → 24 | 100.0 → 100.0 |
| go-mock-api | 0.7056 → 0.6199 | -12.1% | 6,687 → 3,606 | 12 → 0 | 5 → 9 | 97.5 → 100.0 |
| haskell-cli | 1.0684 → 0.8379 | -21.6% | 13,903 → 12,830 | 18 → 22 | 12 → 5 | 100.0 → 100.0 |
| java-http | 1.2885 → 1.2258 | -4.9% | 18,739 → 15,383 | 44 → 12 | 18 → 19 | 100.0 → 97.01 |
| kotlin-cli | 1.1812 → 1.1294 | -4.4% | 16,697 → 18,522 | 14 → 12 | 18 → 8 | 100.0 → 100.0 |
| lua-cli | 1.0910 → 1.1436 | +4.8% | 18,269 → 17,152 | 24 → 12 | 5 → 17 | 100.0 → 100.0 |
| luau-inventory | 0.5199 → 0.4507 | -13.3% | 2,054 → 1,264 | 14 → 0 | 5 → 6 | 100.0 → 100.0 |
| node-ssg | 0.5197 → 0.4676 | -10.0% | 2,550 → 2,018 | 19 → 0 | 14 → 4 | 100.0 → 100.0 |
| ocaml-cli | 0.8074 → 0.7938 | -1.7% | 12,269 → 10,789 | 12,016 → 12 | 5 → 7 | 100.0 → 97.0 |
| paper-proofread | 0.3919 → 0.4242 | +8.3% | 2,326 → 2,582 | 0 → 0 | 6 → 6 | 100.0 → 100.0 |
| pdf-paper-qa | 0.4622 → 0.4715 | +2.0% | 115 → 121 | 0 → 0 | 3 → 4 | 100.0 → 100.0 |
| perl-cli | 1.1098 → 0.9614 | -13.4% | 17,193 → 12,883 | 50 → 12 | 10 → 14 | 97.0 → 96.83 |
| php-api | 1.4773 → 1.1385 | -22.9% | 18,176 → 9,835 | 52 → 12 | 26 → 9 | 100.0 → 96.57 |
| pr-review | 0.2984 → 0.3511 | +17.6% | 981 → 1,045 | 0 → 0 | 6 → 6 | 98.12 → 98.12 |
| python-cli | 0.4784 → 0.5106 | +6.7% | 2,011 → 2,209 | 14 → 0 | 4 → 3 | 100.0 → 100.0 |
| r-cli | 1.2319 → 1.1247 | -8.7% | 18,532 → 17,695 | 14 → 12 | 11 → 7 | 94.14 → 100.0 |
| refactor | 0.5100 → 0.4686 | -8.1% | 1,072 → 1,101 | 0 → 0 | 12 → 11 | 100.0 → 100.0 |
| rust-cli | 1.1105 → 0.9265 | -16.6% | 2,516 → 2,027 | 16 → 0 | 17 → 13 | 100.0 → 100.0 |
| rust-debug | 0.2196 → 0.1959 | -10.8% | 467 → 423 | 0 → 0 | 7 → 5 | 87.0 → 90.0 |
| rust-tui | 0.5948 → 0.5609 | -5.7% | 3,940 → 2,362 | 16 → 12 | 6 → 8 | 100.0 → 100.0 |
| swift-cli | 0.8408 → 0.6101 | -27.4% | 9,578 → 5,651 | 21 → 12 | 8 → 6 | 100.0 → 100.0 |
| ts-lib | 0.5367 → 0.6408 | +19.4% | 4,227 → 6,117 | 3,860 → 12 | 5 → 5 | 100.0 → 100.0 |
| vite-landing | 0.2939 → 0.3218 | +9.5% | 702 → 940 | 168 → 0 | 6 → 6 | 100.0 → 100.0 |
| zig-cli | 1.0790 → 1.1619 | +7.7% | 13,505 → 11,619 | 80 → 18 | 14 → 19 | 97.07 → 97.07 |

## D. Regressions and trade-offs

1. **Nine tasks cost more with `look`.**
   - `architecture` +26.1% ($0.4252 → $0.5362, tool calls 8 → 10), `rust-tui` +7.4%, `r-cli` +7.2%, `rust-cli` +5.7%, `go-feature` +5.1% (tool calls 11 → 24), `ts-lib` +5.1%, `luau-inventory` +2.9%, `pr-review` +1.7% and `pdf-paper-qa` +0.5%.
   - Together +$0.40, against −$6.73 on the other 27.
   - These tasks had little thinking to cut: control's median on the nine was 2,790 thinking tokens, against 8,333 over all 36 (`architecture` 362, `pdf-paper-qa` 129). There the look-around call is mostly added cost.
   - With one run per task, some of these differences are within run-to-run noise, and this A/B cannot tell which (E5).
2. **Quality: 4 tasks lower, 2 higher, 30 equal** (mean −0.26 points, 95% CI −1.03 to +0.52, sign p = 0.69). Hidden tests passed: 1215/1219 in both arms. The drops, one run each:
   - `rust-debug` 100 → 90: the original test `cli_reports::corrupt_cache_is_rebuilt` failed. It fails in 14 of the 17 runs of this task recorded so far, both native runs included.
   - `ocaml-cli` 100 → 97: the architecture check `single_codec_module`, which native also failed.
   - `perl-cli` 100 → 96.83: hidden test `cli_file_format_and_io` failed (30/31).
   - `php-api` 100 → 96.57: hidden test `holds_validation` failed (30/31). None of the 5 other recorded runs of this task failed it, so this one may be real; check it in a second repetition.
   - Gains: `paper-proofread` 95.53 → 100 and `r-cli` 94.14 → 100.
3. **brief** (the ablation, not shipped):
   - 14 tasks cost more, up to +26.7%.
   - First-request thinking rose on 17 of 23 tasks.
   - Quality −0.51 [−1.42, +0.41], hidden tests 1214/1219.
4. **The line's own cost:**
   - +106 input tokens on the first request (median; 97–112), about $0.001 per run, included in every figure.
   - First-request cost still fell (mean $0.0666 → $0.0606), because that request carries less thinking.
   - Its share of the run's cost rose from 7.1% to 8.0% because the rest of the run got cheaper.
5. **The cost moved as well as shrank.** With less thinking, visible output is now 51.0% of cost and tool results 14.6% (from 44.1% and 12.2%). These are the next bottlenecks (E1).
6. **Cold starts:**
   - 2 runs per arm: $0.9106 (control) vs $0.8523 (look). That is too few to compare.
   - Warm runs: $0.9369 → $0.7543 (n = 34).
7. **Requests:** −9.0% pooled, sign p = 0.57, not significant.
8. **Scope:** the default covers main sessions only. Any gain in subagents is left unclaimed until it is measured.
9. **A corrected claim:** 0.8.0 said Token Forge was cheaper on 36 of 36 tasks, but that counted tokens. At list prices it cost less on 34 of 36 (median −22%). README and CHANGELOG now say so.

## E. Remaining opportunities

1. **Visible output: 51.0% of `look`'s cost.** It is mostly tool-call input, that is, the files a task writes and the commands it runs: the deliverable. No reduction has been found that would not risk completeness (audit, section 5).
2. **5-minute cache writes: 1-hour writes are 40.5% of `look`'s cost.** Re-priced on the A/B (a model on provider-reported tokens; no expiry happened):

   | Arm | 1-hour write tokens | Saving if all were 5-minute | Cost of one expiry mid-session ÷ the run's whole saving, per run: median (min–max) | Same, expiry before the last request |
   |---|---:|---|---|---|
   | control | 1,591,123 | $4.77 (14.2% of $33.68) | 1.42 (0.31–1.78) | 1.76 (1.52–2.16) |
   | look | 1,386,296 | $4.16 (15.2% of $27.35) | 1.26 (0.31–1.65) | 1.79 (1.53–2.14) |

   - One pause over 5 minutes per run would cost the suite $6.13 (control) or $5.12 (look) mid-session, against savings of $4.77 or $4.16. In the median run, one such pause costs more than the whole saving.
   - The headless bench had one such pause (control, 371.7 s); interactive sessions have many.
   - `FORCE_PROMPT_CACHING_5M=1` works. Smoke run `bench/runs/2026-10-09T17-44-51-905b`: 6,113 write tokens, all 5-minute; list cost $0.058037 against Claude Code's $0.0580368; quality 96.0.
   - `CLAUDE_CODE_PROMPT_CACHE_TTL=5m` was not run, because the bench's preflight validator refuses it.
   - This is a candidate for headless automation with no human pauses only, set by the user and not by the plugin.
3. **The tasks where `look` costs more** (D1) are low-thinking tasks. A conditional line would need its own A/B, and per-category effects are not established with one run per task.
4. **Unmeasured settings:**
   - Subagents: run an A/B with `TFORGE_PLAN=look` before making it their default.
   - Large repositories: the line's first call lists the repo, and the bench repos are small.
   - Compaction and resume: the session-start context, line included, is sent again.
   - API-key sessions with 5-minute TTLs.
5. **Statistics:**
   - One run per task and arm; a second repetition would settle D1 and D2 per task.
   - The CLI is not pinned: from 2.1.293 to 2.1.295 control's up-front thinking changed.
   - Native was not re-run on 2.1.295.
6. **Bench tooling hazards** (pre-existing, not changed here):
   - `report.build` keeps only runs that match `environments/token-forge/manifest.json` (CLI version, plugin build or `equivalent_builds`, no variant, same lean). The manifests now say 2.1.295 / `c9de32debeea`, so `bench.py report` and `bench.py run` would rebuild `benchmark-report.*` from the A/B control arm alone and drop the 2.1.293 baseline. Fix: select runs by session, or keep one report per environment build.
   - `report.py` `sign_test` returns `round(min(1.0, 2 * p), 4)`, so any p below 0.00005 prints as "0.0". The baseline's "2 of 36, p = 0.0" is p ≈ 1.9 × 10⁻⁸. It is not fixed because regenerating the tracked reports would drop the baseline (above).

## F. Recommendation

| Change | Decision | Basis |
|---|---|---|
| `TFORGE_PLAN=look`, main sessions | **Default** | List cost −15.5% [−20.8, −9.8], lower on 27 of 36 tasks; thinking −44%; wall-clock −21%; quality within resolution, hidden tests unchanged. Off: `TFORGE_PLAN=0` |
| Planning line in subagents | Conditional: opt-in through `TFORGE_PLAN` | Not measured. Run a subagent A/B before making it their default |
| `TFORGE_PLAN=brief` | Conditional: opt-in, dominated by `look` | −7.2% vs no line, but +13% list cost vs `look` (pooled) and more up-front thinking |
| Measurement pipeline (B1) | Keep | No runtime effect. It makes cost, TTL and thinking measurable, and reconciles them with Claude Code's own cost |
| 5-minute cache writes (`FORCE_PROMPT_CACHING_5M=1`) | Conditional: headless runs with no pause over 5 minutes, set by the user; not a plugin default | Modelled −14% to −15%, but one pause costs 1.3–1.4× the run's whole saving |
| Reverted | Nothing | No change regressed cost or quality beyond noise |

Before claiming per-category effects (such as `look` costing more on low-thinking tasks) or turning the line on for subagents, run a second repetition of this A/B and a subagent A/B.
