# Changelog

## 0.9.2

Correctness: a safer answer cache, versioned benchmark figures, memory that survives resume and compaction, and subagent work in snapshots. This replaces a first 0.9.2 attempt that was reverted (be6a5c1): its hooks were never registered, its libraries were never called, and its changelog described work that was not there.

- Answer cache: only information questions are replayed. A request to run, test, build, verify or deploy, a security question, or a question about the current state ("is it up", "latest", "now", "statut", "en ce moment") always goes to Claude, in English and French; when unsure, it asks Claude.
- Answer cache: a replayed answer must come from the same repository (path and remotes), branch and commit, working tree contents, dependency manifests and lockfiles, terse level and, when known, model. Changes are found by content, not modification time, so same-second edits, renames, deletions and branch switches count. Answers recorded before 0.9.2 are not replayed.
- `!nocache` as the first or last word of a prompt sends it to Claude without looking for an earlier answer.
- French fresh-look words starting with an accent ("vérifie", "à froid") never matched; they do now.
- Bench reports and charts name the TokenForge version, build hash and Claude Code version under every table and figure. A report or chart that mixes versions or builds is refused with the list found; `--mixed-versions` builds it with each row or series labelled. The published benchmark-report.json mixes 3 builds, so rebuilding it needs that flag.
- README: each benchmark figure names the tokenforge and Claude Code versions it was measured with. No figure changed.
- `tforge version` prints the version and the plugin build hash that benchmark runs record (`--json`).
- Resume: SessionStart now also runs on resume. Claude Code keeps the earlier session-start text in the transcript, so the rules are not sent again; only what changed while the session was away is: a newer handoff, a changed state file, or another session's work in this project since.
- Compaction: this session's own compact checkpoint is reloaded after a compaction (before, the newest snapshots of any session).
- `reloadOn` (`TFORGE_RELOAD_ON`) chooses which of `compact` and `resume` reload anything. Default: both.
- Snapshots include subagents. Claude Code writes each subagent's transcript separately, and tokenforge skipped them, though in delegating sessions most tokens are spent there. Each chunk now lists the agents it ran (type, task, files changed, commands, report), the main transcript's sidechain edits count as changed files, and the checkpoint and automatic handoff carry the newest agent lines.
- Automatic handoffs are no longer deleted at the first snapshot of a later session, nor ignored after 72 hours. One is moved to `.forge/handoffs/` (newest 10 kept) once a session that was given it has saved a snapshot of its own, or after 14 days (`TFORGE_HANDOFF_MAX_AGE_H`, now 336). A resumed session is not given its own handoff back.
- `stateFiles` (`TFORGE_STATE_FILES`): globs of files a skill keeps its state in (a review register). Those changed in the last 72 hours are loaded at startup, `/clear` and compaction (8000 characters each, 16000 in all), and on resume when changed since; the generic checkpoint is then left out. Never in subagents.
- An agent with its own definition (a plugin's or your own, not a built-in one) no longer gets the scope, "infer instead of asking" or planning rules, which contradicted agents such as SpecAudit's arbiters. Its definition decides.
- `subagentSkip` (`TFORGE_SUBAGENT_SKIP`): agent types, with `*` wildcards (`spec-audit:*`), that tokenforge leaves alone: no policy, instruction files, Bash router, code redirect, MCP distill or budget notes.
- `leanKeep` (`TFORGE_LEAN_KEEP`): tools lean levels never deny. A rule tokenforge already added for a kept tool is lifted at the next start; `tforge lean status` still reports the level.
- Reloaded snapshots and checkpoints say they are a record of earlier turns, not instructions.
- docs/external-audit-2026-10.md: what ContextForge and icm-graph-context-flow do and what is worth taking. icm-graph-context-flow is not software: it runs base64-decoded secrets every hour and its README borrows the TokenForge name with a `curl | bash` install. Don't use it.

## 0.9.1

- Context alert: your next message gets it once the context passes the budget, then again each time the context doubles, instead of every 10k tokens and after tool calls (a 700k-token session got over 60). Shorter. A session started on 0.7.0–0.7.2 keeps that version's blocking alert ("A hook blocked your prompt") until it ends: after updating, start a new session.
- `tforge gc` on macOS: a session's scratch that a process works in is found with `lsof` (there is no `/proc`); when that can't be told, no scratch is removed.

## 0.9.0

Disk cleanup, instruction files for every agent, a planning line, leaner shell output, SpecAudit compatibility.

- `tforge gc [--dry-run] [--json]` frees disk by rules, with no model call. Claude Code never deletes the per-session scratch in `/tmp/claude-<uid>/`, which filled disks until transcript writes failed (ENOSPC). gc removes the scratch of ended sessions (a session is live while Claude Code's registry lists its process, a process works inside its scratch, or its transcript changed recently), tokenforge's own leftovers, snapshot chunks no longer relevant and used-up automatic handoffs. It runs in the background at most every 6 h (every 10 min on a nearly full disk), never in unattended sessions. Off: `TFORGE_GC=0`.
- Snapshots are kept by use, not simply the last 50: a chunk's score counts its writing and every later read, decaying with time (ACT-R base-level activation), and is lowered when its files are gone or a later chunk changed most of them. The newest 6 always stay; at most 50.
- An automatic handoff is deleted once a later session has loaded it, or after 72 hours, instead of being reloaded into every new session for three days.
- Instruction files: sessions, subagents and tforge workers get the `AGENTS.md`/`CLAUDE.md` text Claude Code leaves out (an `AGENTS.md` beside a `CLAUDE.md`, the file a pointer `CLAUDE.md` names, nested files in directories a tool call reaches), compacted, without repeating what is already loaded, and cached by file size and mtime. Follows the `instructionFiles` setting; Explore and Plan get none. Off: `TFORGE_INSTRUCTIONS=0`.
- `tkit eval py|js|sh` (tmap 0.5.0) runs throwaway code from stdin and leaves no files: in a bwrap sandbox on Linux (read-only files, private `/tmp`), elsewhere in a temp dir removed after. The policy points to it instead of scratch files.
- Bash router: a `grep`/`rg` that prints lines goes through `tkit run --group` (each path once, long lines cut, 200-line cap with the full output saved; recursive `grep` skips `.git`, `node_modules` and the like); `gh run view --log` through `tkit run --fuzzy`.
- `tkit run CMD` (tmap 0.5.0) runs any command with compact output: colours and progress bars stripped, repeated lines collapsed, capped, the full log saved to a file. `tkit batch "a" "b" …` runs independent commands in one call, each output compacted and labelled. `tkit test --failed` reruns only what failed last time (Rust, Python).
- Bash router routes more commands: a bare `git status`/`git log` becomes one line per item; package installs, `cargo build`, `docker`/`kubectl` logs and `journalctl` go through `tkit run`; recursive `ls`, `tree` and `find` are capped at 150 lines and `git diff`/`git show` get one line of context and a 300-line cap, with the full output saved; a plain `curl` goes through `tkit http`; a command that would stop to ask a question (`npm init`, `apt install` without `-y`) is refused with its non-interactive form; plain one-line PowerShell commands are routed too. `TFORGE_CAP_ALL=1` caps the output of any other plain command.
- Whole-file Reads of lockfiles, minified bundles, source maps and build output are refused once.
- `tforge meter --commands` ranks Bash commands by what their results cost, to pick what to route next.
- Dashboard: a "Skills and MCP servers" card shows skill descriptions over 120 tokens and skills or MCP servers unused in 30 days, all re-sent on every request.
- Snapshots hold one node per request: what it changed, read, searched, ran (shell commands included) and concluded.
- `tread` logs what it saved (the whole file vs what it printed) in the savings ledger, counted on the dashboard.
- No more refusals of Bash reads in favour of `tread` (`TFORGE_TOOLS_FIRST`), `cat > file <<EOF` writes, python edit scripts or greps for a definition: each refusal cost a round trip that re-read the whole context, often more than it saved.
- Dashboard: a command's cost goes to the command doing the work (`cd x && FOO=1 timeout 60 cargo test -p a` is `cargo test`, a `for` loop is its body).
- Lean levels also set when 1M-context sessions compact (`autoCompactWindow`): 400k tokens for `on`/`balanced`, 300k for `max`, 200k for `ultra`, instead of near 1M. Replaying 14 days of sessions, 400k cut main-session input 40% and subagents' 17% (one compaction per ~340 calls). A value you set stays; existing installs get it once, with a notice.
- Bash router: where the prompt cache lives 5 minutes (subagents), a polling loop that only sleeps and reads gets at most 4 minutes instead of up to 10. A longer wait let the cache expire, and the next call rewrote the whole context: 394 such waits cost 112M input-equivalent tokens in 14 days. Builds, tests and background commands keep their timeout.
- `tkit test` runs a `node --test` test script with its own files and flags (tmap 0.5.0): bare `node --test` took every file under `test/` for a test, helpers and fixtures too, and could hang until its 15-minute timeout. A test script that does more than run node goes through `npm test`.
- tmap 0.5.0, so binaries cached for 0.4.0 are not reused.
- Tests run in a private temp dir, with the automatic gc off.
- Works with [SpecAudit](https://github.com/magicmoux/SpecAudit) and other skill plugins that bring their own workflow: the policy gives way to a skill or agent definition being followed (its output format, whole-document reads, scripts it keeps, checks it re-runs, questions it asks). They need the Skill and subagent tools, so `balanced`, not `max`/`ultra`.
- Prompt router (opt-in): no code-mode context for document work (a manuscript, paper, proof or spec, a `.md`/`.tex`/`.pdf` file) unless the prompt also names a PR or a code file.
- `cat` of a document (`.md`, `.tex`, `.txt`, `.rst`, …) no longer cuts lines over 400 characters, often one paragraph each; HTML, CSV, TSV and RTF still are.
- `.forge/.gitignore` also ignores itself and `HANDOFF.md`: a `.forge` holding only automatic files stays out of `git status` and `git add -A`, and no longer makes `git worktree remove` refuse (SpecAudit audits in a worktree it removes after the merge).
- Planning line in the efficiency policy, on by default in main sessions: thinking is billed as output and re-read on every later call, so look at the repo first, plan briefly and never draft code in thinking (+106 input tokens per session). A/B over 36 paired bench tasks on Claude Code 2.1.295, against the same build without it: list cost −15% per task (95% CI −21% to −10%; lower on 27 of 36), thinking −44%, wall-clock −21%, quality within noise (−0.26 points, CI −1.03 to +0.52; hidden tests 1215/1219 in both arms); nine tasks cost more, up to +26%. `TFORGE_PLAN=0` turns it off; `TFORGE_PLAN=brief` keeps the 0.8.0 line (−7% in the same A/B); subagents get a planning line only when `TFORGE_PLAN` names one. Report: `bench/reports/final-comparison.md`.
- Bench: cost at list prices per request, from the logged cache-write TTL split and the `pricing` block in `benchmark.config.json` (with its source and effective date; no prices in code), reconciled with Claude Code's own cost (0.5% tolerance). New telemetry: thinking, the first request, cache misses and idle gaps, hook time, the agent's CPU time and peak memory. `bench.py retelemetry` re-derives it from saved transcripts; `scripts/optimization.py` gives paired statistics (geometric-mean change with a 95% CI, sign test), cold vs warm, the objective J and a cost attribution. The 0.8.0 "cheaper on 36 of 36 tasks" counted tokens; at list prices TokenForge cost less on 34 of 36 (median −22%).

## 0.8.0

Academic work and automation.

- `tkit pdf FILE [--pages A-B]` (tmap 0.4.0): PDF text with page markers; refuses scanned or garbled PDFs (exit 3). Approved without a prompt. Reading PDFs as text automatically is opt-in (`TFORGE_DOCREAD_PDF=1`): measured, Claude Code's own PDF Read costs ~1.3k tokens a page, and extracted text was cheaper on plain prose (8 pages: ~7k vs 10.4k) but dearer on a table-heavy two-column paper (15 pages: 26.4k vs 19.3k), and it drops figures.
- Notebooks are read as cells: a Read (or `cat`) of a notebook over 8 KB gets its cells with outputs trimmed to 20 lines and images replaced by a placeholder.
- LaTeX builds are compacted: `tkit check` builds LaTeX projects (latexmk, tectonic or pdflatex) and prints only errors with file:line, undefined references and citations, multiply-defined labels and a box summary. Raw `pdflatex`/`latexmk` runs are routed to it.
- Status line shows the savings: `TF −45% today (~1.2M saved)`, an estimate from lean fixed context × calls, tkit output kept out of context and answer-cache hits. Set automatically once when you have no status line; next to an existing one only with `tforge statusline --setup` (wraps it). `tforge statusline --remove` restores the previous state; `TFORGE_STATUSLINE=0` disables the automatic setup. Same estimate on the dashboard overview.

## 0.7.3

- Context budget: prompts are never held any more. Over the budget you get one non-blocking alert per 10k step, and `.forge/HANDOFF.md` is written automatically from the session's snapshots (no model call), so `/clear` loses nothing. A handoff you wrote is never overwritten. `TFORGE_AUTO_HANDOFF=0` turns it off.
- Proofreading and reviews are never weakened:
  - Documents (`.md`, `.tex`, `.txt`, `.rst`, `.bib`, `.html`, `.csv`…) are never folded when read with `cat`.
  - Terse replies keep any list the user asked for (findings, errors, review points) complete.
  - The answer cache never replays an answer to a review/verify/proofread request ("relis", "vérifie", "sans contexte", "from scratch"…), nor any answer when project files changed since.
  - The session policy only discourages re-running checks to double-check, not re-reading.

## 0.7.2

- After `/clear` without a fresh handoff, a compact checkpoint (last two requests, files changed, start of the last reply; ≤ 900 characters) is reloaded. `TFORGE_CLEAR_RELOAD=0` turns it off.
- Daily background update check: the banner says when a newer version is out and how to update. `TFORGE_UPDATE_CHECK=0` turns it off.
- In accept-edits sessions, `tkit edit`/`patch`/`fmt` are approved too (one batched edit call instead of several Edit calls).

## 0.7.1

Works on its own, in the terminal and in Claude Desktop:

- "TokenForge: active" at the start of every session (lean level, reply style, dashboard address), with a three-line walkthrough for the first three sessions. Shown to the user only, zero tokens. `TFORGE_BANNER=0` hides it.
- After `/clear`: "TokenForge: checkpoint saved (… ago)", and whether the handoff was reloaded.
- TokenForge's own read-only tools (`tread`, `tview`, `tkit ctx/diff/debug/deps/check/test`, `tforge recall`) are approved without a permission prompt, also when chained with read-only commands. Edits, network and remote tools still ask. Before, every lookup by name asked, so Claude fell back to `cat`/`sed`. `TFORGE_AUTO_ALLOW=0` turns it off.
- Dependency source: only whole-file dumps are refused; a focused `grep`/`sed -n`/`head` (often inside a batch) goes through instead of failing the batch.
- Windows: the dashboard failed to start (plugin folder resolved with `URL.pathname`). CI now smoke-tests Windows.
- The dashboard no longer auto-starts in headless sessions (`claude -p`, SDK, CI).
- Experimental, off by default: `TFORGE_PLAN=brief` (shorter upfront planning). Measured mixed: −22% and −28% on two write-heavy tasks, +13% and +15% on two others, one small quality drop.

## 0.7.0

Token use, measured with `bench/` (clean Claude Code vs tokenforge only, Opus 5.5). 0.6.0 used more tokens than plain Claude Code on 5 of 6 tasks. Traces showed why: tool results are 80–95% of context growth, every result is re-read on every later call, and the 0.6.0 hooks added extra round trips.

- Lean tools (`tforge lean`, `/tokenforge:lean`, dashboard Settings) hide tools and skills a coding session rarely needs. Every request carries every enabled tool's definition. Measured fixed context per request: off 16.9k, `on` 11.9k (agent-orchestration tools), **`balanced` 9.7k, the default** (also Claude Code's built-in skills, marked `user-invocable-only` so they stay typeable), `max` 5.8k (also Skill, subagents, web tools, git instructions), `ultra` 4.4k (also Read/Edit/Write; Bash does file work). tokenforge applies `balanced` once on first start, with a notice to the user, and never over a level the user chose (`TFORGE_LEAN_DEFAULT` overrides it). It writes only its own `permissions.deny`, `skillOverrides` and `includeGitInstructions` entries, and `off` removes exactly those. Benchmark against clean Claude Code (Opus 5.5, 36 tasks incl. 24 from-scratch projects in 23 languages and 2 academic tasks): default median −52%, cheaper on 36/36 tasks.
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
