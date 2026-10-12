# Roadmap

Updated 2026-10-12.

0.9.2 makes the savings safe and checkable: a cache reuses an answer only while it still holds, a rewritten command behaves like the original, and every published number names the version that produced it.

This plan follows an external review of the public repo. The review read the docs and the benchmark method, not the code or the test suite.

## Rules

- **Prefer a missed reuse to a wrong one.** A cache that skips a reusable answer costs tokens. One that replays a stale answer, or skips a check that was needed, costs correctness.
- **Optimize how output is shown, never what a command does.**
- **One validity policy for every cache**, with rules for each kind of artifact, not one algorithm for all.
- **Measure each optimization on its own.**

## 0.9.2, in order

1. **Validate 0.9.1 on real data.** Regenerate the reports from 0.9.1 runs, check the version each run recorded, fix any page that mixes versions.
2. **Audit the answer cache and cache invalidation.** Adversarial tests, a visible bypass, freshness checks.
3. **Differential tests for the Bash router and `tkit`.** Exit codes, cut logs and rewritten commands first.
4. **Benchmark lean levels and orchestration strategies.** Find where each one really wins, instead of tuning one scenario.
   Lean levels measured 2026-10-12 (below, P2 Lean levels). Orchestration strategies are not benchmarked yet.
5. **Profile the system.** CPU, memory, I/O, hook time, worker startup and index cost. Optimize only confirmed bottlenecks.
   Profiled 2026-10-12 (`node bench/scripts/profile.mjs`, no API calls): each hook takes 31-60 ms, of which 22 ms is Node starting, so a tool call gets about 75 ms (PreToolUse and PostToolUse) and a prompt about 60 ms; the `tmap` index of this repo takes 168 ms cold and 14 ms warm; the proxy spends 1 ms on a 40-message request, 50 ms at 1,000 tool calls and 290 ms at 3,000 (9 MB). Against model calls of several seconds none of these is a bottleneck, so nothing was optimized.

## P0: Every result names the version that produced it

Today every benchmark run records the TokenForge and Claude Code versions, and the environment a hash of the plugin files. The README, the reports and the site name them under every figure: the headline results come from 0.9.2 runs (build 3af1944f, git 3a44e31f) on Claude Code 2.1.296, 37 tasks. Each run's manifest also records the plugin build hash. The README charts draw only runs on the Claude Code version under test.

- [x] Show the TokenForge version, build hash and Claude Code version next to every published figure: site, README, reports.
- [x] Refuse to build a report from runs of different versions, unless it labels each one.

## P0: A safer answer cache

An unchanged project does not prove an answer still holds. "Do the tests pass?" asked again after a dependency or environment change is the same text, and may need a different answer.

Today an earlier answer is replayed only for the same question, from a turn that edited nothing, when no project file (tracked, or untracked and not ignored) has changed since. Prompts that ask to review, verify, check or audit (English and French) skip it. Sending the message again asks Claude; `TFORGE_ANSWER_CACHE=0` turns it off.

- [x] Never replay an answer to a request to run, test, build or verify something, to a security question, or to a question about the current state ("is it up", "latest", "now").
- [x] Tell questions that ask for information from requests that need an action or a fresh observation. When unsure, ask Claude.
- [x] Include the repo's identity, the model, the configuration and the relevant dependencies in the cache's validity, where they affect the answer.
- [x] An explicit, visible bypass that works before sending, not only by sending again.
- [x] Adversarial tests for false positives: the same words with another intent, other languages, a changed environment with unchanged files.

## P0: Formal cache invalidation

The `tmap` index, compacted instructions, cross-session memory, snapshots and answers depend on different things and stay valid for different times.

Today every cache declares what it depends on (`tforge caches`) and is checked by content where correctness needs it: the answer cache compares repo, commit, file contents, dependencies, model and terse level; the `tmap` index hashes a file unless its size, times and inode are unchanged and were recorded 2 s after its last write; compacted instruction files are keyed by content. Transcript-based indexes notice a replaced file. Cache writes are atomic, with tests for same-second edits, renames, deletions, branch switches, concurrent writers and torn files.

- [x] Content hashes where correctness needs them; size and mtime only as a fast pre-check.
- [x] Each cached artifact declares what it depends on (`tforge caches`).
- [x] Tests for renames, deletions, edits within the mtime resolution, configuration changes and git branch switches.
- [x] Concurrency tests, and invalidation after an interrupted write.
- [x] Keep local computation caches, working memory and the provider's prompt cache clearly apart.

## P1: Benchmark 0.9.x properly

Today the headline results are 220 runs on Claude Code 2.1.296 over 37 tasks: 2 runs per side of 0.9.2 at its defaults on every task (3 more tokenforge runs and 9 more native runs on 6 tasks). Median −51% of tokens and −28% of list cost per task, fewer tokens and lower cost on all 37 (sign test p < 10⁻¹⁰), mean quality per task 98.6 against 98.9. The 0.9.0 planning-line A/B is paired, with 95% intervals, one run per task on each side.

Quality: tokenforge scored lower on 8 tasks, by 1 to 3 points except two. PHP ticketing lost 7: a hidden test on seat holds failed in both its runs, and in one run two more. The Vite page lost 5: one run of two failed the regression check. Of the 74 runs per side in the 2-run campaign, 10 tokenforge runs and 6 native runs were marked partial (a hidden test or a requirement missed), most by one test of 31 to 44, mostly on tasks where both sides miss (R, Zig, Java, Rust debugging). PHP ticketing and the Dart habit tracker fail only with tokenforge.

- [x] Regenerate a full report from 0.9.2 runs only.
- [x] Keep per-task comparisons, not only aggregates.
- [x] 3 to 5 repetitions on representative tasks. 3 runs per lean level and with the proxy on 6 tasks; 2 per side on the 37.
- [ ] 3 repetitions on all 37 tasks (stopped at 2 to spare the weekly usage).
- [ ] Separate the first call, a warm cache, an expired cache and a resume after `/clear`.
- [x] Analyze quality regressions and the tasks that cost more. No task costs more; regressions above.
- [ ] Find why PHP ticketing misses the seat-hold test with tokenforge only.
- [ ] Publish commit hashes, versions, configurations and raw reports.
- [ ] Paired comparisons, medians and uncertainty intervals, not a single mean.

## P1: Test command rewrites

The Bash router turns some commands into `tkit` calls or compacts their output. That saves a lot, and it is also where an optimization could change what a command does.

Today differential and property tests run each rewrite next to the original and compare exit codes, written files and output lines; `tkit test` is compared with the runner it replaces. Build and test commands are rewritten only when their flags are fully understood, heredocs are never touched, a `TFORGE_RAW=1` prefix runs a command as typed, and `TFORGE_SHOW_REWRITE` shows each rewrite.

- [x] Differential tests: run the original and the rewritten command, compare exit codes and outputs.
- [x] Property tests over quoting, pipes, redirections, substitutions, paths with spaces, environment variables and exit codes.
- [x] Check that output caps never hide an error at the end of a log, or one in the omitted middle of a failed run.
- [x] Compare `tkit test` with the native test command.
- [x] A diagnostic mode that shows the exact rewrite before it runs (`TFORGE_SHOW_REWRITE`, `tforge route`).

## P1: Harden permissions and cleanup

TokenForge touches permissions, hooks, detached processes and temporary files.

Today `tforge gc` deletes only inside real directories you own and never through a symlink. It keeps a session's scratch while Claude Code lists the session as running (a reused pid does not count), while a process works in it or holds a file open there, and for 12 hours after its last change; a victim is moved aside and checked again before it is deleted. When it can't tell (no session registry, `lsof` fails on macOS, a `/proc` that hides this process's own files), it removes no scratch. Not seen: processes of yours in another pid namespace (a container) that Claude Code's registry does not list.

Audit:

- [x] Races between a check and the deletion that follows.
- [x] Symlinks and canonical paths.
- [x] PID reuse when deciding whether a process is still alive.
- [x] File permissions and ownership.
- [ ] Every case where a process can't be detected: keep the files, as macOS does now.
- [x] The effects of the `permissions.deny` entries lean levels write to your settings.

## P1: Workers: the plan is a trust boundary

Workers can't run commands: the driver runs each task's `verify` command from the plan.

Today checks run in the project root with a time limit (`verifyTimeoutMin`, 10 minutes by default, bounded), and the limit kills the whole process tree. Sensitive tasks and `isolateChecks` run them in a throwaway worktree; elsewhere, files a check writes are reported, not undone. The docs say to read a plan before running it and to build on a branch or a worktree.

- [x] Stricter validation of `verify` commands.
- [x] Time limits and working directories enforced for every check.
- [ ] Side effects of checks isolated.
- [x] For sensitive tasks, checks run in a git worktree or a sandbox, never in the current environment without inspection.

## P2: Adaptive orchestration

Plan, split, then run disposable workers pays off on multi-file work. On a two-file change, a small fix or an investigation that needs a lot of shared context, it can cost more.

Today `tforge validate` recommends a strategy from the plan: inline for fewer than 5 files or 3 tasks, a serial chain of up to 5 tasks, or tasks that each start with most of the planned context; workers otherwise. The thresholds come from earlier measurements, not yet from a strategy benchmark.

- [x] Pick the strategy from the estimated number of files, the coupling between tasks (dependency chain, shared context) and the size of each worker's starting context.
- [ ] Add the planning, verification and integration cost and the risk of conflicts between workers, and tune the thresholds on the strategy benchmark (needs API runs).

The goal is the cheapest setup for the actual task, not workers by default.

## P2: Lean levels: measure the whole cost

`balanced`, `max` and `ultra` hide tools: `max` and `ultra` hide skills and subagents, `ultra` also the native Read, Edit and Write, and asks for edits through `tkit edit`. If `ultra` saves tool definitions but causes more Bash calls, quoting errors or failed edits, the saving can vanish.

Today each level's fixed context per request is measured, and its whole cost on 6 tasks (architecture, cross-module-debug, rust-debug, pr-review, go-feature, banking-transfers; 3 runs per level, 0.9.2 without the proxy, Claude Code 2.1.296, against 8 native runs per task):

| Level | Tokens | vs native | Quality | List cost per run |
|---|---:|---:|---:|---:|
| native | 3.93M | | 95.9 | $0.74 |
| `on` | 2.48M | −36.9% | 98.1 | $0.60 |
| `balanced` | 2.09M | −46.9% | 97.5 | $0.57 |
| `max` | 2.20M | −44.1% | 96.8 | $0.58 |
| `ultra` | 1.78M | −54.7% | 98.2 | $0.56 |

Tokens are the sum over the 6 tasks of each task's mean. `max` saves no more than `balanced`: go-feature cost more under it (−42% against −54%), and rust-debug scored 87 against 89 to 92. With 3 runs per level that may be noise.

- [x] A report per level: tokens, cost, quality, not only the starting context.
- [ ] Time, attempts and regressions per level, and more runs on `max`.

## P2: Smaller code reads

With lean `ultra` and the proxy, 6 benchmark tasks save 53.9% of tokens on one build (0.9.2 build 3af1944f on Claude Code 2.1.296, 3 runs per task against 8 native runs, quality unchanged; earlier development builds dc3cea66, ef3ee560 and 0ee08a19 gave a median 57% over 9 runs per task against 4). Without the proxy the same build saves 54.7%: on these one-prompt sessions the proxy adds nothing measurable on top of the hooks. Most of what is left is code read through Bash: in 18 runs, `cat` returned 345k characters and `sed -n` 229k, read again on every later call until pruned. Architecture and banking-transfers sit at 55-59%; 3 more points on each would put the median past 60%.

Replay of the 90 recorded ultra + proxy sessions (`node bench/scripts/read-replay.mjs --lean ultra`): `cat` is 64% of all tool-result characters and `sed -n` 23%, but most reads are short: only 82 `cat` and 22 `sed -n` results exceed 4k characters (11% and 3% of the total). After an edit of a file, 174 earlier reads of it (464k characters) were never used again yet re-sent with every later request.

- [x] Replay the recorded commands (no API calls): which `cat` and `sed -n` outputs are long enough to fold, and how often the model reads the same lines again after a fold.
- [x] Fold `sed -n` ranges only where the replay shows no re-read. Decided against: 22 ranges over 4k in 90 sessions, 3% of tool-result characters, and 5% of them read again.
- [x] Prune a file's earlier reads once a later read or an edit of the same file supersedes them. Within a turn too (one `claude -p` session is one turn): a read of a file edited since goes once the model has not touched the file for 6 calls. Replayed, that removes 5.6% of what reads re-send, and no file was edited again without being read first; at 4 calls it would be 7.0%, with 4 such edits.
- [x] Measure the change on the benchmark tasks. The current build used 1.81M tokens over the 6 tasks (sum of task means) against 2.03M for the earlier ultra + proxy builds, −11%, at the same quality; pruning is one of several changes between them, so this does not isolate it.
- [ ] Measure the proxy in long interactive sessions (expired caches, resumes), where its pruning should matter; or turn it off by default if it adds nothing there either.

## Caching

Six layers with six sets of dependencies. They share one validity policy, with rules for each layer.

| Layer | Today | Optimize for | Risk to test |
|---|---|---|---|
| Provider prompt cache | Policy and instruction text stay identical between calls | Stable prefixes and configuration, no needless prefix changes | Missed or expired cache |
| `tmap` index | Re-parses files whose content changed; stat only as a settled pre-check | Incremental index with explicit dependencies | Stale index |
| Instruction cache | Compacted text keyed by content and parser version | Reuse with reliable invalidation | File changed, cache didn't |
| Cross-session memory | `tforge recall`, on demand | On-demand retrieval with provenance | An old assumption taken as fact |
| Snapshots and handoffs | Chunks kept by use; the automatic handoff is deleted once used | Compact storage, selective retrieval | Incomplete or contradictory state |
| Answer cache | Same question; same repo, commit, file contents, dependencies, model and terse level | Reuse only while the answer still holds | Stale answer, or a check skipped |

For each cache, measure:

- the share of hits that were actually useful
- the cost to build, to invalidate, and of a miss
- the time to retrieve
- the number of stale results detected
- the cost of errors caused by a wrong reuse

A cache with 99% hits that sometimes serves a wrong answer can be worse than a more cautious one with 85%.
