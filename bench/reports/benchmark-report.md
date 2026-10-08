# Token Forge vs clean Claude Code — benchmark report

Model `claude-opus-5-5`, Claude Code 2.1.293, benchmark 1.0.0. Token Forge build under test: 0.7.0 (plugin sha256 `b9471cc0bd41`, git b8291147 + uncommitted changes), lean: balanced. Sessions: 2026-10-08T00-48-18-9a48.

## Executive summary

No paired measurements yet.

Positive savings mean Token Forge used fewer tokens; negative means it used more. `total tokens` = input + cache writes + cache reads + output, summed over the main session, subagents and nested `claude -p` sessions.

## Per-task comparison (median over repetitions)

| Task | Agent | Runs | Total tokens | Input | Output | Uncached in | Cost $ | Tool calls | Files read | Tests | Quality | Status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|
| cross-module-debug | Native | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |  | n/a |  |
| cross-module-debug | Token Forge | 1 | 92,003 | 90,292 | 1,711 | 13,948 | 0.16 | 5 | 8 | PASS | 100.0 | completed |

| Task | Token diff | Savings % | Input % | Output % | Uncached % | Cost % | Quality Δ | Tool calls % | Files read % | Lines read % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|

## Quality-adjusted efficiency

| Task | Native tokens/quality pt | TF tokens/quality pt | Native quality/Mtok | TF quality/Mtok |
|---|---:|---:|---:|---:|
| cross-module-debug | n/a | 920 | n/a | 1,086.92 |

## Distribution statistics (all executed runs)

**Native** (0 runs)

| Metric | mean | median | min | max | stdev |
|---|---:|---:|---:|---:|---:|

**Token Forge** (1 runs)

| Metric | mean | median | min | max | stdev |
|---|---:|---:|---:|---:|---:|
| total_tokens | 92,003 | 92,003 | 92,003 | 92,003 | n/a |
| input_tokens | 90,292 | 90,292 | 90,292 | 90,292 | n/a |
| output_tokens | 1,711 | 1,711 | 1,711 | 1,711 | n/a |
| cached_input_tokens | 76,344 | 76,344 | 76,344 | 76,344 | n/a |
| uncached_input_tokens | 13,948 | 13,948 | 13,948 | 13,948 | n/a |
| input_equivalent_tokens | 33,621 | 33,621 | 33,621 | 33,621 | n/a |
| total_cost_usd_reported | 0.16 | 0.16 | 0.16 | 0.16 | n/a |
| tool_calls | 5.00 | 5.00 | 5.00 | 5.00 | n/a |
| duration_seconds | 25.00 | 25.00 | 25.00 | 25.00 | n/a |
| quality_score | 100.00 | 100.00 | 100.00 | 100.00 | n/a |

## Per-category results

| Category | Tasks | Median savings % | Median quality Δ | Verdict |
|---|---|---:|---:|---|

## Why: tool and context traces (medians)

| Task | Agent | API requests | First-request context | Lines read | Tool-result bytes | Redundant reads | Context precision≈ | Subagents | Nested-session tokens |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| cross-module-debug | Native | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| cross-module-debug | Token Forge | 6 | 10,192 | 416 | 18,120 | 2 | 0.62 | 0 | 0 |

Context precision is approximate: the share of files read that match the task's `relevant_files` globs. Files read via `cat`/`sed`/`head` in Bash are detected heuristically.

## Validation

- contaminated or invalid runs: none
- isolation problems: none
- missing telemetry: none
- repo commit mismatch: none
- prompt hash mismatch: none
- missing evaluation: none
- api models: {'claude-opus-5-5': 1}
- runs with other models: none

## Statistical conclusion

_Filled in from the numbers above after the full run; see `ANALYSIS` section if present._

