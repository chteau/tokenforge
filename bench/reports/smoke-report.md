# Token Forge vs clean Claude Code — benchmark report

Model `claude-opus-5-5`, Claude Code 2.1.293, Token Forge 0.6.0, benchmark 1.0.0. Sessions: 2026-10-07T19-40-17-smoke.

## Executive summary

Across 1 paired tasks (2 executed runs, 0 not executed):

- Total-token savings per task: median **-117.81%**, mean -117.81% (min -117.81%, max -117.81%). Pooled over all tasks: -117.81%.
- Input-token savings (median): -118.83%; output-token savings (median): -53.85%; uncached input (median): -29.73%.
- Price-weighted (input-equivalent) savings (median): -61.01%; reported cost savings (median): -45.18%.
- Task completion: Native 1.0, Token Forge 1.0.
- Mean quality: Native 96.0, Token Forge 96.0; median per-task quality difference (TF − native): 0.0.
- Tasks where Token Forge was cheaper / costlier: 0 / 1 (sign test p = 1.0).
- Fixed context added by Token Forge on the first request (median, measured): 1,000 tokens.

Positive savings mean Token Forge used fewer tokens; negative means it used more. `total tokens` = input + cache writes + cache reads + output, summed over the main session, subagents and nested `claude -p` sessions.

## Per-task comparison (median over repetitions)

| Task | Agent | Runs | Total tokens | Input | Output | Uncached in | Cost $ | Tool calls | Files read | Tests | Quality | Status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|
| smoke | Native | 1 | 51,673 | 50,867 | 806 | 7,369 | 0.08 | 2 | 2 | PASS | 96.0 | completed |
| smoke | Token Forge | 1 | 112,551 | 111,311 | 1,240 | 9,560 | 0.12 | 5 | 4 | PASS | 96.0 | completed |

| Task | Token diff | Savings % | Input % | Output % | Uncached % | Cost % | Quality Δ | Tool calls % | Files read % | Lines read % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| smoke | -60,878 | -117.8 | -118.8 | -53.9 | -29.7 | -45.2 | 0.0 | -150.0 | -100.0 | -53.1 |

## Quality-adjusted efficiency

| Task | Native tokens/quality pt | TF tokens/quality pt | Native quality/Mtok | TF quality/Mtok |
|---|---:|---:|---:|---:|
| smoke | 538 | 1,172 | 1,857.84 | 852.95 |

## Distribution statistics (all executed runs)

**Native** (1 runs)

| Metric | mean | median | min | max | stdev |
|---|---:|---:|---:|---:|---:|
| total_tokens | 51,673 | 51,673 | 51,673 | 51,673 | n/a |
| input_tokens | 50,867 | 50,867 | 50,867 | 50,867 | n/a |
| output_tokens | 806 | 806 | 806 | 806 | n/a |
| cached_input_tokens | 43,498 | 43,498 | 43,498 | 43,498 | n/a |
| uncached_input_tokens | 7,369 | 7,369 | 7,369 | 7,369 | n/a |
| input_equivalent_tokens | 17,590 | 17,590 | 17,590 | 17,590 | n/a |
| total_cost_usd_reported | 0.08 | 0.08 | 0.08 | 0.08 | n/a |
| tool_calls | 2.00 | 2.00 | 2.00 | 2.00 | n/a |
| duration_seconds | 10.00 | 10.00 | 10.00 | 10.00 | n/a |
| quality_score | 96.00 | 96.00 | 96.00 | 96.00 | n/a |

**Token Forge** (1 runs)

| Metric | mean | median | min | max | stdev |
|---|---:|---:|---:|---:|---:|
| total_tokens | 112,551 | 112,551 | 112,551 | 112,551 | n/a |
| input_tokens | 111,311 | 111,311 | 111,311 | 111,311 | n/a |
| output_tokens | 1,240 | 1,240 | 1,240 | 1,240 | n/a |
| cached_input_tokens | 101,751 | 101,751 | 101,751 | 101,751 | n/a |
| uncached_input_tokens | 9,560 | 9,560 | 9,560 | 9,560 | n/a |
| input_equivalent_tokens | 28,322 | 28,322 | 28,322 | 28,322 | n/a |
| total_cost_usd_reported | 0.12 | 0.12 | 0.12 | 0.12 | n/a |
| tool_calls | 5.00 | 5.00 | 5.00 | 5.00 | n/a |
| duration_seconds | 20.00 | 20.00 | 20.00 | 20.00 | n/a |
| quality_score | 96.00 | 96.00 | 96.00 | 96.00 | n/a |

Per-task token savings %: mean -117.81, median -117.81, p10 -117.81, p25 -117.81, p75 -117.81, p90 -117.81

## Per-category results

| Category | Tasks | Median savings % | Median quality Δ | Verdict |
|---|---|---:|---:|---|
| debugging | smoke | -117.8 | 0.0 | worse (all tasks costlier by >5%) |

## Why: tool and context traces (medians)

| Task | Agent | API requests | First-request context | Lines read | Tool-result bytes | Redundant reads | Context precision≈ | Subagents | Nested-session tokens |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| smoke | Native | 3 | 16,350 | 32 | 1,656 | 0 | 0.50 | 0 | 0 |
| smoke | Token Forge | 6 | 17,350 | 49 | 2,480 | 2 | 0.50 | 0 | 0 |

Context precision is approximate: the share of files read that match the task's `relevant_files` globs. Files read via `cat`/`sed`/`head` in Bash are detected heuristically.

## Validation

- contaminated or invalid runs: none
- isolation problems: none
- missing telemetry: none
- repo commit mismatch: none
- prompt hash mismatch: none
- missing evaluation: none

## Statistical conclusion

_Filled in from the numbers above after the full run; see `ANALYSIS` section if present._

