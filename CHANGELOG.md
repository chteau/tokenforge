# Changelog

## 0.7.0

Token use, measured with `bench/` (clean Claude Code vs tokenforge only, Opus 5.5). 0.6.0 used more tokens than plain Claude Code on 5 of 6 tasks. Traces showed why: tool results are 80–95% of context growth, every result is re-read on every later call, and the 0.6.0 hooks added extra round trips.

- Lean tools (`tforge lean`, `/tokenforge:lean`, dashboard Settings) hide tools and skills a coding session rarely needs. Every request carries every enabled tool's definition. Measured fixed context per request: off 16.9k, `on` 11.9k (agent-orchestration tools), **`balanced` 9.7k, the default** (also Claude Code's built-in skills, marked `user-invocable-only` so they stay typeable), `max` 5.8k (also Skill, subagents, web tools, git instructions), `ultra` 4.4k (also Read/Edit/Write; Bash does file work). tokenforge applies `balanced` once on first start, with a notice to the user, and never over a level the user chose (`TFORGE_LEAN_DEFAULT` overrides it). It writes only its own `permissions.deny`, `skillOverrides` and `includeGitInstructions` entries, and `off` removes exactly those. Benchmark against clean Claude Code: default median −40% (7/7 tasks cheaper), `ultra` median −44%.
- Broad `cat` dumps (12k+ characters) go through `tview`: small files and short definitions print in full, and bodies longer than 8 lines fold to their signature plus the exact `sed -n a,bp` command that prints them. Focused reads print unchanged, because folding the file being worked on only costs a fetch-back call. Folding works in any language: tmap's parser for Rust/TS/JS/Python/Go, and an indentation-based fallback for everything else (Luau/Lua, Ruby, Java, C#, Kotlin, C/C++, PHP...). Lines over 400 characters (minified, generated, serialized) are cut to their first 200 plus the command for the rest. Output is byte-identical to `cat` when nothing folds. Tune it with `TFORGE_VIEW_FOLD` / `TFORGE_VIEW_LINES` / `TFORGE_VIEW_CHARS`.
- Session context is about 640 characters (was about 3,070): one-line terse rule, two-line policy. The prompt router (`TFORGE_KIT_PROMPT=1`) and context-budget notes to the model (`TFORGE_WATCH_INJECT=1`) are now opt-in. The router labelled feature work as DEBUG, and the over-budget note told unattended sessions to stop. `handoff` and `meter` no longer appear in the model's skill list.
- Dashboard: a Settings page (health: sessions running without tokenforge or with an older build, hooks of removed plugins still firing; lean level; which built-in skills Claude may use; terse), a one-line health banner on the overview, and a per-session "Where the tokens went" table (tool results ranked by size × later re-reads).
- README charts (`docs/img/`, drawn from raw runs by `bench/scripts/charts.py`).
- `bench/`: reproducible A/B benchmark against clean Claude Code (sandboxed sessions, 10 tasks with hidden tests, exact token telemetry). See `bench/README.md`.
- Memory: `tforge recall <words>` searches a project's past sessions (prompts, commits, files edited and read, last reply), indexed incrementally from Claude Code transcripts into `~/.cache/tokenforge/memory/`. Session start now adds a one-line hint pointing to it instead of loading the two newest snapshots, which were re-read on every call (`TFORGE_RECALL=inject` restores that). The dashboard's Memory page shows sessions, files and keywords as a graph, with search.
- `tread NAME Type.method path:40-80 "path:/regex/"`: reads definitions by name (code index, with a fallback for languages tmap doesn't parse), line ranges and the definition around each regex match, across files, in one call. The policy no longer tells Claude to grep and then sed, which had added about two round trips per session.
- Repeated questions: asking again what an earlier turn already answered (and that turn changed no files) shows you the earlier answer without calling the model; send it again to ask Claude. Similar questions get the earlier answer as a one-line hint. `TFORGE_ANSWER_CACHE=0` turns it off.
- Scope rules ("lazy, not negligent", adapted from ponytail): every stated requirement and nothing extra, reuse existing code, concise but readable code, fix shared code once, infer instead of asking, stop when checks pass. On by default; `TFORGE_LAZY=0` turns them off.
- Inline edit scripts and JSON scripts are no longer refused. One script per file is cheaper than a chain of `Edit` calls, each of which re-reads the whole context.
- Rewrites never use `ask`. A prompt appeared on every rewrite interactively, and in headless runs the command was denied and then retried. A command is rewritten only when every segment is a tkit/tview call or a read-only command, or the session already bypasses permissions; otherwise it runs unchanged. Commands with a heredoc are never touched.
- Reading back a large spilled Bash output (`tool-results/*.txt`) whole is refused once, with a pointer to `grep -n` / `sed -n`.
- The session policy now lists four efficiency rules (read narrowly, batch, compact output, verify once) instead of advertising tkit tools.

## 0.6.0

- `tkit` / `tmap kit`: token-surgeon's tools ported to Rust and built into the tmap binary (one download, no bash or python needed, Linux, macOS and Windows).
  - Context: `diff`, `debug`, `analog`, `ctx`, `patch`, `distill`. CodeGraph lookups now use the tmap index.
  - Code, for 15 stacks: `proj`, `check`, `test`, `deps`, `fmt`.
  - Utilities: `edit`, `jx`, `tab`, `tally`, `img`, `http`, `port`, `ssh`, `web`.
  - `edit -t` rolls the edits back when the test fails (`--keep` to leave them).
- tkit hooks, ported from token-surgeon and on by default (`TFORGE_KIT_HOOKS=0` turns all off): a three-line tkit policy at session and subagent start; a Bash router that rewrites raw build/test, `ssh HOST CMD` and `scp` to tkit and refuses interactive ssh, inline edit scripts, JSON rewrite scripts and registry reads (escape: `TFORGE_RAW=1` or repeat the call); a prompt router that pre-loads review/debug/write/inspect context with tkit; and MCP results over 6 KB distilled by Haiku.
- `TFORGE_REDIRECT=1` also answers Bash greps for one code identifier from the index.
- tmap 0.3.0. Closed pipes (`| head`) no longer panic.
- Dashboard: "Tokens saved by tkit" on the overview (per day and per tool). Each tkit call logs the raw output it read for the model and what it printed to `~/.cache/tokenforge/savings.jsonl`.
- Session snapshots replace `.forge/SESSION.md`: chunks in `.forge/snapshots/` (6 requests each, closed at compaction), the newest two reloaded after `/clear`, listed and readable on the dashboard's project page.

## 0.5.0

- Dashboard redesign: sidebar layout, Claude warm-dark palette (validated for color-blind safety on the card surface), square corners, KPI cards, arc gauges, gradient area charts, thin-bar window strip.
- Code graph replaces the treemap: force-directed folders and files on canvas (Barnes-Hut layout, about 1.5k nodes live), colored by language, glow, pan, zoom and drag, neighbor highlight, optional call links, filter, and a details panel with callers, callees and the file outline.

## 0.4.0

- Local dashboard (`tforge ui`, `/tokenforge:dashboard`); it starts in the background with the first session.
  - Overview: usage limits with reset countdowns, today/7-day/30-day totals, daily chart by token type, last 48 hours, 5-hour windows, models.
  - Projects and sessions, including the context-per-call curve.
  - Code map: two-level treemap shaded by incoming calls, keyword search, most depended-on files.
- Incremental transcript reader: 4.2 GB first scan in about 20s, then about 70 ms per refresh. Numbers only.
- `tforge statusline --setup`: a recorder for the real `rate_limits` (5-hour and weekly usage and reset times) that keeps your status line running behind it. It prints the settings snippet instead of editing your settings.
- `tmap json`. Call edges ignore method calls (`x.foo()`), macro-vs-function name clashes, nested helper functions and non-callable symbols. On a large Rust workspace this removed false hubs (`assert_eq!` and `.child()` were resolving to unrelated files).

## 0.3.0

- `tmap`: a bundled Rust code indexer (tree-sitter; Rust, TS/TSX, JS, Python, Go) with an incremental cache.
  - Commands: `find` (ranked one-line hits), `tree` (map or outline), `sym`, `callers`, `callees`, `slice`.
  - On a 1,228-file workspace: 0.9s to index from scratch, about 25 ms per command.
  - The launcher downloads a checksum-verified release binary, or builds once with cargo.
- `forge` skill uses `tmap` to give workers exact line ranges.
- Opt-in `TFORGE_MAP=1` (session hint) and `TFORGE_REDIRECT=1` (answer identifier Grep calls and big whole-file reads from the index). They are opt-in because A/B runs showed no reliable saving in normal sessions.
- CI runs the Rust tests. Pushing a `tmap-v*` tag publishes binaries for five platforms.

## 0.2.0

- Terse reply mode built in (`/tokenforge:terse full|lite|off`, `tforge terse`). One rule of about 200 tokens at session start and after compaction, nothing per prompt. In tests it matched or beat caveman 3.1.0 on output length with one-sixth of its fixed context.
- Workers: `effort` (default `low`, `high` on the escalation attempt) and `thinking` (`auto` turns it off for haiku tasks, which halved their output in tests).
- `reads` and `files` accept line ranges (`src/a.rs:120-260`), so planners hand workers exact slices instead of letting them explore.
- Failure output drops compiler warning blocks when errors exist.
- Fixed false "stray file" reports between parallel workers.
- `forge` skill: an existing-codebase mode, and a measured rule for when forge pays off.

## 0.1.0

- `tforge` driver: runs a `.forge/plan.json` of tasks in fresh, minimal Claude Code workers (no hooks, plugins, MCP or skills; 3 tools). Shared context sits in a cached system prompt. Tests decide when a task is done; failures retry with condensed output and escalate the model on the last attempt; a final check runs integration workers.
- `tforge run --detach` / `tforge wait`: long runs without tool-call timeouts.
- `tforge meter`: per-session token usage from transcripts (calls, average and peak context, cache, output, price-weighted total) plus worker spend.
- Skills: `forge` (plan and run), `handoff` (save state before `/clear`), `meter`.
- Hooks: context-growth warning; reload `.forge/HANDOFF.md` after `/clear`.
