# Token Forge vs clean Claude Code — benchmark report

Model `claude-opus-5-5`, Claude Code 2.1.293, benchmark 1.0.0. Token Forge build under test: 0.7.0 (plugin sha256 `b9471cc0bd41`, git b8291147 + uncommitted changes), lean: balanced. Sessions: 2026-10-07T19-41-25, 2026-10-07T20-13-39, 2026-10-07T20-13-41, 2026-10-07T20-16-40, 2026-10-07T20-16-41, 2026-10-07T20-17-24-430e, 2026-10-07T20-18-37-ce9c, 2026-10-07T20-19-13-2892, 2026-10-07T20-26-02-42ac, 2026-10-07T20-26-02-f867, 2026-10-07T20-33-25-3199, 2026-10-07T20-33-27-ee90, 2026-10-07T20-33-29-9703, 2026-10-07T20-59-11-da5c, 2026-10-07T20-59-13-2130, 2026-10-07T20-59-15-350f, 2026-10-07T20-59-17-cb92, 2026-10-07T21-07-19-ca3f, 2026-10-07T21-07-21-fb68, 2026-10-07T21-07-23-68db, 2026-10-07T21-07-25-6c4d, 2026-10-07T21-15-36-73cd, 2026-10-07T21-15-38-f177, 2026-10-07T21-15-40-3833, 2026-10-07T21-24-08-26af, 2026-10-07T21-24-10-5ef0, 2026-10-07T21-24-12-c8d1, 2026-10-07T21-24-14-edda, 2026-10-07T21-40-26-254b, 2026-10-07T22-32-42-d4b4, 2026-10-07T22-32-44-b302, 2026-10-07T22-32-46-3e00, 2026-10-07T22-32-48-c5cf, 2026-10-07T22-35-24-2c1e, 2026-10-07T22-35-26-3a5b, 2026-10-07T22-35-28-f515, 2026-10-07T22-41-48-3d89, 2026-10-07T22-41-50-0542, 2026-10-07T22-41-52-7547, 2026-10-07T22-41-54-61af, 2026-10-07T22-44-35-2a28, 2026-10-07T22-44-37-793a, 2026-10-07T22-44-39-8371, 2026-10-07T23-01-20-e76f, 2026-10-07T23-01-22-f6f9, 2026-10-07T23-01-24-3d32, 2026-10-07T23-01-26-0904, 2026-10-07T23-04-43-367e, 2026-10-07T23-04-45-d333, 2026-10-07T23-04-47-0ea2, 2026-10-07T23-04-49-1bb9, 2026-10-07T23-07-05-afac, 2026-10-07T23-07-07-e0bd, 2026-10-07T23-07-09-eb8d, 2026-10-07T23-31-03-4e66, 2026-10-07T23-33-39-c144, 2026-10-07T23-40-06-3ea4, 2026-10-07T23-40-08-e5da, 2026-10-07T23-40-10-4155, 2026-10-07T23-40-12-f216, 2026-10-07T23-42-53-a049, 2026-10-07T23-42-55-e92b, 2026-10-07T23-42-57-c96c, 2026-10-08T00-03-41-a56b, 2026-10-08T00-03-44-5342, 2026-10-08T00-03-47-1b36, 2026-10-08T00-04-37-1949, 2026-10-08T00-05-37-d020, 2026-10-08T00-05-57-bd4d, 2026-10-08T00-09-27-d43c, 2026-10-08T00-09-31-40e7, 2026-10-08T00-09-31-d21e, 2026-10-08T00-11-47-a969, 2026-10-08T00-13-44-6dc5, 2026-10-08T00-13-44-d080, 2026-10-08T00-15-18-8a10, 2026-10-08T00-16-06-06f4, 2026-10-08T00-16-06-3cde, 2026-10-08T00-19-46-206f, 2026-10-08T00-19-46-269f, 2026-10-08T00-23-48-3e07, 2026-10-08T00-23-48-d45a, 2026-10-08T00-26-11-0b27, 2026-10-08T00-26-11-2aa9, 2026-10-08T00-29-11-3979, 2026-10-08T00-29-11-ff4d, 2026-10-08T00-32-10-b0b1, 2026-10-08T00-32-10-dc6e, 2026-10-08T00-38-48-0f38, 2026-10-08T00-38-48-2f63, 2026-10-08T00-48-18-3963, 2026-10-08T00-48-18-6753, 2026-10-08T00-48-18-9a48, 2026-10-08T00-48-18-a76d, 2026-10-08T00-48-44-cbfc, 2026-10-08T00-48-47-de2d, 2026-10-08T00-50-00-ce45, 2026-10-08T00-50-45-7217, 2026-10-08T00-50-49-31ae, 2026-10-08T00-52-02-87d9, 2026-10-08T00-52-24-6cfa, 2026-10-08T00-52-45-cb7a, 2026-10-08T00-52-57-a1c8, 2026-10-08T00-53-15-7951, 2026-10-08T00-54-06-cfab, 2026-10-08T00-54-15-8b3c, 2026-10-08T00-55-23-90f0, 2026-10-08T00-56-06-7094, 2026-10-08T00-57-07-7e40, 2026-10-08T00-59-08-a869.

Excluded: 98 Token Forge runs of other plugin builds (listed in the JSON report).

## Executive summary

Across 19 paired tasks (45 executed runs, 0 not executed):

- Total-token savings per task: median **52.42%**, mean 52.03% (min 10.16%, max 75.41%). Pooled over all tasks: 53.3%.
- Input-token savings (median): 54.05%; output-token savings (median): 29.52%; uncached input (median): 26.9%.
- Price-weighted (input-equivalent) savings (median): 32.58%; reported cost savings (median): 29.73%.
- Task completion: Native 0.917, Token Forge 1.0.
- Mean quality: Native 98.8, Token Forge 99.71; median per-task quality difference (TF − native): 0.0.
- Tasks where Token Forge was cheaper / costlier: 19 / 0 (sign test p = 0.0).
- Fixed context added by Token Forge on the first request (median, measured): -6,735 tokens.

Positive savings mean Token Forge used fewer tokens; negative means it used more. `total tokens` = input + cache writes + cache reads + output, summed over the main session, subagents and nested `claude -p` sessions.

## Per-task comparison (median over repetitions)

| Task | Agent | Runs | Total tokens | Input | Output | Uncached in | Cost $ | Tool calls | Files read | Tests | Quality | Status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|
| architecture | Native | 1 | 386,198 | 379,534 | 6,664 | 46,347 | 0.57 | 11 | 45 | n/a | 100.0 | completed |
| architecture | Token Forge | 1 | 346,949 | 340,890 | 6,059 | 39,379 | 0.50 | 10 | 29 | n/a | 100.0 | completed |
| banking-transfers | Native | 1 | 2,428,089 | 2,392,370 | 35,719 | 104,378 | 2.01 | 32 | 44 | PASS | 100.0 | completed |
| banking-transfers | Token Forge | 1 | 1,616,842 | 1,582,356 | 34,486 | 87,227 | 1.69 | 25 | 38 | PASS | 94.0 | completed |
| banking-web | Native | 1 | 1,563,130 | 1,538,971 | 24,159 | 77,885 | 1.40 | 25 | 33 | PASS | 100.0 | completed |
| banking-web | Token Forge | 1 | 636,624 | 622,642 | 13,982 | 51,008 | 0.80 | 15 | 28 | PASS | 100.0 | completed |
| cpp-cli | Native | 1 | 303,222 | 279,259 | 23,963 | 32,719 | 0.79 | 8 | 3 | PASS | 100.0 | completed |
| cpp-cli | Token Forge | 2 | 156,887 | 140,091 | 16,796 | 23,459 | 0.55 | 6 | 1 | PASS,PASS | 100.0 | completed,completed |
| cross-module-debug | Native | 1 | 265,193 | 262,113 | 3,080 | 22,343 | 0.29 | 10 | 8 | PASS | 100.0 | completed |
| cross-module-debug | Token Forge | 1 | 92,003 | 90,292 | 1,711 | 13,948 | 0.16 | 5 | 8 | PASS | 100.0 | completed |
| csharp-api | Native | 1 | 1,221,429 | 1,169,487 | 51,942 | 67,486 | 1.80 | 21 | 4 | PASS | 100.0 | completed |
| csharp-api | Token Forge | 2 | 334,977 | 293,290 | 41,686 | 52,118 | 1.30 | 6 | 4 | PASS,PASS | 100.0 | completed,completed |
| go-api | Native | 3 | 684,322 | 670,408 | 17,301 | 65,689 | 0.97 | 12 | 23 | PASS,PASS,PASS | 100.0 | completed,completed,completed |
| go-api | Token Forge | 1 | 343,071 | 330,878 | 12,193 | 50,527 | 0.70 | 9 | 21 | PASS | 100.0 | completed |
| go-feature | Native | 1 | 1,936,463 | 1,892,409 | 44,054 | 109,554 | 2.11 | 25 | 37 | PASS | 100.0 | completed |
| go-feature | Token Forge | 1 | 732,932 | 701,592 | 31,340 | 76,445 | 1.36 | 13 | 28 | PASS | 100.0 | completed |
| go-mock-api | Native | 1 | 556,307 | 532,897 | 23,410 | 37,629 | 0.87 | 16 | 6 | n/a | 97.5 | completed |
| go-mock-api | Token Forge | 1 | 144,227 | 129,920 | 14,307 | 22,251 | 0.49 | 5 | 4 | n/a | 100.0 | completed |
| luau-inventory | Native | 1 | 244,867 | 226,683 | 18,184 | 27,666 | 0.62 | 7 | 3 | PASS | 100.0 | completed |
| luau-inventory | Token Forge | 1 | 84,211 | 72,362 | 11,849 | 19,635 | 0.40 | 3 | 3 | PASS | 100.0 | completed |
| memory-followup | Native | 2 | 412,780 | 404,498 | 8,282 | 38,535 | 0.55 | 10 | 10 | PASS,PASS | 100.0 | completed,completed |
| memory-followup | Token Forge | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |  | n/a |  |
| node-ssg | Native | 1 | 434,424 | 411,648 | 22,776 | 37,675 | 0.83 | 19 | 2 | PASS | 100.0 | completed |
| node-ssg | Token Forge | 1 | 206,693 | 189,139 | 17,554 | 27,541 | 0.60 | 6 | 1 | PASS | 100.0 | completed |
| pr-review | Native | 1 | 180,606 | 175,659 | 4,947 | 28,905 | 0.36 | 5 | 4 | n/a | 96.7 | completed |
| pr-review | Token Forge | 1 | 110,808 | 107,046 | 3,762 | 26,046 | 0.30 | 4 | 5 | n/a | 100.0 | completed |
| python-cli | Native | 1 | 385,596 | 362,564 | 23,032 | 33,700 | 0.80 | 10 | 4 | PASS | 100.0 | completed |
| python-cli | Token Forge | 1 | 190,531 | 170,436 | 20,095 | 28,089 | 0.66 | 6 | 3 | PASS | 100.0 | completed |
| refactor | Native | 1 | 413,253 | 402,678 | 10,575 | 44,303 | 0.64 | 10 | 18 | PASS | 100.0 | completed |
| refactor | Token Forge | 1 | 347,755 | 340,494 | 7,261 | 36,804 | 0.50 | 11 | 19 | PASS | 100.0 | completed |
| rust-cli | Native | 1 | 1,444,788 | 1,424,273 | 20,515 | 103,915 | 1.51 | 19 | 9 | PASS | 100.0 | completed |
| rust-cli | Token Forge | 1 | 603,940 | 589,335 | 14,605 | 63,921 | 0.91 | 13 | 23 | PASS | 100.0 | completed |
| rust-debug | Native | 2 | 202,106 | 197,546 | 4,559 | 20,260 | 0.29 | 7 | 8 | FAIL,FAIL | 88.5 | completed,completed |
| rust-debug | Token Forge | 1 | 114,905 | 111,475 | 3,430 | 14,996 | 0.21 | 6 | 7 | PASS | 100.0 | completed |
| rust-tui | Native | 1 | 802,204 | 769,894 | 32,310 | 46,683 | 1.16 | 22 | 8 | PASS | 100.0 | completed |
| rust-tui | Token Forge | 1 | 251,173 | 233,853 | 17,320 | 26,734 | 0.60 | 9 | 9 | PASS | 100.0 | completed |
| ts-lib | Native | 1 | 283,542 | 262,038 | 21,504 | 31,579 | 0.73 | 7 | 4 | PASS | 100.0 | completed |
| ts-lib | Token Forge | 1 | 156,168 | 141,118 | 15,050 | 23,449 | 0.51 | 5 | 2 | PASS | 100.0 | completed |
| vite-landing | Native | 1 | 253,105 | 242,069 | 11,036 | 20,454 | 0.43 | 9 | 6 | PASS | 100.0 | completed |
| vite-landing | Token Forge | 1 | 62,243 | 55,503 | 6,740 | 13,146 | 0.25 | 3 | 2 | PASS | 100.0 | completed |

| Task | Token diff | Savings % | Input % | Output % | Uncached % | Cost % | Quality Δ | Tool calls % | Files read % | Lines read % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| architecture | 39,249 | 10.2 | 10.2 | 9.1 | 15.0 | 13.0 | 0.0 | 9.1 | 35.6 | 26.8 |
| banking-transfers | 811,247 | 33.4 | 33.9 | 3.5 | 16.4 | 16.0 | -6.0 | 21.9 | 13.6 | 24.2 |
| banking-web | 926,506 | 59.3 | 59.5 | 42.1 | 34.5 | 42.6 | 0.0 | 40.0 | 15.2 | 32.7 |
| cpp-cli | 146,335 | 48.3 | 49.8 | 29.9 | 28.3 | 30.8 | 0.0 | 31.2 | 66.7 | 100.0 |
| cross-module-debug | 173,190 | 65.3 | 65.5 | 44.5 | 37.6 | 44.1 | 0.0 | 50.0 | 0.0 | 44.2 |
| csharp-api | 886,452 | 72.6 | 74.9 | 19.7 | 22.8 | 27.8 | 0.0 | 69.0 | 12.5 | -29.2 |
| go-api | 341,251 | 49.9 | 50.6 | 29.5 | 23.1 | 27.1 | 0.0 | 25.0 | 8.7 | 27.8 |
| go-feature | 1,203,531 | 62.1 | 62.9 | 28.9 | 30.2 | 35.5 | 0.0 | 48.0 | 24.3 | 29.9 |
| go-mock-api | 412,080 | 74.1 | 75.6 | 38.9 | 40.9 | 44.1 | 2.5 | 68.8 | 33.3 | 82.6 |
| luau-inventory | 160,656 | 65.6 | 68.1 | 34.8 | 29.0 | 35.2 | 0.0 | 57.1 | 0.0 | 4.0 |
| node-ssg | 227,731 | 52.4 | 54.0 | 22.9 | 26.9 | 27.4 | 0.0 | 68.4 | 50.0 | 75.0 |
| pr-review | 69,798 | 38.6 | 39.1 | 23.9 | 9.9 | 16.6 | 3.3 | 20.0 | -25.0 | -6.2 |
| python-cli | 195,065 | 50.6 | 53.0 | 12.8 | 16.6 | 17.7 | 0.0 | 40.0 | 25.0 | -145.4 |
| refactor | 65,498 | 15.8 | 15.4 | 31.3 | 16.9 | 21.5 | 0.0 | -10.0 | -5.6 | -1.8 |
| rust-cli | 840,848 | 58.2 | 58.6 | 28.8 | 38.5 | 39.7 | 0.0 | 31.6 | -155.6 | 18.2 |
| rust-debug | 87,200 | 43.1 | 43.6 | 24.8 | 26.0 | 28.0 | 11.5 | 14.3 | 17.6 | 1.0 |
| rust-tui | 551,031 | 68.7 | 69.6 | 46.4 | 42.7 | 48.3 | 0.0 | 59.1 | -12.5 | 12.5 |
| ts-lib | 127,374 | 44.9 | 46.1 | 30.0 | 25.7 | 29.7 | 0.0 | 28.6 | 50.0 | 33.3 |
| vite-landing | 190,862 | 75.4 | 77.1 | 38.9 | 35.7 | 42.0 | 0.0 | 66.7 | 66.7 | 71.4 |

## Quality-adjusted efficiency

| Task | Native tokens/quality pt | TF tokens/quality pt | Native quality/Mtok | TF quality/Mtok |
|---|---:|---:|---:|---:|
| architecture | 3,862 | 3,470 | 258.93 | 288.23 |
| banking-transfers | 24,281 | 17,200 | 41.18 | 58.14 |
| banking-web | 15,631 | 6,366 | 63.97 | 157.08 |
| cpp-cli | 3,032 | 1,569 | 329.79 | 637.40 |
| cross-module-debug | 2,652 | 920 | 377.08 | 1,086.92 |
| csharp-api | 12,214 | 3,350 | 81.87 | 298.53 |
| go-api | 6,843 | 3,431 | 146.13 | 291.48 |
| go-feature | 19,365 | 7,329 | 51.64 | 136.44 |
| go-mock-api | 5,706 | 1,442 | 175.26 | 693.35 |
| luau-inventory | 2,449 | 842 | 408.38 | 1,187.49 |
| memory-followup | 4,128 | n/a | 242.26 | n/a |
| node-ssg | 4,344 | 2,067 | 230.19 | 483.81 |
| pr-review | 1,868 | 1,108 | 535.25 | 902.46 |
| python-cli | 3,856 | 1,905 | 259.34 | 524.85 |
| refactor | 4,132 | 3,478 | 241.98 | 287.56 |
| rust-cli | 14,448 | 6,039 | 69.21 | 165.58 |
| rust-debug | 2,284 | 1,149 | 437.89 | 870.28 |
| rust-tui | 8,022 | 2,512 | 124.66 | 398.13 |
| ts-lib | 2,835 | 1,562 | 352.68 | 640.34 |
| vite-landing | 2,531 | 622 | 395.09 | 1,606.61 |

## Distribution statistics (all executed runs)

**Native** (24 runs)

| Metric | mean | median | min | max | stdev |
|---|---:|---:|---:|---:|---:|
| total_tokens | 680,342 | 423,838.50 | 180,606 | 2,428,089 | 602,538.84 |
| input_tokens | 661,501.25 | 407,163.00 | 175,659 | 2,392,370 | 593,706.27 |
| output_tokens | 18,840.75 | 17,798.00 | 3,080 | 51,942 | 12,677.05 |
| cached_input_tokens | 612,026.08 | 366,174.00 | 146,754 | 2,287,992 | 568,595.27 |
| uncached_input_tokens | 49,475.17 | 38,576.00 | 20,090 | 109,554 | 27,262.33 |
| input_equivalent_tokens | 217,243.71 | 187,764.50 | 63,936 | 537,852 | 140,098.36 |
| total_cost_usd_reported | 0.89 | 0.79 | 0.28 | 2.11 | 0.53 |
| tool_calls | 13.67 | 11.50 | 5.00 | 32.00 | 7.14 |
| duration_seconds | 176.75 | 152.55 | 35.00 | 465.20 | 119.38 |
| quality_score | 98.80 | 100.00 | 87.00 | 100.00 | 3.31 |

**Token Forge** (21 runs)

| Metric | mean | median | min | max | stdev |
|---|---:|---:|---:|---:|---:|
| total_tokens | 334,514.43 | 206,693 | 62,243 | 1,616,842 | 349,216.02 |
| input_tokens | 317,909.24 | 189,139 | 55,503 | 1,582,356 | 343,578.24 |
| output_tokens | 16,605.19 | 14,605 | 1,711 | 42,337 | 11,676.08 |
| cached_input_tokens | 281,133.05 | 161,598 | 42,357 | 1,495,129 | 325,426.54 |
| uncached_input_tokens | 36,776.19 | 27,541 | 13,146 | 87,227 | 20,859.80 |
| input_equivalent_tokens | 157,104.95 | 126,465 | 33,621 | 430,964 | 101,552.33 |
| total_cost_usd_reported | 0.68 | 0.55 | 0.16 | 1.69 | 0.41 |
| tool_calls | 8.19 | 6.00 | 3.00 | 25.00 | 5.14 |
| duration_seconds | 156.94 | 130.10 | 25.00 | 495.10 | 118.53 |
| quality_score | 99.71 | 100.00 | 94.00 | 100.00 | 1.31 |

Per-task token savings %: mean 52.03, median 52.42, p10 29.9, p25 44.03, p75 65.46, p90 72.87

## Per-category results

| Category | Tasks | Median savings % | Median quality Δ | Verdict |
|---|---|---:|---:|---|
| architecture | architecture | 10.2 | 0.0 | better (all tasks cheaper by >5%) |
| debugging | cross-module-debug, rust-debug | 54.2 | 5.8 | better (all tasks cheaper by >5%) |
| feature | banking-transfers, banking-web, go-api, go-feature | 54.6 | 0.0 | better (all tasks cheaper by >5%) |
| greenfield | cpp-cli, csharp-api, go-mock-api, luau-inventory, node-ssg, python-cli, rust-cli, rust-tui, ts-lib, vite-landing | 61.9 | 0.0 | better (all tasks cheaper by >5%) |
| refactor | refactor | 15.8 | 0.0 | better (all tasks cheaper by >5%) |
| review | pr-review | 38.6 | 3.3 | better (all tasks cheaper by >5%) |

## Why: tool and context traces (medians)

| Task | Agent | API requests | First-request context | Lines read | Tool-result bytes | Redundant reads | Context precision≈ | Subagents | Nested-session tokens |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| architecture | Native | 10 | 16,555 | 1,797 | 75,482 | 0 | 0.04 | 0 | 0 |
| architecture | Token Forge | 11 | 9,817 | 1,316 | 63,209 | 0 | 0.03 | 0 | 0 |
| banking-transfers | Native | 29 | 18,332 | 3,477 | 144,915 | 2 | 0.46 | 0 | 0 |
| banking-transfers | Token Forge | 26 | 11,600 | 2,637 | 110,672 | 9 | 0.58 | 0 | 0 |
| banking-web | Native | 24 | 18,088 | 2,385 | 108,718 | 2 | 0.36 | 0 | 0 |
| banking-web | Token Forge | 15 | 11,359 | 1,605 | 72,235 | 2 | 0.50 | 0 | 0 |
| cpp-cli | Native | 9 | 18,497 | 11 | 1,887 | 0 | 0.00 | 0 | 0 |
| cpp-cli | Token Forge | 6 | 11,765 | 0 | 665 | 0 | 0.00 | 0 | 0 |
| cross-module-debug | Native | 10 | 16,927 | 746 | 31,010 | 1 | 0.75 | 0 | 0 |
| cross-module-debug | Token Forge | 6 | 10,192 | 416 | 18,120 | 2 | 0.62 | 0 | 0 |
| csharp-api | Native | 22 | 20,391 | 12 | 10,310 | 0 | 0.00 | 0 | 0 |
| csharp-api | Token Forge | 8 | 13,665 | 16 | 4,580 | 0 | 0.00 | 0 | 0 |
| go-api | Native | 12 | 17,464 | 2,580 | 90,170 | 1 | 0.52 | 0 | 0 |
| go-api | Token Forge | 9 | 10,738 | 1,864 | 72,201 | 5 | 0.57 | 0 | 0 |
| go-feature | Native | 23 | 18,382 | 3,457 | 123,831 | 1 | 0.38 | 0 | 0 |
| go-feature | Token Forge | 14 | 11,647 | 2,423 | 85,807 | 15 | 0.54 | 0 | 0 |
| go-mock-api | Native | 16 | 19,412 | 121 | 7,351 | 2 | 0.00 | 0 | 0 |
| go-mock-api | Token Forge | 6 | 12,683 | 21 | 1,661 | 0 | 0.00 | 0 | 0 |
| luau-inventory | Native | 8 | 19,772 | 25 | 994 | 0 | 0.00 | 0 | 0 |
| luau-inventory | Token Forge | 4 | 13,034 | 24 | 717 | 0 | 0.00 | 0 | 0 |
| memory-followup | Native | 10 | 17,406 | 850 | 53,999 | 0 | 0.54 | 0 | 0 |
| memory-followup | Token Forge | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| node-ssg | Native | 12 | 20,241 | 24 | 7,639 | 0 | 0.00 | 0 | 0 |
| node-ssg | Token Forge | 7 | 13,506 | 6 | 3,719 | 0 | 0.00 | 0 | 0 |
| pr-review | Native | 6 | 16,569 | 1,036 | 37,974 | 0 | 0.50 | 0 | 0 |
| pr-review | Token Forge | 5 | 9,834 | 1,100 | 38,757 | 0 | 0.60 | 0 | 0 |
| python-cli | Native | 11 | 19,405 | 11 | 3,862 | 0 | 0.00 | 0 | 0 |
| python-cli | Token Forge | 7 | 12,679 | 27 | 1,542 | 0 | 0.00 | 0 | 0 |
| refactor | Native | 10 | 16,694 | 1,693 | 62,385 | 1 | 0.50 | 0 | 0 |
| refactor | Token Forge | 11 | 9,959 | 1,723 | 56,318 | 9 | 0.47 | 0 | 0 |
| rust-cli | Native | 18 | 18,241 | 4,005 | 168,677 | 1 | 0.22 | 0 | 0 |
| rust-cli | Token Forge | 13 | 11,500 | 3,274 | 99,144 | 10 | 0.65 | 0 | 0 |
| rust-debug | Native | 8 | 16,796 | 548 | 21,567 | 2 | 0.41 | 0 | 0 |
| rust-debug | Token Forge | 7 | 10,060 | 543 | 16,119 | 2 | 0.43 | 0 | 0 |
| rust-tui | Native | 18 | 19,801 | 48 | 7,837 | 1 | 0.00 | 0 | 0 |
| rust-tui | Token Forge | 10 | 13,063 | 42 | 3,590 | 4 | 0.00 | 0 | 0 |
| ts-lib | Native | 8 | 20,243 | 18 | 1,718 | 0 | 0.00 | 0 | 0 |
| ts-lib | Token Forge | 6 | 13,514 | 12 | 1,063 | 0 | 0.00 | 0 | 0 |
| vite-landing | Native | 10 | 18,601 | 21 | 2,508 | 0 | 0.00 | 0 | 0 |
| vite-landing | Token Forge | 4 | 11,863 | 6 | 624 | 0 | 0.00 | 0 | 0 |

Context precision is approximate: the share of files read that match the task's `relevant_files` globs. Files read via `cat`/`sed`/`head` in Bash are detected heuristically.

## Validation

- contaminated or invalid runs: none
- isolation problems: none
- missing telemetry: none
- repo commit mismatch: none
- prompt hash mismatch: none
- missing evaluation: none
- api models: {'claude-opus-5-5': 45}
- runs with other models: none

## Statistical conclusion

_Filled in from the numbers above after the full run; see `ANALYSIS` section if present._

