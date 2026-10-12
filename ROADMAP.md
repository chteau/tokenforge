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
5. **Profile the system.** CPU, memory, I/O, hook time, worker startup and index cost. Optimize only confirmed bottlenecks.

## P0: Every result names the version that produced it

Today every benchmark run records the TokenForge and Claude Code versions, and the environment a hash of the plugin files. The README, the reports and the site name them under every figure: the headline results come from 0.7.0 (34 tasks) and 0.8.0 (2 tasks) runs on Claude Code 2.1.293. Each run's manifest also records the plugin build hash.

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

## P1: Benchmark 0.9.1 properly

Today the headline results are 83 runs of 0.8.0 over 36 tasks, mostly one run per side. The 0.9.0 planning-line A/B is paired, with 95% intervals, one run per task on each side.

- [ ] Regenerate a full report from 0.9.1 runs only.
- [ ] Keep per-task comparisons, not only aggregates.
- [ ] 3 to 5 repetitions on representative tasks.
- [ ] Separate the first call, a warm cache, an expired cache and a resume after `/clear`.
- [ ] Analyze quality regressions and the tasks that cost more.
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

Today the `forge` skill works inline below about 5 files.

- [ ] Pick the strategy from the estimated number of files, the coupling between modules, the planning cost, the verification and integration cost, the size of the starting context and the risk of conflicts between workers.

The goal is the cheapest setup for the actual task, not workers by default.

## P2: Lean levels: measure the whole cost

`balanced`, `max` and `ultra` hide tools: `max` and `ultra` hide skills and subagents, `ultra` also the native Read, Edit and Write, and asks for edits through `tkit edit`. If `ultra` saves tool definitions but causes more Bash calls, quoting errors or failed edits, the saving can vanish.

Today each level's fixed context per request is measured.

- [ ] A report per level: tokens, cost, quality, time, attempts and regressions, not only the starting context.

## P2: Smaller code reads

With lean `ultra` and the proxy, 6 benchmark tasks save a median 57% of tokens (0.9.2 development builds dc3cea66, ef3ee560 and 0ee08a19 on Claude Code 2.1.296: 9 runs per task against 4 native runs, quality unchanged). Most of what is left is code read through Bash: in 18 runs, `cat` returned 345k characters and `sed -n` 229k, read again on every later call until pruned. Architecture and banking-transfers sit at 55-59%; 3 more points on each would put the median past 60%.

Replay of the 90 recorded ultra + proxy sessions (`node bench/scripts/read-replay.mjs --lean ultra`): `cat` is 64% of all tool-result characters and `sed -n` 23%, but most reads are short: only 82 `cat` and 22 `sed -n` results exceed 4k characters (11% and 3% of the total). After an edit of a file, 174 earlier reads of it (464k characters) were never used again yet re-sent with every later request.

- [x] Replay the recorded commands (no API calls): which `cat` and `sed -n` outputs are long enough to fold, and how often the model reads the same lines again after a fold.
- [x] Fold `sed -n` ranges only where the replay shows no re-read. Decided against: 22 ranges over 4k in 90 sessions, 3% of tool-result characters, and 5% of them read again.
- [x] Prune a file's earlier reads once a later read or an edit of the same file supersedes them. Within a turn too (one `claude -p` session is one turn): a read of a file edited since goes once the model has not touched the file for 6 calls. Replayed, that removes 5.6% of what reads re-send, and no file was edited again without being read first; at 4 calls it would be 7.0%, with 4 such edits.
- [ ] Measure the change on the benchmark tasks (needs API runs).

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
