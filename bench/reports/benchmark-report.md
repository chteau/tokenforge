# Token Forge vs clean Claude Code — benchmark report

Model `claude-opus-5-5`, Claude Code 2.1.296, benchmark 1.0.0. Token Forge build under test: 0.9.2 (plugin sha256 `3af1944f7dd8`, git 3a44e31f + uncommitted changes), lean: balanced. Sessions: 2026-10-10T23-43-17-977c, 2026-10-10T23-45-46-348c, 2026-10-10T23-46-59-29a8, 2026-10-10T23-48-30-49b3, 2026-10-10T23-50-36-ca35, 2026-10-10T23-59-06-288c, 2026-10-11T00-11-17-ec66, 2026-10-11T00-12-23-ef40, 2026-10-11T00-12-55-07d6, 2026-10-11T00-13-33-21df, 2026-10-11T00-14-24-ecf0, 2026-10-11T00-18-16-4b3c, 2026-10-11T01-36-04-2e83, 2026-10-11T01-37-04-a7d6, 2026-10-11T01-38-04-5665, 2026-10-11T01-38-46-272e, 2026-10-11T01-39-18-71d6, 2026-10-11T01-40-05-e6aa, 2026-10-11T01-40-43-e3c2, 2026-10-11T01-41-34-f978, 2026-10-11T01-42-29-a086, 2026-10-11T01-47-32-1ad2, 2026-10-11T01-51-34-8508, 2026-10-11T01-56-06-217c, 2026-10-11T01-59-44-ce15, 2026-10-11T02-00-49-5d3b, 2026-10-11T02-02-00-2905, 2026-10-11T02-02-37-122e, 2026-10-11T02-03-03-f96f, 2026-10-11T02-03-57-1e9e, 2026-10-11T02-04-36-fb53, 2026-10-11T02-05-31-798a, 2026-10-11T02-06-32-c05d, 2026-10-11T02-10-54-e402, 2026-10-11T02-15-37-047f, 2026-10-11T02-17-03-2bea, 2026-10-11T02-17-10-f577, 2026-10-11T02-17-15-8123, 2026-10-11T02-17-20-2a57, 2026-10-11T02-17-27-f1c4, 2026-10-11T02-17-33-8148, 2026-10-11T02-17-41-d9b9, 2026-10-11T02-17-49-3825, 2026-10-11T02-17-55-42c9, 2026-10-11T02-18-00-34ac, 2026-10-11T02-18-07-9865, 2026-10-11T02-18-15-3e9f, 2026-10-11T02-18-21-8123, 2026-10-11T13-33-18-07af, 2026-10-11T13-37-25-10b7, 2026-10-11T13-40-36-bae6, 2026-10-11T13-41-52-3882, 2026-10-11T13-42-57-981e, 2026-10-11T13-43-39-e212, 2026-10-11T13-44-11-c042, 2026-10-11T13-45-03-40f9, 2026-10-11T13-45-51-ceab, 2026-10-11T13-46-46-6e96, 2026-10-11T13-47-32-b223, 2026-10-11T13-52-24-b9d6, 2026-10-11T13-56-21-13fa, 2026-10-11T14-00-58-0c02, 2026-10-11T14-23-14-1f13, 2026-10-11T14-24-20-14bc, 2026-10-11T14-25-30-b8e6, 2026-10-11T14-26-12-e44b, 2026-10-11T14-26-38-e823, 2026-10-11T14-27-31-1cc8, 2026-10-11T14-28-14-be7d, 2026-10-11T14-29-09-19b0, 2026-10-11T14-30-05-130a, 2026-10-11T14-34-22-4c8f, 2026-10-11T14-38-05-420f, 2026-10-11T14-43-06-76a1, 2026-10-11T14-47-08-4dc2, 2026-10-11T14-48-19-ec37, 2026-10-11T14-49-24-9d2d, 2026-10-11T14-50-01-f0a9, 2026-10-11T14-50-28-eb26, 2026-10-11T14-51-25-c803, 2026-10-11T14-52-03-a33e, 2026-10-11T14-52-58-d227, 2026-10-11T14-53-49-8307, 2026-10-11T14-58-36-9c0d, 2026-10-11T15-02-54-0f45, 2026-10-11T15-06-11-0432, 2026-10-11T15-07-07-bd81, 2026-10-11T15-07-33-eb8a, 2026-10-11T15-08-11-71f0, 2026-10-11T15-08-56-236a, 2026-10-11T15-12-38-2cba, 2026-10-11T15-43-22-cadb, 2026-10-11T15-44-33-8d77, 2026-10-11T15-44-59-c95e, 2026-10-11T15-45-38-d5e1, 2026-10-11T15-46-33-8d6d, 2026-10-11T15-50-20-bee2, 2026-10-11T15-53-17-2747, 2026-10-11T15-54-28-5159, 2026-10-11T15-54-54-5f4c, 2026-10-11T15-55-32-a3e0, 2026-10-11T15-56-23-8973, 2026-10-11T16-00-40-7252, 2026-10-11T16-03-37-62f1, 2026-10-11T16-04-38-cb87, 2026-10-11T16-05-04-36eb, 2026-10-11T16-05-43-ff11, 2026-10-11T16-06-39-6a5c, 2026-10-11T16-10-36-b3b3, 2026-10-11T16-14-07-cd93, 2026-10-11T16-15-17-49c9, 2026-10-11T16-15-44-bd90, 2026-10-11T16-16-32-434a, 2026-10-11T16-17-33-6abd, 2026-10-11T16-21-00-6f6b, 2026-10-11T16-24-12-1003, 2026-10-11T16-25-18-ab1b, 2026-10-11T16-25-54-d362, 2026-10-11T16-26-39-2993, 2026-10-11T16-27-29-b51e, 2026-10-11T16-31-56-9c6f, 2026-10-11T16-35-13-18e5, 2026-10-11T16-36-19-9227, 2026-10-11T16-36-55-a4e4, 2026-10-11T16-37-38-89ff, 2026-10-11T16-38-34-db64, 2026-10-11T16-42-57-ec3e, 2026-10-11T16-47-12-73aa, 2026-10-11T16-48-40-780f, 2026-10-11T16-49-08-0beb, 2026-10-11T16-49-53-c2da, 2026-10-11T16-51-19-6455, 2026-10-11T16-57-20-0dec, 2026-10-11T17-01-23-f9ec, 2026-10-11T17-02-25-6bc2, 2026-10-11T17-02-53-b0d1, 2026-10-11T17-04-01-1366, 2026-10-11T17-04-53-263f, 2026-10-11T17-09-47-6839, 2026-10-11T17-14-13-f9ad, 2026-10-11T17-15-50-407b, 2026-10-11T17-16-23-b69b, 2026-10-11T17-17-26-8717, 2026-10-11T17-18-37-85db, 2026-10-11T17-22-56-81a8, 2026-10-11T17-41-38-36fb, 2026-10-11T17-42-44-d11e, 2026-10-11T17-43-20-a416, 2026-10-11T17-44-06-8451, 2026-10-11T17-45-05-7087, 2026-10-11T17-49-25-6ac0, 2026-10-11T17-52-28-6c8d, 2026-10-11T17-53-41-a8e3, 2026-10-11T17-55-16-b908, 2026-10-11T17-56-06-5bf1, 2026-10-11T17-57-06-ac98, 2026-10-11T18-02-09-faa2, 2026-10-11T18-05-39-5fc3, 2026-10-11T18-07-05-a62c, 2026-10-11T18-07-35-38ba, 2026-10-11T18-08-32-58cf, 2026-10-11T18-09-34-9404, 2026-10-11T18-13-40-caf2, 2026-10-11T18-26-36-b591, 2026-10-11T18-27-47-a574, 2026-10-11T18-28-28-e0d6, 2026-10-11T18-29-17-04e1, 2026-10-11T18-30-15-837b, 2026-10-11T18-35-01-6e04, 2026-10-11T18-39-45-8707, 2026-10-11T18-41-00-8d03, 2026-10-11T18-41-44-5635, 2026-10-11T18-43-05-7544, 2026-10-11T18-44-02-76e3, 2026-10-11T18-49-26-7361, 2026-10-11T18-54-34-29b0, 2026-10-11T18-55-48-0235, 2026-10-11T18-56-21-5c2f, 2026-10-11T18-57-12-74e3, 2026-10-11T18-58-17-c4ae, 2026-10-11T19-02-24-e6bc, 2026-10-11T19-06-33-e747, 2026-10-11T19-08-18-16e9, 2026-10-11T19-08-59-cb75, 2026-10-11T19-09-43-13d4, 2026-10-11T19-10-39-f1dd, 2026-10-11T19-15-17-b6cb, 2026-10-11T19-19-00-8a95, 2026-10-11T19-20-00-adbc, 2026-10-11T19-20-42-0cdb, 2026-10-11T19-21-35-ef42, 2026-10-11T19-22-30-93d4, 2026-10-11T19-26-57-377c, 2026-10-12T03-19-29-e833, 2026-10-12T03-20-40-d503, 2026-10-12T03-21-08-8851, 2026-10-12T03-21-51-4ed7, 2026-10-12T03-22-42-c248, 2026-10-12T03-27-12-f75a, 2026-10-12T03-30-15-f2bd, 2026-10-12T03-31-36-658c, 2026-10-12T03-32-03-c970, 2026-10-12T03-33-00-578b, 2026-10-12T03-34-02-44bf, 2026-10-12T03-37-51-4219, 2026-10-12T03-41-23-6098, 2026-10-12T03-42-34-6039, 2026-10-12T03-43-03-bf91, 2026-10-12T03-43-41-b87a, 2026-10-12T03-44-42-3a04, 2026-10-12T03-49-35-df7d, 2026-10-12T03-52-52-c193, 2026-10-12T03-54-09-a86f, 2026-10-12T03-54-45-4211, 2026-10-12T03-55-28-70ea, 2026-10-12T03-56-30-e9aa, 2026-10-12T04-00-35-89cf, 2026-10-12T04-03-43-6694, 2026-10-12T04-04-44-6bb4, 2026-10-12T04-05-17-9b9b, 2026-10-12T04-05-59-bc6c, 2026-10-12T04-06-51-c46f, 2026-10-12T04-10-44-c342, 2026-10-12T04-14-27-a441, 2026-10-12T04-15-48-6a13, 2026-10-12T04-16-21-f8a6, 2026-10-12T04-16-59-3286, 2026-10-12T04-18-01-d83f, 2026-10-12T04-21-43-b946, 2026-10-12T04-25-25-945b, 2026-10-12T04-26-25-9482, 2026-10-12T04-26-57-fe97, 2026-10-12T04-27-35-930a, 2026-10-12T04-28-30-02ad, 2026-10-12T04-32-13-74f9, 2026-10-12T04-35-35-0d3b, 2026-10-12T04-37-25-1e00, 2026-10-12T04-37-52-5d60, 2026-10-12T04-38-34-9e20, 2026-10-12T04-39-25-8766, 2026-10-12T04-43-12-c14c, 2026-10-12T04-46-39-4eeb, 2026-10-12T04-47-39-860a, 2026-10-12T04-48-11-2982, 2026-10-12T04-48-58-4c63, 2026-10-12T04-49-54-6b33, 2026-10-12T04-53-41-bf24, 2026-10-12T04-56-59-164d, 2026-10-12T04-58-14-3e8d, 2026-10-12T04-58-46-abb0, 2026-10-12T04-59-24-0a3c, 2026-10-12T05-00-14-634b, 2026-10-12T05-05-21-bfca, 2026-10-12T05-08-43-e226, 2026-10-12T05-09-44-3a16, 2026-10-12T05-10-10-6170, 2026-10-12T05-10-58-1db5, 2026-10-12T05-11-49-2556, 2026-10-12T05-15-36-5bd0, 2026-10-12T05-19-28-e245, 2026-10-12T05-20-29-3e26, 2026-10-12T05-21-00-91fd, 2026-10-12T05-21-43-6064, 2026-10-12T05-22-33-95b4, 2026-10-12T05-26-30-7c0d, 2026-10-12T05-30-00-d25d, 2026-10-12T05-31-11-9cb6, 2026-10-12T05-31-37-40ab, 2026-10-12T05-32-40-4ce7, 2026-10-12T05-33-25-cf00, 2026-10-12T05-37-37-f84e, 2026-10-12T05-40-54-4c75, 2026-10-12T05-42-00-808f, 2026-10-12T05-42-26-6d9f, 2026-10-12T05-43-14-39e6, 2026-10-12T05-44-10-95b9, 2026-10-12T05-47-27-07e1, 2026-10-12T05-50-54-21e2, 2026-10-12T05-51-59-ab1e, 2026-10-12T05-52-31-eb86, 2026-10-12T05-53-08-d0f1, 2026-10-12T05-54-14-b51c, 2026-10-12T05-57-56-33fd, 2026-10-12T06-01-09-2739, 2026-10-12T06-02-19-1d74, 2026-10-12T06-07-22-be4f, 2026-10-12T06-10-14-de58, 2026-10-12T06-17-48-64e1, 2026-10-12T06-23-00-1e7b, 2026-10-12T06-26-18-5ec5, 2026-10-12T06-26-50-0ee7, 2026-10-12T06-34-52-5412, 2026-10-12T06-39-14-1673, 2026-10-12T06-43-23-b0e1, 2026-10-12T06-50-31-a968, 2026-10-12T06-52-53-19b1, 2026-10-12T06-58-21-3ed1, 2026-10-12T07-01-41-7f24, 2026-10-12T07-07-00-0126, 2026-10-12T07-13-38-30df, 2026-10-12T07-19-38-2a49, 2026-10-12T07-24-43-e114, 2026-10-12T07-27-19-426f, 2026-10-12T07-28-42-5ad5, 2026-10-12T07-31-13-e3d7, 2026-10-12T07-36-14-7798, 2026-10-12T07-37-45-e1ad, 2026-10-12T07-38-00-7ff7, 2026-10-12T07-43-33-a096, 2026-10-12T07-51-04-9dc7, 2026-10-12T07-52-00-3249, 2026-10-12T07-54-38-bfb3, 2026-10-12T07-59-56-a01e, 2026-10-12T08-01-29-00d8, 2026-10-12T08-04-48-1da5, 2026-10-12T08-05-36-dfb9, 2026-10-12T08-09-02-48db, 2026-10-12T08-13-19-5aa7, 2026-10-12T08-15-45-1381, 2026-10-12T08-17-48-ee6f, 2026-10-12T08-23-56-e862, 2026-10-12T08-25-06-ae00, 2026-10-12T08-30-18-c112, 2026-10-12T08-33-15-ce38, 2026-10-12T08-40-59-2198, 2026-10-12T08-46-51-affe, 2026-10-12T08-49-43-385b, 2026-10-12T08-50-20-b989, 2026-10-12T08-57-26-19cd, 2026-10-12T15-21-11-9028, 2026-10-12T15-25-45-31b7, 2026-10-12T15-32-46-3a6e, 2026-10-12T15-35-03-5420, 2026-10-12T15-42-10-1dab, 2026-10-12T15-45-50-58d6, 2026-10-12T15-52-10-c5f9, 2026-10-12T15-59-38-dca7, 2026-10-12T16-06-22-6fdc, 2026-10-12T16-11-53-a041, 2026-10-12T16-14-18-5762, 2026-10-12T16-15-47-982e, 2026-10-12T16-18-18-a0fc, 2026-10-12T16-22-39-2648, 2026-10-12T16-24-00-f982, 2026-10-12T16-24-30-e6d0, 2026-10-12T16-29-27-11b2, 2026-10-12T16-35-54-4bcf, 2026-10-12T16-36-59-aa33, 2026-10-12T16-39-57-427b, 2026-10-12T16-45-11-e435, 2026-10-12T16-46-43-c2c5, 2026-10-12T16-49-26-7aaa, 2026-10-12T16-52-29-bf0c, 2026-10-12T16-56-36-38ba, 2026-10-12T17-00-58-d967, 2026-10-12T17-03-38-9c11, 2026-10-12T17-07-27-1fcb.

**Versions of the runs in this report:** TokenForge 0.9.2 (build 3af1944f7dd8), 92 runs · Claude Code 2.1.296, 220 runs.

Excluded: 217 Token Forge runs of other plugin builds (listed in the JSON report).

Excluded task `ruby-cli`: run once per side (native 389,848 tokens, quality 96.83; tokenforge 443,388 tokens, quality 96.25) and left out of the published comparison by the maintainer. Runs are kept in runs/.

## Executive summary

_Runs used: TokenForge 0.9.2 (build 3af1944f7dd8), 92 runs · Claude Code 2.1.296, 220 runs._

Across 37 paired tasks (220 executed runs, 0 not executed):

- Total-token savings per task: median **50.94%**, mean 50.13% (min 14.4%, max 77.79%). Pooled over all tasks: 51.93%.
- Input-token savings (median): 53.41%; output-token savings (median): 25.63%; uncached input (median): 25.37%.
- Cost savings at list prices (TTL-aware, `pricing` in benchmark.config.json, effective 2026-10-09): median **27.62%**, mean 27.04%; Claude Code's reported cost (median): 27.62%. Legacy fixed-weight input-equivalent savings (median): 31.87%.
- Tasks where Token Forge cost more at list prices: 0 of 37; sign test p = 0.0.
- Task completion: Native 0.836, Token Forge 0.859.
- Mean quality: Native 94.08, Token Forge 98.43; median per-task quality difference (TF − native): 0.0.
- Tasks where Token Forge used fewer / more tokens: 37 / 0 (sign test p = 0.0).
- Fixed context added by Token Forge on the first request (median, measured): -6,482 tokens.

Positive savings mean Token Forge used fewer tokens; negative means it used more. `total tokens` = input + cache writes + cache reads + output, summed over the main session, subagents and nested `claude -p` sessions.

## Per-task comparison (median over repetitions)

_Runs used: TokenForge 0.9.2 (build 3af1944f7dd8), 92 runs · Claude Code 2.1.296, 220 runs._

| Task | Agent | Runs | Total tokens | Input | Output | Uncached in | Cost $ | Tool calls | Files read | Tests | Quality | Status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|
| architecture | Native | 11 | 487,456 | 480,870 | 6,618 | 46,374 | 0.60 | 11 | 31 | n/a,n/a,n/a,n/a,n/a,n/a,n/a,n/a,n/a,n/a,n/a | 100.0 | completed,completed,completed,agent_error,completed,completed,completed,completed,completed,completed,completed |
| architecture | Token Forge | 5 | 263,830 | 258,084 | 5,881 | 32,967 | 0.43 | 10 | 26 | n/a,n/a,n/a,n/a,n/a | 100.0 | completed,completed,completed,completed,completed |
| banking-transfers | Native | 11 | 1,597,400 | 1,566,502 | 31,691 | 92,306 | 1.61 | 24 | 35 | PASS,PASS,PASS,PASS,PASS,PASS,PASS,PASS,PASS,PASS,PASS | 94.0 | completed,completed,agent_error,agent_error,completed,completed,completed,completed,completed,completed,completed |
| banking-transfers | Token Forge | 5 | 926,244 | 903,769 | 23,393 | 68,884 | 1.16 | 17 | 25 | PASS,PASS,PASS,PASS,PASS | 100.0 | completed,completed,completed,completed,completed |
| banking-web | Native | 2 | 1,243,970 | 1,225,328 | 18,641 | 69,776 | 1.16 | 20 | 34 | PASS,PASS | 100.0 | completed,completed |
| banking-web | Token Forge | 2 | 544,995 | 531,394 | 13,600 | 45,850 | 0.74 | 14 | 24 | PASS,PASS | 100.0 | completed,completed |
| bash-tool | Native | 2 | 710,696 | 669,336 | 41,360 | 55,704 | 1.40 | 18 | 12 | PASS,PASS | 95.0 | completed,completed |
| bash-tool | Token Forge | 2 | 256,898 | 230,204 | 26,693 | 37,134 | 0.87 | 9 | 11 | PASS,PASS | 100.0 | completed,completed |
| c-cli | Native | 2 | 613,318 | 574,355 | 38,962 | 48,814 | 1.27 | 12 | 1 | PASS,PASS | 100.0 | completed,completed |
| c-cli | Token Forge | 2 | 399,043 | 366,552 | 32,490 | 42,334 | 1.05 | 14 | 1 | PASS,PASS | 100.0 | completed,completed |
| cpp-cli | Native | 2 | 330,364 | 307,398 | 22,966 | 31,704 | 0.77 | 9 | 2 | PASS,PASS | 100.0 | completed,completed |
| cpp-cli | Token Forge | 2 | 180,526 | 163,471 | 17,055 | 25,525 | 0.57 | 12 | 6 | PASS,PASS | 100.0 | completed,completed |
| cross-module-debug | Native | 11 | 207,212 | 204,624 | 2,756 | 22,054 | 0.26 | 8 | 9 | PASS,PASS,PASS,PASS,PASS,PASS,PASS,PASS,PASS,PASS,PASS | 100.0 | completed,completed,completed,agent_error,completed,completed,completed,completed,completed,completed,completed |
| cross-module-debug | Token Forge | 5 | 102,142 | 100,220 | 1,922 | 14,349 | 0.17 | 6 | 6 | PASS,PASS,PASS,PASS,PASS | 100.0 | completed,completed,completed,completed,completed |
| csharp-api | Native | 2 | 1,074,632 | 1,029,646 | 44,986 | 61,659 | 1.59 | 21 | 8 | PASS,PASS | 98.8 | completed,completed |
| csharp-api | Token Forge | 2 | 353,482 | 317,936 | 35,546 | 49,797 | 1.16 | 8 | 3 | PASS,PASS | 100.0 | completed,completed |
| dart-cli | Native | 2 | 479,859 | 455,240 | 24,618 | 36,070 | 0.86 | 12 | 8 | PASS,PASS | 100.0 | completed,completed |
| dart-cli | Token Forge | 2 | 255,660 | 237,752 | 17,908 | 26,624 | 0.61 | 8 | 4 | PASS,PASS | 98.6 | completed,completed |
| elixir-app | Native | 2 | 492,460 | 464,345 | 28,115 | 38,797 | 0.96 | 12 | 2 | PASS,PASS | 100.0 | completed,completed |
| elixir-app | Token Forge | 2 | 236,958 | 211,799 | 25,160 | 35,591 | 0.82 | 6 | 3 | PASS,PASS | 100.0 | completed,completed |
| fsharp-cli | Native | 2 | 765,307 | 730,272 | 35,036 | 47,937 | 1.22 | 17 | 6 | PASS,PASS | 100.0 | completed,completed |
| fsharp-cli | Token Forge | 2 | 329,926 | 303,058 | 26,867 | 36,802 | 0.88 | 9 | 4 | PASS,PASS | 100.0 | completed,completed |
| go-api | Native | 2 | 622,749 | 606,095 | 16,654 | 66,354 | 0.97 | 11 | 24 | PASS,PASS | 100.0 | completed,completed |
| go-api | Token Forge | 2 | 379,850 | 368,286 | 11,564 | 47,040 | 0.67 | 10 | 17 | PASS,PASS | 100.0 | completed,completed |
| go-feature | Native | 11 | 1,088,691 | 1,058,196 | 32,031 | 90,115 | 1.42 | 20 | 33 | PASS,PASS,PASS,PASS,PASS,PASS,PASS,PASS,PASS,PASS,PASS | 100.0 | completed,completed,completed,agent_error,completed,completed,completed,completed,completed,completed,completed |
| go-feature | Token Forge | 5 | 551,309 | 524,468 | 26,674 | 61,104 | 1.12 | 11 | 25 | PASS,PASS,PASS,PASS,PASS | 100.0 | completed,completed,completed,completed,completed |
| go-mock-api | Native | 2 | 426,438 | 401,478 | 24,960 | 36,840 | 0.87 | 14 | 4 | n/a,n/a | 97.5 | completed,completed |
| go-mock-api | Token Forge | 2 | 133,038 | 117,438 | 15,601 | 24,008 | 0.52 | 4 | 4 | n/a,n/a | 98.8 | completed,completed |
| haskell-cli | Native | 2 | 671,418 | 633,731 | 37,687 | 51,460 | 1.28 | 12 | 4 | PASS,PASS | 100.0 | completed,completed |
| haskell-cli | Token Forge | 2 | 311,936 | 284,211 | 27,725 | 37,112 | 0.90 | 8 | 4 | PASS,PASS | 100.0 | completed,completed |
| java-http | Native | 2 | 796,688 | 749,594 | 47,094 | 58,776 | 1.55 | 22 | 8 | PASS,PASS | 98.5 | completed,completed |
| java-http | Token Forge | 2 | 352,256 | 312,359 | 39,898 | 48,450 | 1.24 | 11 | 4 | PASS,PASS | 98.5 | completed,completed |
| kotlin-cli | Native | 2 | 580,174 | 539,540 | 40,634 | 51,910 | 1.33 | 11 | 2 | PASS,PASS | 100.0 | completed,completed |
| kotlin-cli | Token Forge | 2 | 349,542 | 318,376 | 31,166 | 41,288 | 1.01 | 16 | 2 | PASS,PASS | 100.0 | completed,completed |
| lua-cli | Native | 2 | 731,355 | 695,869 | 35,486 | 49,893 | 1.24 | 16 | 2 | PASS,PASS | 95.0 | completed,completed |
| lua-cli | Token Forge | 2 | 380,574 | 350,730 | 29,844 | 41,298 | 0.99 | 17 | 3 | PASS,PASS | 95.0 | completed,completed |
| luau-inventory | Native | 2 | 258,664 | 240,904 | 17,760 | 27,508 | 0.62 | 8 | 4 | PASS,PASS | 100.0 | completed,completed |
| luau-inventory | Token Forge | 2 | 136,766 | 123,418 | 13,347 | 22,056 | 0.46 | 7 | 3 | PASS,PASS | 100.0 | completed,completed |
| memory-followup | Native | 2 | 330,224 | 322,244 | 7,980 | 40,553 | 0.54 | 8 | 10 | PASS,PASS | 100.0 | completed,completed |
| memory-followup | Token Forge | 2 | 156,367 | 149,994 | 6,372 | 26,545 | 0.36 | 6 | 8 | PASS,PASS | 98.1 | completed,completed |
| node-ssg | Native | 2 | 239,689 | 221,306 | 18,382 | 28,920 | 0.64 | 6 | 4 | PASS,PASS | 100.0 | completed,completed |
| node-ssg | Token Forge | 2 | 135,232 | 121,561 | 13,671 | 22,751 | 0.48 | 8 | 2 | PASS,PASS | 100.0 | completed,completed |
| ocaml-cli | Native | 2 | 481,047 | 450,922 | 30,124 | 40,478 | 1.01 | 10 | 4 | PASS,PASS | 100.0 | completed,completed |
| ocaml-cli | Token Forge | 2 | 227,120 | 202,050 | 25,070 | 33,498 | 0.80 | 6 | 4 | PASS,PASS | 100.0 | completed,completed |
| paper-proofread | Native | 2 | 266,465 | 257,886 | 8,578 | 36,670 | 0.51 | 8 | 10 | n/a,n/a | 97.8 | completed,completed |
| paper-proofread | Token Forge | 2 | 168,874 | 161,715 | 7,158 | 34,358 | 0.44 | 6 | 0 | n/a,n/a | 97.8 | completed,completed |
| pdf-paper-qa | Native | 2 | 174,743 | 173,544 | 1,198 | 55,270 | 0.49 | 4 | 2 | n/a,n/a | 100.0 | completed,completed |
| pdf-paper-qa | Token Forge | 2 | 139,163 | 138,362 | 802 | 53,493 | 0.46 | 3 | 2 | n/a,n/a | 100.0 | completed,completed |
| perl-cli | Native | 2 | 614,601 | 579,695 | 34,906 | 47,464 | 1.18 | 16 | 9 | PASS,PASS | 100.0 | completed,completed |
| perl-cli | Token Forge | 2 | 264,180 | 235,553 | 28,628 | 38,216 | 0.92 | 12 | 0 | PASS,PASS | 98.5 | completed,completed |
| php-api | Native | 2 | 1,131,961 | 1,081,161 | 50,800 | 63,785 | 1.73 | 21 | 5 | PASS,PASS | 100.0 | completed,completed |
| php-api | Token Forge | 2 | 372,208 | 341,149 | 31,060 | 40,454 | 1.00 | 10 | 4 | PASS,PASS | 93.1 | completed,completed |
| pr-review | Native | 11 | 222,542 | 217,671 | 5,029 | 30,489 | 0.38 | 6 | 5 | n/a,n/a,n/a,n/a,n/a,n/a,n/a,n/a,n/a,n/a,n/a | 98.1 | completed,completed,completed,agent_error,completed,completed,completed,completed,completed,completed,completed |
| pr-review | Token Forge | 5 | 190,505 | 186,053 | 4,585 | 25,751 | 0.33 | 7 | 5 | n/a,n/a,n/a,n/a,n/a | 96.7 | completed,completed,completed,completed,completed |
| python-cli | Native | 2 | 300,874 | 280,484 | 20,391 | 30,850 | 0.70 | 10 | 2 | PASS,PASS | 100.0 | completed,completed |
| python-cli | Token Forge | 2 | 134,466 | 120,850 | 13,616 | 23,010 | 0.48 | 4 | 4 | PASS,PASS | 100.0 | completed,completed |
| r-cli | Native | 2 | 532,846 | 499,699 | 33,146 | 44,865 | 1.11 | 12 | 6 | PASS,PASS | 97.1 | completed,completed |
| r-cli | Token Forge | 2 | 261,418 | 232,797 | 28,622 | 38,722 | 0.92 | 6 | 2 | PASS,PASS | 97.1 | completed,completed |
| refactor | Native | 2 | 384,395 | 374,032 | 10,364 | 43,332 | 0.62 | 10 | 18 | PASS,PASS | 100.0 | completed,completed |
| refactor | Token Forge | 2 | 252,764 | 246,440 | 6,324 | 28,502 | 0.40 | 8 | 14 | PASS,PASS | 100.0 | completed,completed |
| rust-cli | Native | 2 | 1,254,428 | 1,234,659 | 19,770 | 84,624 | 1.30 | 19 | 24 | PASS,PASS | 100.0 | completed,completed |
| rust-cli | Token Forge | 2 | 706,126 | 690,770 | 15,357 | 62,518 | 0.93 | 14 | 25 | PASS,PASS | 100.0 | completed,completed |
| rust-debug | Native | 11 | 199,876 | 195,550 | 4,278 | 19,548 | 0.27 | 7 | 5 | FAIL,FAIL,FAIL,PASS,FAIL,FAIL,FAIL,FAIL,FAIL,FAIL,FAIL | 90.0 | completed,completed,completed,agent_error,completed,completed,completed,completed,completed,completed,completed |
| rust-debug | Token Forge | 5 | 105,589 | 102,662 | 3,033 | 14,422 | 0.19 | 5 | 6 | FAIL,FAIL,FAIL,FAIL,FAIL | 87.0 | completed,completed,completed,completed,completed |
| rust-tui | Native | 2 | 602,700 | 577,811 | 24,890 | 38,558 | 0.91 | 16 | 6 | PASS,PASS | 100.0 | completed,completed |
| rust-tui | Token Forge | 2 | 171,750 | 157,320 | 14,430 | 23,908 | 0.51 | 7 | 6 | PASS,PASS | 100.0 | completed,completed |
| swift-cli | Native | 2 | 454,072 | 425,629 | 28,444 | 41,528 | 0.98 | 10 | 2 | PASS,PASS | 100.0 | completed,completed |
| swift-cli | Token Forge | 2 | 205,642 | 185,000 | 20,642 | 31,340 | 0.69 | 6 | 2 | PASS,PASS | 100.0 | completed,completed |
| ts-lib | Native | 2 | 349,008 | 330,727 | 18,280 | 30,553 | 0.67 | 9 | 4 | PASS,PASS | 100.0 | completed,completed |
| ts-lib | Token Forge | 2 | 159,644 | 143,615 | 16,029 | 24,998 | 0.54 | 5 | 4 | PASS,PASS | 100.0 | completed,completed |
| vite-landing | Native | 2 | 337,496 | 326,252 | 11,244 | 22,311 | 0.46 | 12 | 2 | PASS,PASS | 100.0 | completed,completed |
| vite-landing | Token Forge | 2 | 74,968 | 67,634 | 7,334 | 14,305 | 0.27 | 4 | 2 | PASS,PASS | 95.0 | completed,completed |
| zig-cli | Native | 2 | 844,244 | 807,024 | 37,220 | 54,325 | 1.33 | 18 | 8 | PASS,PASS | 98.5 | completed,completed |
| zig-cli | Token Forge | 2 | 355,340 | 328,318 | 27,022 | 39,692 | 0.92 | 14 | 6 | PASS,PASS | 95.6 | completed,completed |

| Task | Token diff | Savings % | Input % | Output % | Thinking % | Uncached % | List cost % | Quality Δ | Tool calls % | Files read % | Lines read % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| architecture | 223,626 | 45.9 | 46.3 | 11.1 | -30.5 | 28.9 | 28.4 | 0.0 | 9.1 | 16.1 | -4.9 |
| banking-transfers | 671,156 | 42.0 | 42.3 | 26.2 | 15.8 | 25.4 | 27.6 | 6.0 | 29.2 | 28.6 | 27.8 |
| banking-web | 698,974 | 56.2 | 56.6 | 27.0 | 23.5 | 34.3 | 36.7 | 0.0 | 31.7 | 29.9 | 42.5 |
| bash-tool | 453,798 | 63.9 | 65.6 | 35.5 | 39.8 | 33.3 | 37.7 | 5.0 | 48.6 | 12.0 | 11.3 |
| c-cli | 214,274 | 34.9 | 36.2 | 16.6 | 26.1 | 13.3 | 17.4 | 0.0 | -20.8 | 0.0 | 91.7 |
| cpp-cli | 149,838 | 45.4 | 46.8 | 25.7 | 27.0 | 19.5 | 25.4 | 0.0 | -38.9 | -120.0 | -140.0 |
| cross-module-debug | 105,070 | 50.7 | 51.0 | 30.3 | 67.1 | 34.9 | 35.5 | 0.0 | 25.0 | 33.3 | 48.0 |
| csharp-api | 721,150 | 67.1 | 69.1 | 21.0 | -11.3 | 19.2 | 26.7 | 1.2 | 64.3 | 64.7 | 69.2 |
| dart-cli | 224,200 | 46.7 | 47.8 | 27.3 | 0.1 | 26.2 | 29.1 | -1.4 | 29.2 | 56.2 | 82.5 |
| elixir-app | 255,502 | 51.9 | 54.4 | 10.5 | -86.8 | 8.3 | 14.1 | 0.0 | 48.0 | -50.0 | -57.6 |
| fsharp-cli | 435,382 | 56.9 | 58.5 | 23.3 | 1.8 | 23.2 | 27.5 | 0.0 | 47.1 | 46.1 | 83.0 |
| go-api | 242,900 | 39.0 | 39.2 | 30.6 | 41.7 | 29.1 | 30.9 | 0.0 | 13.6 | 27.7 | 37.4 |
| go-feature | 537,382 | 49.4 | 50.4 | 16.7 | 8.5 | 32.2 | 20.6 | 0.0 | 45.0 | 24.2 | 32.9 |
| go-mock-api | 293,400 | 68.8 | 70.8 | 37.5 | 47.4 | 34.8 | 39.7 | 1.2 | 67.9 | 0.0 | 30.4 |
| haskell-cli | 359,482 | 53.5 | 55.1 | 26.4 | 24.0 | 27.9 | 29.7 | 0.0 | 36.0 | -12.5 | 82.5 |
| java-http | 444,432 | 55.8 | 58.3 | 15.3 | -8.9 | 17.6 | 20.1 | 0.0 | 48.8 | 46.7 | 73.1 |
| kotlin-cli | 230,632 | 39.8 | 41.0 | 23.3 | 19.6 | 20.5 | 23.9 | 0.0 | -40.9 | 0.0 | 35.0 |
| lua-cli | 350,781 | 48.0 | 49.6 | 15.9 | -9.5 | 17.2 | 20.1 | 0.0 | -3.0 | -20.0 | -55.6 |
| luau-inventory | 121,898 | 47.1 | 48.8 | 24.9 | 20.0 | 19.8 | 25.0 | 0.0 | 6.7 | 14.3 | 26.9 |
| memory-followup | 173,856 | 52.6 | 53.5 | 20.1 | 33.9 | 34.5 | 32.5 | -1.9 | 23.5 | 28.6 | 30.5 |
| node-ssg | 104,457 | 43.6 | 45.1 | 25.6 | 35.8 | 21.3 | 25.5 | 0.0 | -23.1 | 57.1 | 48.9 |
| ocaml-cli | 253,926 | 52.8 | 55.2 | 16.8 | -1.3 | 17.2 | 20.4 | 0.0 | 42.9 | 0.0 | -281.8 |
| paper-proofread | 97,592 | 36.6 | 37.3 | 16.6 | 7.5 | 6.3 | 12.9 | 0.0 | 25.0 | 100.0 | 8.8 |
| pdf-paper-qa | 35,580 | 20.4 | 20.3 | 33.1 | 13.8 | 3.2 | 5.9 | 0.0 | 14.3 | 0.0 | -3.0 |
| perl-cli | 350,420 | 57.0 | 59.4 | 18.0 | -3.0 | 19.5 | 22.5 | -1.5 | 25.8 | 100.0 | 100.0 |
| php-api | 759,752 | 67.1 | 68.5 | 38.9 | 30.9 | 36.6 | 41.9 | -6.9 | 54.8 | 30.0 | 14.8 |
| pr-review | 32,037 | 14.4 | 14.5 | 8.8 | 6.0 | 15.5 | 15.3 | -1.5 | -16.7 | 0.0 | 52.9 |
| python-cli | 166,408 | 55.3 | 56.9 | 33.2 | 28.5 | 25.4 | 32.4 | 0.0 | 52.6 | -75.0 | -1,037.5 |
| r-cli | 271,427 | 50.9 | 53.4 | 13.7 | -11.0 | 13.7 | 17.2 | 0.0 | 43.5 | 69.2 | 7.7 |
| refactor | 131,631 | 34.2 | 34.1 | 39.0 | 37.2 | 34.2 | 35.8 | 0.0 | 15.0 | 22.9 | 36.3 |
| rust-cli | 548,302 | 43.7 | 44.0 | 22.3 | 34.8 | 26.1 | 28.4 | 0.0 | 26.3 | -2.0 | 25.0 |
| rust-debug | 94,287 | 47.2 | 47.5 | 29.1 | 31.2 | 26.2 | 28.8 | -3.0 | 28.6 | -20.0 | 28.0 |
| rust-tui | 430,950 | 71.5 | 72.8 | 42.0 | 34.0 | 38.0 | 44.6 | 0.0 | 57.6 | 0.0 | 31.4 |
| swift-cli | 248,430 | 54.7 | 56.5 | 27.4 | 30.2 | 24.5 | 29.0 | 0.0 | 42.9 | 0.0 | -77.8 |
| ts-lib | 189,364 | 54.3 | 56.6 | 12.3 | -14.9 | 18.2 | 18.8 | 0.0 | 44.4 | 0.0 | 7.1 |
| vite-landing | 262,527 | 77.8 | 79.3 | 34.8 | 39.0 | 35.9 | 41.4 | -5.0 | 69.6 | 20.0 | 82.3 |
| zig-cli | 488,904 | 57.9 | 59.3 | 27.4 | 16.0 | 26.9 | 31.1 | -2.9 | 20.0 | 29.4 | 36.7 |

## Quality-adjusted efficiency

_Runs used: TokenForge 0.9.2 (build 3af1944f7dd8), 92 runs · Claude Code 2.1.296, 220 runs._

| Task | Native tokens/quality pt | TF tokens/quality pt | Native quality/Mtok | TF quality/Mtok |
|---|---:|---:|---:|---:|
| architecture | 4,875 | 2,638 | 205.15 | 379.03 |
| banking-transfers | 16,994 | 9,262 | 58.85 | 107.96 |
| banking-web | 12,440 | 5,450 | 80.39 | 183.49 |
| bash-tool | 7,481 | 2,569 | 133.67 | 389.26 |
| c-cli | 6,133 | 3,990 | 163.05 | 250.60 |
| cpp-cli | 3,304 | 1,805 | 302.70 | 553.94 |
| cross-module-debug | 2,072 | 1,021 | 482.60 | 979.03 |
| csharp-api | 10,882 | 3,535 | 91.89 | 282.90 |
| dart-cli | 4,799 | 2,593 | 208.39 | 385.69 |
| elixir-app | 4,925 | 2,370 | 203.06 | 422.01 |
| fsharp-cli | 7,653 | 3,299 | 130.67 | 303.10 |
| go-api | 6,228 | 3,798 | 160.58 | 263.26 |
| go-feature | 10,887 | 5,513 | 91.85 | 181.39 |
| go-mock-api | 4,374 | 1,347 | 228.64 | 742.27 |
| haskell-cli | 6,714 | 3,119 | 148.94 | 320.58 |
| java-http | 8,088 | 3,576 | 123.64 | 279.64 |
| kotlin-cli | 5,802 | 3,495 | 172.36 | 286.09 |
| lua-cli | 7,698 | 4,006 | 129.90 | 249.62 |
| luau-inventory | 2,587 | 1,368 | 386.60 | 731.18 |
| memory-followup | 3,302 | 1,594 | 302.83 | 627.53 |
| node-ssg | 2,397 | 1,352 | 417.21 | 739.47 |
| ocaml-cli | 4,810 | 2,271 | 207.88 | 440.29 |
| paper-proofread | 2,726 | 1,727 | 366.90 | 578.92 |
| pdf-paper-qa | 1,747 | 1,392 | 572.27 | 718.58 |
| perl-cli | 6,146 | 2,682 | 162.71 | 372.85 |
| php-api | 11,320 | 3,996 | 88.34 | 250.22 |
| pr-review | 2,268 | 1,971 | 440.91 | 507.44 |
| python-cli | 3,009 | 1,345 | 332.36 | 743.68 |
| r-cli | 5,489 | 2,693 | 182.17 | 371.32 |
| refactor | 3,844 | 2,528 | 260.15 | 395.63 |
| rust-cli | 12,544 | 7,061 | 79.72 | 141.62 |
| rust-debug | 2,221 | 1,214 | 450.28 | 823.95 |
| rust-tui | 6,027 | 1,718 | 165.92 | 582.24 |
| swift-cli | 4,541 | 2,056 | 220.23 | 486.28 |
| ts-lib | 3,490 | 1,596 | 286.53 | 626.39 |
| vite-landing | 3,375 | 789 | 296.30 | 1,267.20 |
| zig-cli | 8,568 | 3,717 | 116.71 | 269.05 |

## Distribution statistics (all executed runs)

_Runs used: TokenForge 0.9.2 (build 3af1944f7dd8), 92 runs · Claude Code 2.1.296, 220 runs._

**Native** (128 runs; Claude Code 2.1.296)

| Metric | mean | median | min | max | stdev |
|---|---:|---:|---:|---:|---:|
| total_tokens | 601,127.78 | 455,090.50 | 0.00 | 2,175,075 | 497,073.72 |
| input_tokens | 581,687.38 | 429,877.00 | 0.00 | 2,143,054 | 487,134.44 |
| output_tokens | 19,440.41 | 18,453.50 | 0.00 | 54,637 | 14,817.30 |
| cached_input_tokens | 536,034.87 | 386,234.50 | 0.00 | 2,050,748 | 464,493.41 |
| uncached_input_tokens | 45,652.51 | 42,677.50 | 0.00 | 104,445 | 24,714.29 |
| cache_creation_input_tokens | 45,628.35 | 42,653.50 | 0.00 | 104,401 | 24,704.33 |
| thinking_tokens | 4,638.43 | 3,270.50 | 0.00 | 20,212 | 5,106.80 |
| input_equivalent_tokens | 207,865.11 | 177,110.00 | 0.00 | 521,402 | 137,078.48 |
| price_weighted_tokens | 212,415.55 | 184,043.50 | 0.00 | 513,007 | 132,087.10 |
| list_cost_usd | 0.85 | 0.74 | 0.00 | 2.05 | 0.53 |
| total_cost_usd_reported | 0.85 | 0.74 | 0.00 | 2.05 | 0.53 |
| first_request_cost_usd | 0.07 | 0.07 | 0.00 | 0.36 | 0.03 |
| api_requests | 12.13 | 11.00 | 1.00 | 28.00 | 5.81 |
| tool_calls | 12.40 | 11.00 | 0.00 | 30.00 | 6.82 |
| duration_seconds | 179.55 | 160.05 | 5.00 | 460.10 | 130.84 |
| hook_duration_ms | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| peak_rss_mb | 300.32 | 274.70 | 244.60 | 1,113.40 | 110.48 |
| cpu_seconds | 15.01 | 8.19 | 0.56 | 87.65 | 18.35 |
| quality_score | 94.08 | 100.00 | 0.00 | 100.00 | 18.21 |

**Token Forge** (92 runs; 0.9.2 (build 3af1944f7dd8))

| Metric | mean | median | min | max | stdev |
|---|---:|---:|---:|---:|---:|
| total_tokens | 302,166.82 | 247,031.00 | 64,533 | 980,078 | 216,297.93 |
| input_tokens | 284,956.29 | 227,766.50 | 57,536 | 956,406 | 211,400.15 |
| output_tokens | 17,210.52 | 15,797.00 | 720 | 44,379 | 10,960.91 |
| cached_input_tokens | 248,899.86 | 188,752.50 | 43,668 | 879,094 | 197,726.27 |
| uncached_input_tokens | 36,056.43 | 34,013.50 | 13,868 | 79,739 | 15,747.88 |
| cache_creation_input_tokens | 36,038.91 | 33,998.50 | 13,860 | 79,705 | 15,742.90 |
| thinking_tokens | 5,034.78 | 2,981.00 | 36.00 | 20,020 | 5,130.68 |
| input_equivalent_tokens | 156,008.82 | 144,687.50 | 31,731 | 330,898 | 80,847.31 |
| price_weighted_tokens | 170,592.96 | 157,732.50 | 38,957 | 346,777 | 83,571.19 |
| list_cost_usd | 0.68 | 0.63 | 0.16 | 1.39 | 0.33 |
| total_cost_usd_reported | 0.68 | 0.63 | 0.16 | 1.39 | 0.33 |
| first_request_cost_usd | 0.06 | 0.06 | 0.04 | 0.34 | 0.03 |
| api_requests | 8.76 | 8.00 | 4.00 | 19.00 | 3.34 |
| tool_calls | 8.97 | 8.00 | 3.00 | 20.00 | 4.33 |
| duration_seconds | 156.13 | 137.60 | 15.00 | 375.10 | 92.25 |
| hook_duration_ms | 296.83 | 253.50 | 153 | 634 | 128.71 |
| peak_rss_mb | 307.44 | 275.25 | 251.90 | 998.70 | 112.57 |
| cpu_seconds | 13.16 | 8.03 | 1.38 | 71.48 | 14.16 |
| quality_score | 98.43 | 100.00 | 87.00 | 100.00 | 3.29 |

Per-task token savings %: mean 50.13, median 50.94, p10 35.95, p25 43.71, p75 56.19, p90 67.11

## Per-category results

_Runs used: TokenForge 0.9.2 (build 3af1944f7dd8), 92 runs · Claude Code 2.1.296, 220 runs._

| Category | Tasks | Median savings % | Median quality Δ | Verdict |
|---|---|---:|---:|---|
| academic | paper-proofread, pdf-paper-qa | 28.5 | 0.0 | better (all tasks cheaper by >5%) |
| architecture | architecture | 45.9 | 0.0 | better (all tasks cheaper by >5%) |
| debugging | cross-module-debug, rust-debug | 48.9 | -1.5 | better (all tasks cheaper by >5%) |
| feature | banking-transfers, banking-web, go-api, go-feature, memory-followup | 49.4 | 0.0 | better (all tasks cheaper by >5%) |
| greenfield | bash-tool, c-cli, cpp-cli, csharp-api, dart-cli, elixir-app, fsharp-cli, go-mock-api, haskell-cli, java-http, kotlin-cli, lua-cli, luau-inventory, node-ssg, ocaml-cli, perl-cli, php-api, python-cli, r-cli, rust-cli, rust-tui, swift-cli, ts-lib, vite-landing, zig-cli | 54.3 | 0.0 | better (all tasks cheaper by >5%) |
| refactor | refactor | 34.2 | 0.0 | better (all tasks cheaper by >5%) |
| review | pr-review | 14.4 | -1.5 | better (all tasks cheaper by >5%) |

## Why: tool and context traces (medians)

_Runs used: TokenForge 0.9.2 (build 3af1944f7dd8), 92 runs · Claude Code 2.1.296, 220 runs._

| Task | Agent | API requests | First-request context | Lines read | Tool-result bytes | Redundant reads | Context precision≈ | Subagents | Nested-session tokens |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| architecture | Native | 11 | 16,665 | 1,056 | 74,505 | 0 | 0.00 | 0 | 0 |
| architecture | Token Forge | 10 | 10,871 | 1,108 | 49,382 | 3 | 0.26 | 0 | 0 |
| banking-transfers | Native | 23 | 18,448 | 2,990 | 124,944 | 0 | 0.51 | 0 | 0 |
| banking-transfers | Token Forge | 17 | 12,877 | 2,158 | 91,778 | 4 | 0.73 | 0 | 0 |
| banking-web | Native | 20 | 18,207 | 2,242 | 102,364 | 1 | 0.36 | 0 | 0 |
| banking-web | Token Forge | 14 | 12,638 | 1,290 | 58,132 | 1 | 0.57 | 0 | 0 |
| bash-tool | Native | 14 | 19,220 | 93 | 8,084 | 2 | 0.00 | 0 | 0 |
| bash-tool | Token Forge | 8 | 12,736 | 82 | 5,558 | 4 | 0.00 | 0 | 0 |
| c-cli | Native | 13 | 19,578 | 12 | 1,754 | 0 | 0.00 | 0 | 0 |
| c-cli | Token Forge | 10 | 13,098 | 1 | 3,504 | 0 | 0.00 | 0 | 0 |
| cpp-cli | Native | 10 | 18,614 | 12 | 1,536 | 0 | 0.00 | 0 | 0 |
| cpp-cli | Token Forge | 7 | 12,128 | 30 | 2,696 | 0 | 0.00 | 0 | 0 |
| cross-module-debug | Native | 8 | 17,049 | 718 | 29,684 | 1 | 0.65 | 0 | 0 |
| cross-module-debug | Token Forge | 6 | 11,475 | 373 | 17,116 | 1 | 1.00 | 0 | 0 |
| csharp-api | Native | 22 | 20,513 | 58 | 13,178 | 1 | 0.00 | 0 | 0 |
| csharp-api | Token Forge | 8 | 14,031 | 18 | 11,441 | 0 | 0.00 | 0 | 0 |
| dart-cli | Native | 13 | 19,282 | 92 | 5,922 | 0 | 0.00 | 0 | 0 |
| dart-cli | Token Forge | 10 | 12,806 | 16 | 2,756 | 0 | 0.00 | 0 | 0 |
| elixir-app | Native | 14 | 19,004 | 16 | 3,860 | 0 | 0.00 | 0 | 0 |
| elixir-app | Token Forge | 8 | 12,522 | 26 | 1,430 | 0 | 0.00 | 0 | 0 |
| fsharp-cli | Native | 18 | 19,639 | 91 | 5,414 | 0 | 0.00 | 0 | 0 |
| fsharp-cli | Token Forge | 10 | 13,157 | 16 | 4,344 | 0 | 0.00 | 0 | 0 |
| go-api | Native | 11 | 17,583 | 2,606 | 90,870 | 0 | 0.51 | 0 | 0 |
| go-api | Token Forge | 10 | 11,625 | 1,630 | 63,376 | 5 | 0.50 | 0 | 0 |
| go-feature | Native | 16 | 18,498 | 2,799 | 101,944 | 3 | 0.39 | 0 | 0 |
| go-feature | Token Forge | 12 | 12,546 | 1,878 | 59,462 | 7 | 0.54 | 0 | 0 |
| go-mock-api | Native | 12 | 19,530 | 34 | 4,024 | 1 | 0.00 | 0 | 0 |
| go-mock-api | Token Forge | 6 | 13,046 | 24 | 2,060 | 0 | 0.00 | 0 | 0 |
| haskell-cli | Native | 14 | 19,584 | 103 | 10,042 | 0 | 0.00 | 0 | 0 |
| haskell-cli | Token Forge | 9 | 13,102 | 18 | 3,626 | 0 | 0.00 | 0 | 0 |
| java-http | Native | 16 | 19,087 | 52 | 4,713 | 0 | 0.00 | 0 | 0 |
| java-http | Token Forge | 8 | 12,604 | 14 | 3,002 | 0 | 0.00 | 0 | 0 |
| kotlin-cli | Native | 12 | 19,882 | 10 | 3,676 | 0 | 0.00 | 0 | 0 |
| kotlin-cli | Token Forge | 9 | 13,395 | 6 | 3,148 | 0 | 0.00 | 0 | 0 |
| lua-cli | Native | 16 | 20,056 | 9 | 8,438 | 0 | 0.00 | 0 | 0 |
| lua-cli | Token Forge | 10 | 13,577 | 14 | 3,832 | 0 | 0.00 | 0 | 0 |
| luau-inventory | Native | 8 | 19,886 | 34 | 1,206 | 0 | 0.00 | 0 | 0 |
| luau-inventory | Token Forge | 6 | 13,404 | 24 | 1,456 | 0 | 0.00 | 0 | 0 |
| memory-followup | Native | 8 | 17,521 | 1,322 | 60,312 | 1 | 0.57 | 0 | 0 |
| memory-followup | Token Forge | 6 | 11,556 | 919 | 33,990 | 4 | 0.94 | 0 | 0 |
| node-ssg | Native | 8 | 20,356 | 22 | 2,086 | 0 | 0.00 | 0 | 0 |
| node-ssg | Token Forge | 6 | 13,866 | 12 | 1,603 | 0 | 0.00 | 0 | 0 |
| ocaml-cli | Native | 12 | 19,820 | 11 | 2,512 | 0 | 0.00 | 0 | 0 |
| ocaml-cli | Token Forge | 7 | 13,332 | 42 | 1,358 | 0 | 0.00 | 0 | 0 |
| paper-proofread | Native | 7 | 16,816 | 934 | 52,070 | 0 | 0.80 | 0 | 0 |
| paper-proofread | Token Forge | 7 | 10,334 | 851 | 52,646 | 0 | n/a | 0 | 0 |
| pdf-paper-qa | Native | 4 | 16,580 | 16 | 1,749 | 0 | 1.00 | 0 | 0 |
| pdf-paper-qa | Token Forge | 4 | 10,100 | 17 | 1,494 | 0 | 1.00 | 0 | 0 |
| perl-cli | Native | 13 | 19,759 | 72 | 6,302 | 0 | 0.00 | 0 | 0 |
| perl-cli | Token Forge | 7 | 13,280 | 0 | 2,695 | 0 | n/a | 0 | 0 |
| php-api | Native | 20 | 19,389 | 40 | 6,461 | 0 | 0.00 | 0 | 0 |
| php-api | Token Forge | 10 | 12,907 | 34 | 3,748 | 0 | 0.00 | 0 | 0 |
| pr-review | Native | 7 | 16,682 | 1,059 | 40,580 | 0 | 0.41 | 0 | 0 |
| pr-review | Token Forge | 8 | 10,759 | 499 | 33,741 | 1 | 0.60 | 0 | 0 |
| python-cli | Native | 10 | 19,524 | 8 | 3,261 | 0 | 0.00 | 0 | 0 |
| python-cli | Token Forge | 6 | 13,042 | 91 | 3,776 | 0 | 0.00 | 0 | 0 |
| r-cli | Native | 12 | 20,182 | 13 | 4,114 | 0 | 0.00 | 0 | 0 |
| r-cli | Token Forge | 8 | 13,698 | 12 | 3,460 | 0 | 0.00 | 0 | 0 |
| refactor | Native | 10 | 16,813 | 1,761 | 61,159 | 0 | 0.51 | 0 | 0 |
| refactor | Token Forge | 10 | 11,830 | 1,122 | 36,036 | 6 | 0.63 | 0 | 0 |
| rust-cli | Native | 18 | 18,351 | 3,844 | 127,181 | 1 | 0.49 | 0 | 0 |
| rust-cli | Token Forge | 14 | 13,366 | 2,884 | 90,126 | 8 | 0.70 | 0 | 0 |
| rust-debug | Native | 8 | 16,914 | 490 | 20,454 | 1 | 0.60 | 0 | 0 |
| rust-debug | Token Forge | 6 | 11,926 | 353 | 11,807 | 2 | 0.40 | 0 | 0 |
| rust-tui | Native | 16 | 19,914 | 94 | 8,132 | 2 | 0.00 | 0 | 0 |
| rust-tui | Token Forge | 7 | 13,432 | 64 | 3,061 | 1 | 0.00 | 0 | 0 |
| swift-cli | Native | 12 | 19,259 | 9 | 8,906 | 0 | 0.00 | 0 | 0 |
| swift-cli | Token Forge | 7 | 12,772 | 16 | 7,318 | 0 | 0.00 | 0 | 0 |
| ts-lib | Native | 10 | 20,362 | 14 | 6,886 | 0 | 0.00 | 0 | 0 |
| ts-lib | Token Forge | 6 | 13,884 | 13 | 1,321 | 0 | 0.00 | 0 | 0 |
| vite-landing | Native | 12 | 18,716 | 51 | 3,618 | 0 | 0.00 | 0 | 0 |
| vite-landing | Token Forge | 4 | 12,238 | 9 | 908 | 0 | 0.00 | 0 | 0 |
| zig-cli | Native | 18 | 19,240 | 250 | 17,510 | 0 | 0.00 | 0 | 0 |
| zig-cli | Token Forge | 12 | 12,752 | 158 | 10,728 | 0 | 0.00 | 0 | 0 |

Context precision is approximate: the share of files read that match the task's `relevant_files` globs. Files read via `cat`/`sed`/`head` in Bash are detected heuristically.

## Validation

- contaminated or invalid runs: none
- isolation problems: none
- missing telemetry: ['architecture-native-r1', 'cross-module-debug-native-r1', 'rust-debug-native-r1', 'pr-review-native-r1', 'go-feature-native-r1', 'banking-transfers-native-r1']
- repo commit mismatch: none
- prompt hash mismatch: none
- missing evaluation: none
- api models: {'claude-opus-5-5': 214}
- runs with other models: none
- cost not reconciled: none
- cost reconciled runs: 214

## Statistical conclusion

_Filled in from the numbers above after the full run; see `ANALYSIS` section if present._

