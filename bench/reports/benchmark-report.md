# Token Forge vs clean Claude Code — benchmark report

Model `claude-opus-5-5`, Claude Code 2.1.293, benchmark 1.0.0. Token Forge build under test: 0.8.0 (plugin sha256 `31952bff7273`, git d7c74387 + uncommitted changes), lean: balanced. Sessions: 2026-10-07T19-41-25, 2026-10-07T20-13-39, 2026-10-07T20-13-41, 2026-10-07T20-16-40, 2026-10-07T20-16-41, 2026-10-07T20-17-24-430e, 2026-10-07T20-18-37-ce9c, 2026-10-07T20-19-13-2892, 2026-10-07T20-26-02-42ac, 2026-10-07T20-26-02-f867, 2026-10-07T20-33-25-3199, 2026-10-07T20-33-27-ee90, 2026-10-07T20-33-29-9703, 2026-10-07T20-59-11-da5c, 2026-10-07T20-59-13-2130, 2026-10-07T20-59-15-350f, 2026-10-07T20-59-17-cb92, 2026-10-07T21-07-19-ca3f, 2026-10-07T21-07-21-fb68, 2026-10-07T21-07-23-68db, 2026-10-07T21-07-25-6c4d, 2026-10-07T21-15-36-73cd, 2026-10-07T21-15-38-f177, 2026-10-07T21-15-40-3833, 2026-10-07T21-24-08-26af, 2026-10-07T21-24-10-5ef0, 2026-10-07T21-24-12-c8d1, 2026-10-07T21-24-14-edda, 2026-10-07T21-40-26-254b, 2026-10-07T22-32-42-d4b4, 2026-10-07T22-32-44-b302, 2026-10-07T22-32-46-3e00, 2026-10-07T22-32-48-c5cf, 2026-10-07T22-35-24-2c1e, 2026-10-07T22-35-26-3a5b, 2026-10-07T22-35-28-f515, 2026-10-07T22-41-48-3d89, 2026-10-07T22-41-50-0542, 2026-10-07T22-41-52-7547, 2026-10-07T22-41-54-61af, 2026-10-07T22-44-35-2a28, 2026-10-07T22-44-37-793a, 2026-10-07T22-44-39-8371, 2026-10-07T23-01-20-e76f, 2026-10-07T23-01-22-f6f9, 2026-10-07T23-01-24-3d32, 2026-10-07T23-01-26-0904, 2026-10-07T23-04-43-367e, 2026-10-07T23-04-45-d333, 2026-10-07T23-04-47-0ea2, 2026-10-07T23-04-49-1bb9, 2026-10-07T23-07-05-afac, 2026-10-07T23-07-07-e0bd, 2026-10-07T23-07-09-eb8d, 2026-10-07T23-31-03-4e66, 2026-10-07T23-33-39-c144, 2026-10-07T23-40-06-3ea4, 2026-10-07T23-40-08-e5da, 2026-10-07T23-40-10-4155, 2026-10-07T23-40-12-f216, 2026-10-07T23-42-53-a049, 2026-10-07T23-42-55-e92b, 2026-10-07T23-42-57-c96c, 2026-10-08T00-03-41-a56b, 2026-10-08T00-03-44-5342, 2026-10-08T00-03-47-1b36, 2026-10-08T00-04-37-1949, 2026-10-08T00-05-37-d020, 2026-10-08T00-05-57-bd4d, 2026-10-08T00-09-27-d43c, 2026-10-08T00-09-31-40e7, 2026-10-08T00-09-31-d21e, 2026-10-08T00-11-47-a969, 2026-10-08T00-13-44-6dc5, 2026-10-08T00-13-44-d080, 2026-10-08T00-15-18-8a10, 2026-10-08T00-16-06-06f4, 2026-10-08T00-16-06-3cde, 2026-10-08T00-19-46-206f, 2026-10-08T00-19-46-269f, 2026-10-08T00-23-48-3e07, 2026-10-08T00-23-48-d45a, 2026-10-08T00-26-11-0b27, 2026-10-08T00-26-11-2aa9, 2026-10-08T00-29-11-3979, 2026-10-08T00-29-11-ff4d, 2026-10-08T00-32-10-b0b1, 2026-10-08T00-32-10-dc6e, 2026-10-08T00-38-48-0f38, 2026-10-08T00-38-48-2f63, 2026-10-08T00-48-18-3963, 2026-10-08T00-48-18-6753, 2026-10-08T00-48-18-9a48, 2026-10-08T00-48-18-a76d, 2026-10-08T00-48-44-cbfc, 2026-10-08T00-48-47-de2d, 2026-10-08T00-50-00-ce45, 2026-10-08T00-50-45-7217, 2026-10-08T00-50-49-31ae, 2026-10-08T00-52-02-87d9, 2026-10-08T00-52-24-6cfa, 2026-10-08T00-52-45-cb7a, 2026-10-08T00-52-57-a1c8, 2026-10-08T00-53-15-7951, 2026-10-08T00-54-06-cfab, 2026-10-08T00-54-15-8b3c, 2026-10-08T00-55-23-90f0, 2026-10-08T00-56-06-7094, 2026-10-08T00-57-07-7e40, 2026-10-08T00-59-08-a869, 2026-10-08T03-12-48-4ca1, 2026-10-08T03-21-41-1f0b, 2026-10-08T03-28-34-43a9, 2026-10-08T03-32-03-c849, 2026-10-08T03-38-06-bed2, 2026-10-08T03-44-40-4891, 2026-10-08T03-51-47-5a68, 2026-10-08T03-58-28-4cb0, 2026-10-08T12-11-34-7e45, 2026-10-08T12-17-47-54df, 2026-10-08T12-22-57-4eac, 2026-10-08T12-22-57-5056, 2026-10-08T12-22-57-6d8d, 2026-10-08T12-22-57-71fd, 2026-10-08T12-23-09-2674, 2026-10-08T12-23-21-b402, 2026-10-08T12-23-21-c6e2, 2026-10-08T12-28-30-4300, 2026-10-08T12-28-30-5ec4, 2026-10-08T12-34-18-06dd, 2026-10-08T12-40-18-f256, 2026-10-08T12-45-04-aed2, 2026-10-08T12-50-40-c9d5, 2026-10-08T12-56-32-956d, 2026-10-08T13-03-10-9840, 2026-10-08T13-25-17-4a5f, 2026-10-08T13-27-32-35b7, 2026-10-08T13-37-21-e086, 2026-10-08T13-39-59-37b4, 2026-10-08T13-39-59-fd7d, 2026-10-08T13-46-08-b8ed, 2026-10-08T13-46-08-d601, 2026-10-08T14-23-57-336a, 2026-10-08T14-26-42-dd6d, 2026-10-08T14-32-14-514c, 2026-10-08T14-34-13-28ad, 2026-10-08T14-34-58-879d.

Excluded: 117 Token Forge runs of other plugin builds (listed in the JSON report).

Excluded task `ruby-cli`: run once per side (native 389,848 tokens, quality 96.83; tokenforge 443,388 tokens, quality 96.25) and left out of the published comparison by the maintainer. Runs are kept in runs/.

## Executive summary

Across 36 paired tasks (83 executed runs, 0 not executed):

- Total-token savings per task: median **51.51%**, mean 49.61% (min 9.98%, max 75.41%). Pooled over all tasks: 51.52%.
- Input-token savings (median): 53.59%; output-token savings (median): 21.94%; uncached input (median): 17.56%.
- Cost savings at list prices (TTL-aware, `pricing` in benchmark.config.json, effective 2026-10-09): median **22.34%**, mean 22.79%; Claude Code's reported cost (median): 22.34%. Legacy fixed-weight input-equivalent savings (median): 26.34%.
- Tasks where Token Forge cost more at list prices: 2 of 36 (c-cli -9.51%, perl-cli -5.42%); sign test p = 0.0.
- Task completion: Native 0.884, Token Forge 0.95.
- Mean quality: Native 98.78, Token Forge 99.52; median per-task quality difference (TF − native): 0.0.
- Tasks where Token Forge used fewer / more tokens: 36 / 0 (sign test p = 0.0).
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
| bash-tool | Native | 1 | 623,064 | 581,963 | 41,101 | 53,755 | 1.36 | 21 | 8 | PASS | 100.0 | completed |
| bash-tool | Token Forge | 1 | 362,994 | 328,632 | 34,362 | 43,134 | 1.09 | 8 | 12 | PASS | 100.0 | completed |
| c-cli | Native | 1 | 723,340 | 681,857 | 41,483 | 52,124 | 1.37 | 14 | 2 | PASS | 100.0 | completed |
| c-cli | Token Forge | 1 | 569,314 | 523,032 | 46,282 | 60,614 | 1.50 | 10 | 3 | PASS | 100.0 | completed |
| cpp-cli | Native | 1 | 303,222 | 279,259 | 23,963 | 32,719 | 0.79 | 8 | 3 | PASS | 100.0 | completed |
| cpp-cli | Token Forge | 2 | 156,887 | 140,091 | 16,796 | 23,459 | 0.55 | 6 | 1 | PASS,PASS | 100.0 | completed,completed |
| cross-module-debug | Native | 1 | 265,193 | 262,113 | 3,080 | 22,343 | 0.29 | 10 | 8 | PASS | 100.0 | completed |
| cross-module-debug | Token Forge | 1 | 92,003 | 90,292 | 1,711 | 13,948 | 0.16 | 5 | 8 | PASS | 100.0 | completed |
| csharp-api | Native | 1 | 1,221,429 | 1,169,487 | 51,942 | 67,486 | 1.80 | 21 | 4 | PASS | 100.0 | completed |
| csharp-api | Token Forge | 2 | 334,977 | 293,290 | 41,686 | 52,118 | 1.30 | 6 | 4 | PASS,PASS | 100.0 | completed,completed |
| dart-cli | Native | 1 | 442,968 | 419,395 | 23,573 | 35,072 | 0.83 | 11 | 3 | PASS | 100.0 | completed |
| dart-cli | Token Forge | 1 | 244,932 | 228,570 | 16,362 | 24,583 | 0.56 | 9 | 5 | PASS | 100.0 | completed |
| elixir-app | Native | 1 | 540,060 | 511,582 | 28,478 | 39,483 | 0.98 | 14 | 5 | PASS | 96.9 | completed |
| elixir-app | Token Forge | 1 | 266,851 | 239,788 | 27,063 | 34,533 | 0.86 | 7 | 2 | PASS | 100.0 | completed |
| fsharp-cli | Native | 1 | 847,361 | 805,704 | 41,657 | 55,288 | 1.43 | 26 | 5 | PASS | 97.5 | completed |
| fsharp-cli | Token Forge | 1 | 324,094 | 289,855 | 34,239 | 45,227 | 1.10 | 7 | 9 | PASS | 100.0 | completed |
| go-api | Native | 3 | 684,322 | 670,408 | 17,301 | 65,689 | 0.97 | 12 | 23 | PASS,PASS,PASS | 100.0 | completed,completed,completed |
| go-api | Token Forge | 1 | 343,071 | 330,878 | 12,193 | 50,527 | 0.70 | 9 | 21 | PASS | 100.0 | completed |
| go-feature | Native | 1 | 1,936,463 | 1,892,409 | 44,054 | 109,554 | 2.11 | 25 | 37 | PASS | 100.0 | completed |
| go-feature | Token Forge | 1 | 732,932 | 701,592 | 31,340 | 76,445 | 1.36 | 13 | 28 | PASS | 100.0 | completed |
| go-mock-api | Native | 1 | 556,307 | 532,897 | 23,410 | 37,629 | 0.87 | 16 | 6 | n/a | 97.5 | completed |
| go-mock-api | Token Forge | 1 | 144,227 | 129,920 | 14,307 | 22,251 | 0.49 | 5 | 4 | n/a | 100.0 | completed |
| haskell-cli | Native | 1 | 599,458 | 560,625 | 38,833 | 52,459 | 1.30 | 11 | 1 | PASS | 100.0 | completed |
| haskell-cli | Token Forge | 1 | 402,001 | 362,363 | 39,638 | 48,870 | 1.25 | 8 | 10 | PASS | 100.0 | completed |
| java-http | Native | 1 | 813,271 | 766,250 | 47,021 | 58,936 | 1.55 | 17 | 3 | PASS | 100.0 | completed |
| java-http | Token Forge | 1 | 236,944 | 206,732 | 30,212 | 37,703 | 0.94 | 6 | 3 | PASS | 100.0 | completed |
| kotlin-cli | Native | 1 | 463,810 | 420,307 | 43,503 | 54,410 | 1.38 | 8 | 2 | PASS | 100.0 | completed |
| kotlin-cli | Token Forge | 1 | 417,535 | 376,352 | 41,183 | 50,348 | 1.29 | 8 | 2 | PASS | 100.0 | completed |
| lua-cli | Native | 1 | 780,703 | 742,713 | 37,990 | 51,104 | 1.31 | 15 | 4 | PASS | 100.0 | completed |
| lua-cli | Token Forge | 1 | 322,560 | 286,468 | 36,092 | 45,133 | 1.13 | 6 | 2 | PASS | 100.0 | completed |
| luau-inventory | Native | 1 | 244,867 | 226,683 | 18,184 | 27,666 | 0.62 | 7 | 3 | PASS | 100.0 | completed |
| luau-inventory | Token Forge | 1 | 84,211 | 72,362 | 11,849 | 19,635 | 0.40 | 3 | 3 | PASS | 100.0 | completed |
| memory-followup | Native | 2 | 412,780 | 404,498 | 8,282 | 38,535 | 0.55 | 10 | 10 | PASS,PASS | 100.0 | completed,completed |
| memory-followup | Token Forge | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |  | n/a |  |
| node-ssg | Native | 1 | 434,424 | 411,648 | 22,776 | 37,675 | 0.83 | 19 | 2 | PASS | 100.0 | completed |
| node-ssg | Token Forge | 1 | 206,693 | 189,139 | 17,554 | 27,541 | 0.60 | 6 | 1 | PASS | 100.0 | completed |
| ocaml-cli | Native | 1 | 683,629 | 651,321 | 32,308 | 43,419 | 1.11 | 15 | 7 | PASS | 97.0 | completed |
| ocaml-cli | Token Forge | 1 | 270,095 | 241,420 | 28,675 | 36,575 | 0.91 | 6 | 2 | PASS | 100.0 | completed |
| paper-proofread | Native | 2 | 238,636 | 229,940 | 8,696 | 36,445 | 0.50 | 8 | 9 | n/a,n/a | 95.3 | completed,completed |
| paper-proofread | Token Forge | 2 | 157,074 | 149,274 | 7,799 | 35,442 | 0.46 | 6 | 2 | n/a,n/a | 97.8 | completed,completed |
| pdf-paper-qa | Native | 2 | 274,318 | 271,046 | 3,272 | 47,510 | 0.49 | 8 | 2 | n/a,n/a | 100.0 | completed,completed |
| pdf-paper-qa | Token Forge | 2 | 138,111 | 137,183 | 928 | 53,326 | 0.46 | 3 | 2 | n/a,n/a | 100.0 | completed,completed |
| perl-cli | Native | 1 | 597,805 | 558,267 | 39,538 | 52,550 | 1.31 | 14 | 5 | PASS | 100.0 | completed |
| perl-cli | Token Forge | 1 | 376,785 | 332,216 | 44,569 | 54,557 | 1.38 | 6 | 2 | PASS | 97.0 | completed |
| php-api | Native | 1 | 1,072,423 | 1,023,839 | 48,584 | 62,152 | 1.66 | 19 | 6 | PASS | 100.0 | completed |
| php-api | Token Forge | 1 | 478,598 | 434,446 | 44,152 | 52,728 | 1.38 | 10 | 3 | PASS | 100.0 | completed |
| pr-review | Native | 1 | 180,606 | 175,659 | 4,947 | 28,905 | 0.36 | 5 | 4 | n/a | 96.7 | completed |
| pr-review | Token Forge | 1 | 110,808 | 107,046 | 3,762 | 26,046 | 0.30 | 4 | 5 | n/a | 100.0 | completed |
| python-cli | Native | 1 | 385,596 | 362,564 | 23,032 | 33,700 | 0.80 | 10 | 4 | PASS | 100.0 | completed |
| python-cli | Token Forge | 1 | 190,531 | 170,436 | 20,095 | 28,089 | 0.66 | 6 | 3 | PASS | 100.0 | completed |
| r-cli | Native | 1 | 659,615 | 624,276 | 35,339 | 47,394 | 1.20 | 14 | 2 | PASS | 97.1 | completed |
| r-cli | Token Forge | 1 | 285,403 | 249,709 | 35,694 | 44,357 | 1.11 | 6 | 1 | PASS | 97.1 | completed |
| refactor | Native | 1 | 413,253 | 402,678 | 10,575 | 44,303 | 0.64 | 10 | 18 | PASS | 100.0 | completed |
| refactor | Token Forge | 1 | 347,755 | 340,494 | 7,261 | 36,804 | 0.50 | 11 | 19 | PASS | 100.0 | completed |
| rust-cli | Native | 1 | 1,444,788 | 1,424,273 | 20,515 | 103,915 | 1.51 | 19 | 9 | PASS | 100.0 | completed |
| rust-cli | Token Forge | 1 | 603,940 | 589,335 | 14,605 | 63,921 | 0.91 | 13 | 23 | PASS | 100.0 | completed |
| rust-debug | Native | 2 | 202,106 | 197,546 | 4,559 | 20,260 | 0.29 | 7 | 8 | FAIL,FAIL | 88.5 | completed,completed |
| rust-debug | Token Forge | 1 | 114,905 | 111,475 | 3,430 | 14,996 | 0.21 | 6 | 7 | PASS | 100.0 | completed |
| rust-tui | Native | 1 | 802,204 | 769,894 | 32,310 | 46,683 | 1.16 | 22 | 8 | PASS | 100.0 | completed |
| rust-tui | Token Forge | 1 | 251,173 | 233,853 | 17,320 | 26,734 | 0.60 | 9 | 9 | PASS | 100.0 | completed |
| swift-cli | Native | 1 | 419,424 | 392,576 | 26,848 | 37,651 | 0.91 | 10 | 4 | PASS | 100.0 | completed |
| swift-cli | Token Forge | 1 | 192,383 | 168,537 | 23,846 | 31,401 | 0.76 | 5 | 5 | PASS | 100.0 | completed |
| ts-lib | Native | 1 | 283,542 | 262,038 | 21,504 | 31,579 | 0.73 | 7 | 4 | PASS | 100.0 | completed |
| ts-lib | Token Forge | 1 | 156,168 | 141,118 | 15,050 | 23,449 | 0.51 | 5 | 2 | PASS | 100.0 | completed |
| vite-landing | Native | 1 | 253,105 | 242,069 | 11,036 | 20,454 | 0.43 | 9 | 6 | PASS | 100.0 | completed |
| vite-landing | Token Forge | 1 | 62,243 | 55,503 | 6,740 | 13,146 | 0.25 | 3 | 2 | PASS | 100.0 | completed |
| zig-cli | Native | 1 | 964,673 | 928,028 | 36,645 | 53,812 | 1.34 | 22 | 8 | PASS | 97.1 | completed |
| zig-cli | Token Forge | 1 | 411,503 | 382,532 | 28,971 | 47,204 | 1.02 | 11 | 5 | PASS | 97.1 | completed |

| Task | Token diff | Savings % | Input % | Output % | Thinking % | Uncached % | List cost % | Quality Δ | Tool calls % | Files read % | Lines read % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| architecture | 39,249 | 10.2 | 10.2 | 9.1 | 2.5 | 15.0 | 13.0 | 0.0 | 9.1 | 35.6 | 26.8 |
| banking-transfers | 811,247 | 33.4 | 33.9 | 3.5 | -38.9 | 16.4 | 16.0 | -6.0 | 21.9 | 13.6 | 24.2 |
| banking-web | 926,506 | 59.3 | 59.5 | 42.1 | 42.3 | 34.5 | 42.6 | 0.0 | 40.0 | 15.2 | 32.7 |
| bash-tool | 260,070 | 41.7 | 43.5 | 16.4 | 4.9 | 19.8 | 19.8 | 0.0 | 61.9 | -50.0 | 40.9 |
| c-cli | 154,026 | 21.3 | 23.3 | -11.6 | -96.4 | -16.3 | -9.5 | 0.0 | 28.6 | -50.0 | 42.3 |
| cpp-cli | 146,335 | 48.3 | 49.8 | 29.9 | 5.8 | 28.3 | 30.8 | 0.0 | 31.2 | 66.7 | 100.0 |
| cross-module-debug | 173,190 | 65.3 | 65.5 | 44.5 | 32.1 | 37.6 | 44.1 | 0.0 | 50.0 | 0.0 | 44.2 |
| csharp-api | 886,452 | 72.6 | 74.9 | 19.7 | -47.4 | 22.8 | 27.8 | 0.0 | 69.0 | 12.5 | -29.2 |
| dart-cli | 198,036 | 44.7 | 45.5 | 30.6 | 39.3 | 29.9 | 31.9 | 0.0 | 18.2 | -66.7 | -58.8 |
| elixir-app | 273,209 | 50.6 | 53.1 | 5.0 | -152.9 | 12.5 | 12.4 | 3.1 | 50.0 | 60.0 | 88.2 |
| fsharp-cli | 523,267 | 61.8 | 64.0 | 17.8 | -71.7 | 18.2 | 23.1 | 2.5 | 73.1 | -80.0 | 81.7 |
| go-api | 341,251 | 49.9 | 50.6 | 29.5 | 36.7 | 23.1 | 27.1 | 0.0 | 25.0 | 8.7 | 27.8 |
| go-feature | 1,203,531 | 62.1 | 62.9 | 28.9 | 27.2 | 30.2 | 35.5 | 0.0 | 48.0 | 24.3 | 29.9 |
| go-mock-api | 412,080 | 74.1 | 75.6 | 38.9 | 26.9 | 40.9 | 44.1 | 2.5 | 68.8 | 33.3 | 82.6 |
| haskell-cli | 197,457 | 32.9 | 35.4 | -2.1 | -45.9 | 6.8 | 4.0 | 0.0 | 27.3 | -900.0 | -200.0 |
| java-http | 576,327 | 70.9 | 73.0 | 35.8 | 8.1 | 36.0 | 39.5 | 0.0 | 64.7 | 0.0 | 78.8 |
| kotlin-cli | 46,275 | 10.0 | 10.5 | 5.3 | -9.7 | 7.5 | 6.3 | 0.0 | 0.0 | 0.0 | 0.0 |
| lua-cli | 458,143 | 58.7 | 61.4 | 5.0 | -33.2 | 11.7 | 13.4 | 0.0 | 60.0 | 50.0 | 21.4 |
| luau-inventory | 160,656 | 65.6 | 68.1 | 34.8 | 33.6 | 29.0 | 35.2 | 0.0 | 57.1 | 0.0 | 4.0 |
| node-ssg | 227,731 | 52.4 | 54.0 | 22.9 | -41.3 | 26.9 | 27.4 | 0.0 | 68.4 | 50.0 | 75.0 |
| ocaml-cli | 413,534 | 60.5 | 62.9 | 11.2 | -32.9 | 15.8 | 18.6 | 3.0 | 60.0 | 71.4 | 25.0 |
| paper-proofread | 81,562 | 34.2 | 35.1 | 10.3 | 9.2 | 2.8 | 8.3 | 2.4 | 31.2 | 83.3 | -1.4 |
| pdf-paper-qa | 136,207 | 49.6 | 49.4 | 71.6 | 70.0 | -12.2 | 5.8 | 0.0 | 60.0 | 0.0 | 84.8 |
| perl-cli | 221,020 | 37.0 | 40.5 | -12.7 | -61.1 | -3.8 | -5.4 | -3.0 | 57.1 | 60.0 | 79.5 |
| php-api | 593,825 | 55.4 | 57.6 | 9.1 | -48.8 | 15.2 | 16.9 | 0.0 | 47.4 | 50.0 | 86.1 |
| pr-review | 69,798 | 38.6 | 39.1 | 23.9 | -0.3 | 9.9 | 16.6 | 3.3 | 20.0 | -25.0 | -6.2 |
| python-cli | 195,065 | 50.6 | 53.0 | 12.8 | -1.8 | 16.6 | 17.7 | 0.0 | 40.0 | 25.0 | -145.4 |
| r-cli | 374,212 | 56.7 | 60.0 | -1.0 | -49.0 | 6.4 | 7.6 | 0.0 | 57.1 | 50.0 | 36.4 |
| refactor | 65,498 | 15.8 | 15.4 | 31.3 | 59.9 | 16.9 | 21.5 | 0.0 | -10.0 | -5.6 | -1.8 |
| rust-cli | 840,848 | 58.2 | 58.6 | 28.8 | 47.7 | 38.5 | 39.7 | 0.0 | 31.6 | -155.6 | 18.2 |
| rust-debug | 87,200 | 43.1 | 43.6 | 24.8 | 6.5 | 26.0 | 28.0 | 11.5 | 14.3 | 17.6 | 1.0 |
| rust-tui | 551,031 | 68.7 | 69.6 | 46.4 | 55.1 | 42.7 | 48.3 | 0.0 | 59.1 | -12.5 | 12.5 |
| swift-cli | 227,041 | 54.1 | 57.1 | 11.2 | -40.5 | 16.6 | 16.9 | 0.0 | 50.0 | -25.0 | -71.4 |
| ts-lib | 127,374 | 44.9 | 46.1 | 30.0 | 35.1 | 25.7 | 29.7 | 0.0 | 28.6 | 50.0 | 33.3 |
| vite-landing | 190,862 | 75.4 | 77.1 | 38.9 | 28.0 | 35.7 | 42.0 | 0.0 | 66.7 | 66.7 | 71.4 |
| zig-cli | 553,170 | 57.3 | 58.8 | 20.9 | -5.3 | 12.3 | 23.5 | 0.0 | 50.0 | 37.5 | 55.8 |

## Quality-adjusted efficiency

| Task | Native tokens/quality pt | TF tokens/quality pt | Native quality/Mtok | TF quality/Mtok |
|---|---:|---:|---:|---:|
| architecture | 3,862 | 3,470 | 258.93 | 288.23 |
| banking-transfers | 24,281 | 17,200 | 41.18 | 58.14 |
| banking-web | 15,631 | 6,366 | 63.97 | 157.08 |
| bash-tool | 6,231 | 3,630 | 160.50 | 275.49 |
| c-cli | 7,233 | 5,693 | 138.25 | 175.65 |
| cpp-cli | 3,032 | 1,569 | 329.79 | 637.40 |
| cross-module-debug | 2,652 | 920 | 377.08 | 1,086.92 |
| csharp-api | 12,214 | 3,350 | 81.87 | 298.53 |
| dart-cli | 4,430 | 2,449 | 225.75 | 408.28 |
| elixir-app | 5,571 | 2,668 | 179.50 | 374.74 |
| fsharp-cli | 8,691 | 3,241 | 115.06 | 308.55 |
| go-api | 6,843 | 3,431 | 146.13 | 291.48 |
| go-feature | 19,365 | 7,329 | 51.64 | 136.44 |
| go-mock-api | 5,706 | 1,442 | 175.26 | 693.35 |
| haskell-cli | 5,995 | 4,020 | 166.82 | 248.76 |
| java-http | 8,133 | 2,369 | 122.96 | 422.04 |
| kotlin-cli | 4,638 | 4,175 | 215.61 | 239.50 |
| lua-cli | 7,807 | 3,226 | 128.09 | 310.02 |
| luau-inventory | 2,449 | 842 | 408.38 | 1,187.49 |
| memory-followup | 4,128 | n/a | 242.26 | n/a |
| node-ssg | 4,344 | 2,067 | 230.19 | 483.81 |
| ocaml-cli | 7,048 | 2,701 | 141.89 | 370.24 |
| paper-proofread | 2,503 | 1,607 | 399.46 | 622.42 |
| pdf-paper-qa | 2,743 | 1,381 | 364.54 | 724.06 |
| perl-cli | 5,978 | 3,884 | 167.28 | 257.44 |
| php-api | 10,724 | 4,786 | 93.25 | 208.94 |
| pr-review | 1,868 | 1,108 | 535.25 | 902.46 |
| python-cli | 3,856 | 1,905 | 259.34 | 524.85 |
| r-cli | 6,795 | 2,940 | 147.16 | 340.12 |
| refactor | 4,132 | 3,478 | 241.98 | 287.56 |
| rust-cli | 14,448 | 6,039 | 69.21 | 165.58 |
| rust-debug | 2,284 | 1,149 | 437.89 | 870.28 |
| rust-tui | 8,022 | 2,512 | 124.66 | 398.13 |
| swift-cli | 4,194 | 1,924 | 238.42 | 519.80 |
| ts-lib | 2,835 | 1,562 | 352.68 | 640.34 |
| vite-landing | 2,531 | 622 | 395.09 | 1,606.61 |
| zig-cli | 9,938 | 4,239 | 100.62 | 235.89 |

## Distribution statistics (all executed runs)

**Native** (43 runs)

| Metric | mean | median | min | max | stdev |
|---|---:|---:|---:|---:|---:|
| total_tokens | 641,528.37 | 540,060 | 165,107 | 2,428,089 | 476,371.03 |
| input_tokens | 617,365.23 | 517,414 | 163,942 | 2,392,370 | 468,196.18 |
| output_tokens | 24,163.14 | 23,410 | 1,165 | 51,942 | 14,751.50 |
| cached_input_tokens | 568,413.51 | 477,937 | 108,780 | 2,287,992 | 449,559.68 |
| uncached_input_tokens | 48,951.72 | 46,347 | 20,090 | 109,554 | 20,941.41 |
| cache_creation_input_tokens | 48,925.35 | 46,327 | 20,074 | 109,508 | 20,933.63 |
| thinking_tokens | 6,387.91 | 4,760 | 168 | 20,432 | 5,673.38 |
| input_equivalent_tokens | 238,840.12 | 216,791 | 63,936 | 537,852 | 125,261.82 |
| price_weighted_tokens | 247,113.44 | 231,160 | 70,418 | 528,475 | 118,906.17 |
| list_cost_usd | 0.99 | 0.92 | 0.28 | 2.11 | 0.48 |
| total_cost_usd_reported | 0.99 | 0.92 | 0.28 | 2.11 | 0.48 |
| first_request_cost_usd | 0.08 | 0.07 | 0.05 | 0.30 | 0.04 |
| api_requests | 13.19 | 12.00 | 4.00 | 29.00 | 5.43 |
| tool_calls | 13.72 | 12.00 | 3.00 | 32.00 | 6.42 |
| duration_seconds | 224.62 | 205.10 | 15.00 | 530.20 | 137.69 |
| hook_duration_ms | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| quality_score | 98.78 | 100.00 | 87.00 | 100.00 | 2.71 |

**Token Forge** (40 runs)

| Metric | mean | median | min | max | stdev |
|---|---:|---:|---:|---:|---:|
| total_tokens | 319,429.10 | 268,473.00 | 62,243 | 1,616,842 | 263,930.66 |
| input_tokens | 297,491.53 | 240,604.00 | 55,503 | 1,582,356 | 257,938.15 |
| output_tokens | 21,937.58 | 17,437.00 | 903 | 46,282 | 14,149.94 |
| cached_input_tokens | 257,321.50 | 205,303.50 | 42,357 | 1,495,129 | 244,922.25 |
| uncached_input_tokens | 40,170.03 | 38,541.00 | 13,146 | 87,227 | 16,636.95 |
| cache_creation_input_tokens | 40,153.12 | 38,523.00 | 13,138 | 87,175 | 16,631.71 |
| thinking_tokens | 8,880.77 | 5,145.50 | 114 | 27,065 | 8,540.97 |
| input_equivalent_tokens | 185,628.33 | 162,173.00 | 33,621 | 430,964 | 98,561.27 |
| price_weighted_tokens | 202,877.08 | 182,448.00 | 40,256 | 421,588 | 100,221.87 |
| list_cost_usd | 0.81 | 0.73 | 0.16 | 1.69 | 0.40 |
| total_cost_usd_reported | 0.81 | 0.73 | 0.16 | 1.69 | 0.40 |
| first_request_cost_usd | 0.11 | 0.06 | 0.04 | 0.59 | 0.14 |
| api_requests | 8.45 | 7.00 | 4.00 | 26.00 | 3.93 |
| tool_calls | 7.55 | 6.00 | 3.00 | 25.00 | 4.03 |
| duration_seconds | 203.55 | 177.50 | 15.00 | 495.10 | 132.01 |
| hook_duration_ms | 214.20 | 181.50 | 124 | 646 | 99.33 |
| quality_score | 99.52 | 100.00 | 94.00 | 100.00 | 1.37 |

Per-task token savings %: mean 49.61, median 51.51, p10 27.11, p25 40.97, p75 60.8, p90 69.78

## Per-category results

| Category | Tasks | Median savings % | Median quality Δ | Verdict |
|---|---|---:|---:|---|
| academic | paper-proofread, pdf-paper-qa | 41.9 | 1.2 | better (all tasks cheaper by >5%) |
| architecture | architecture | 10.2 | 0.0 | better (all tasks cheaper by >5%) |
| debugging | cross-module-debug, rust-debug | 54.2 | 5.8 | better (all tasks cheaper by >5%) |
| feature | banking-transfers, banking-web, go-api, go-feature | 54.6 | 0.0 | better (all tasks cheaper by >5%) |
| greenfield | bash-tool, c-cli, cpp-cli, csharp-api, dart-cli, elixir-app, fsharp-cli, go-mock-api, haskell-cli, java-http, kotlin-cli, lua-cli, luau-inventory, node-ssg, ocaml-cli, perl-cli, php-api, python-cli, r-cli, rust-cli, rust-tui, swift-cli, ts-lib, vite-landing, zig-cli | 55.4 | 0.0 | better (all tasks cheaper by >5%) |
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
| bash-tool | Native | 12 | 19,102 | 71 | 6,516 | 2 | 0.00 | 0 | 0 |
| bash-tool | Token Forge | 9 | 12,370 | 42 | 3,199 | 1 | 0.00 | 0 | 0 |
| c-cli | Native | 15 | 19,463 | 26 | 2,923 | 0 | 0.00 | 0 | 0 |
| c-cli | Token Forge | 11 | 12,722 | 15 | 2,874 | 0 | 0.00 | 0 | 0 |
| cpp-cli | Native | 9 | 18,497 | 11 | 1,887 | 0 | 0.00 | 0 | 0 |
| cpp-cli | Token Forge | 6 | 11,765 | 0 | 665 | 0 | 0.00 | 0 | 0 |
| cross-module-debug | Native | 10 | 16,927 | 746 | 31,010 | 1 | 0.75 | 0 | 0 |
| cross-module-debug | Token Forge | 6 | 10,192 | 416 | 18,120 | 2 | 0.62 | 0 | 0 |
| csharp-api | Native | 22 | 20,391 | 12 | 10,310 | 0 | 0.00 | 0 | 0 |
| csharp-api | Token Forge | 8 | 13,665 | 16 | 4,580 | 0 | 0.00 | 0 | 0 |
| dart-cli | Native | 12 | 19,172 | 17 | 5,963 | 0 | 0.00 | 0 | 0 |
| dart-cli | Token Forge | 10 | 12,431 | 27 | 2,423 | 0 | 0.00 | 0 | 0 |
| elixir-app | Native | 15 | 18,889 | 135 | 4,275 | 0 | 0.00 | 0 | 0 |
| elixir-app | Token Forge | 8 | 12,157 | 16 | 1,372 | 0 | 0.00 | 0 | 0 |
| fsharp-cli | Native | 18 | 19,523 | 164 | 6,793 | 0 | 0.00 | 0 | 0 |
| fsharp-cli | Token Forge | 8 | 12,788 | 30 | 7,362 | 0 | 0.00 | 0 | 0 |
| go-api | Native | 12 | 17,464 | 2,580 | 90,170 | 1 | 0.52 | 0 | 0 |
| go-api | Token Forge | 9 | 10,738 | 1,864 | 72,201 | 5 | 0.57 | 0 | 0 |
| go-feature | Native | 23 | 18,382 | 3,457 | 123,831 | 1 | 0.38 | 0 | 0 |
| go-feature | Token Forge | 14 | 11,647 | 2,423 | 85,807 | 15 | 0.54 | 0 | 0 |
| go-mock-api | Native | 16 | 19,412 | 121 | 7,351 | 2 | 0.00 | 0 | 0 |
| go-mock-api | Token Forge | 6 | 12,683 | 21 | 1,661 | 0 | 0.00 | 0 | 0 |
| haskell-cli | Native | 12 | 19,466 | 11 | 9,446 | 0 | 0.00 | 0 | 0 |
| haskell-cli | Token Forge | 9 | 12,734 | 33 | 3,306 | 1 | 0.00 | 0 | 0 |
| java-http | Native | 18 | 18,971 | 85 | 5,501 | 0 | 0.00 | 0 | 0 |
| java-http | Token Forge | 7 | 12,239 | 18 | 1,723 | 0 | 0.00 | 0 | 0 |
| kotlin-cli | Native | 9 | 19,770 | 10 | 3,047 | 0 | 0.00 | 0 | 0 |
| kotlin-cli | Token Forge | 9 | 13,023 | 10 | 2,348 | 0 | 0.00 | 0 | 0 |
| lua-cli | Native | 16 | 19,943 | 14 | 7,250 | 0 | 0.00 | 0 | 0 |
| lua-cli | Token Forge | 7 | 13,205 | 11 | 2,870 | 0 | 0.00 | 0 | 0 |
| luau-inventory | Native | 8 | 19,772 | 25 | 994 | 0 | 0.00 | 0 | 0 |
| luau-inventory | Token Forge | 4 | 13,034 | 24 | 717 | 0 | 0.00 | 0 | 0 |
| memory-followup | Native | 10 | 17,406 | 850 | 53,999 | 0 | 0.54 | 0 | 0 |
| memory-followup | Token Forge | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| node-ssg | Native | 12 | 20,241 | 24 | 7,639 | 0 | 0.00 | 0 | 0 |
| node-ssg | Token Forge | 7 | 13,506 | 6 | 3,719 | 0 | 0.00 | 0 | 0 |
| ocaml-cli | Native | 16 | 19,696 | 16 | 3,791 | 1 | 0.00 | 0 | 0 |
| ocaml-cli | Token Forge | 7 | 12,958 | 12 | 1,182 | 0 | 0.00 | 0 | 0 |
| paper-proofread | Native | 6 | 16,698 | 914 | 51,145 | 0 | 0.90 | 0 | 0 |
| paper-proofread | Token Forge | 6 | 9,990 | 926 | 54,292 | 0 | 0.25 | 0 | 0 |
| pdf-paper-qa | Native | 8 | 16,468 | 118 | 34,364 | 0 | 1.00 | 0 | 0 |
| pdf-paper-qa | Token Forge | 4 | 9,757 | 18 | 1,403 | 0 | 1.00 | 0 | 0 |
| perl-cli | Native | 12 | 19,643 | 39 | 6,853 | 0 | 0.00 | 0 | 0 |
| perl-cli | Token Forge | 7 | 12,917 | 8 | 4,598 | 0 | 0.00 | 0 | 0 |
| php-api | Native | 20 | 19,273 | 180 | 8,471 | 0 | 0.00 | 0 | 0 |
| php-api | Token Forge | 11 | 12,541 | 25 | 2,654 | 0 | 0.00 | 0 | 0 |
| pr-review | Native | 6 | 16,569 | 1,036 | 37,974 | 0 | 0.50 | 0 | 0 |
| pr-review | Token Forge | 5 | 9,834 | 1,100 | 38,757 | 0 | 0.60 | 0 | 0 |
| python-cli | Native | 11 | 19,405 | 11 | 3,862 | 0 | 0.00 | 0 | 0 |
| python-cli | Token Forge | 7 | 12,679 | 27 | 1,542 | 0 | 0.00 | 0 | 0 |
| r-cli | Native | 15 | 20,063 | 11 | 4,368 | 0 | 0.00 | 0 | 0 |
| r-cli | Token Forge | 7 | 13,322 | 7 | 1,488 | 0 | 0.00 | 0 | 0 |
| refactor | Native | 10 | 16,694 | 1,693 | 62,385 | 1 | 0.50 | 0 | 0 |
| refactor | Token Forge | 11 | 9,959 | 1,723 | 56,318 | 9 | 0.47 | 0 | 0 |
| rust-cli | Native | 18 | 18,241 | 4,005 | 168,677 | 1 | 0.22 | 0 | 0 |
| rust-cli | Token Forge | 13 | 11,500 | 3,274 | 99,144 | 10 | 0.65 | 0 | 0 |
| rust-debug | Native | 8 | 16,796 | 548 | 21,567 | 2 | 0.41 | 0 | 0 |
| rust-debug | Token Forge | 7 | 10,060 | 543 | 16,119 | 2 | 0.43 | 0 | 0 |
| rust-tui | Native | 18 | 19,801 | 48 | 7,837 | 1 | 0.00 | 0 | 0 |
| rust-tui | Token Forge | 10 | 13,063 | 42 | 3,590 | 4 | 0.00 | 0 | 0 |
| swift-cli | Native | 11 | 19,131 | 14 | 4,336 | 0 | 0.00 | 0 | 0 |
| swift-cli | Token Forge | 6 | 12,405 | 24 | 1,144 | 0 | 0.00 | 0 | 0 |
| ts-lib | Native | 8 | 20,243 | 18 | 1,718 | 0 | 0.00 | 0 | 0 |
| ts-lib | Token Forge | 6 | 13,514 | 12 | 1,063 | 0 | 0.00 | 0 | 0 |
| vite-landing | Native | 10 | 18,601 | 21 | 2,508 | 0 | 0.00 | 0 | 0 |
| vite-landing | Token Forge | 4 | 11,863 | 6 | 624 | 0 | 0.00 | 0 | 0 |
| zig-cli | Native | 21 | 19,118 | 267 | 15,774 | 0 | 0.00 | 0 | 0 |
| zig-cli | Token Forge | 12 | 12,380 | 118 | 11,630 | 2 | 0.00 | 0 | 0 |

Context precision is approximate: the share of files read that match the task's `relevant_files` globs. Files read via `cat`/`sed`/`head` in Bash are detected heuristically.

## Validation

- contaminated or invalid runs: none
- isolation problems: none
- missing telemetry: none
- repo commit mismatch: none
- prompt hash mismatch: none
- missing evaluation: none
- api models: {'claude-opus-5-5': 83}
- runs with other models: none
- cost not reconciled: none
- cost reconciled runs: 83

## Statistical conclusion

_Filled in from the numbers above after the full run; see `ANALYSIS` section if present._

