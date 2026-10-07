# tokenforge

Build big things with Claude Code for a fraction of the tokens.

A long Claude Code session re-sends its whole context on every turn. A build that runs for 150 turns at an average of 80k tokens of context reads about 12M input tokens, even though the code it writes is a tiny part of that. tokenforge changes the shape of the work so that context stays small, without lowering code quality.

- **Plan once.** Your session writes the contracts (shared types and signatures), short library cheat sheets, and a task plan with a check command for every task.
- **Build with disposable workers.** `tforge` runs each task in a fresh, minimal `claude -p` worker. A worker has no hooks, plugins, MCP servers or skills, and only `Read`, `Write` and `Edit`. It sees the contracts, its own files and nothing else, then exits.
- **Tests decide when a task is done.** The driver runs each task's check itself. A failure goes back to the worker condensed: runtime stack frames are dropped. The last retry escalates to a stronger model. A final project-wide check runs integration workers.
- **Measure it.** `tforge meter` shows where the tokens went, per session.

## Where it helps, measured

Numbers come from `tforge meter` (Claude Code 2.1.292, Opus main model). "Input-equivalent" weighs each token type by its relative price: cache writes 1.25×, cache reads 0.1×, output 5×.

**Where the tokens really go.** In one real 11-hour Rust session, the main thread used 1.4M input-equivalent tokens and its 15 subagents used 17.1M (93%):
- 1,253 calls, each re-reading about 80k of context;
- about 570 of their 900 Bash calls were `sed`, `grep` or `cat`, exploring code;
- their total output was only 29k tokens.

Long-lived workers that explore and keep re-reading a growing context are the pattern tokenforge replaces:
- the planner explores once and hands workers exact line ranges;
- every check cycle starts a fresh worker with condensed errors;
- the foreman is a script that costs zero tokens.

**Worker overhead.** A tokenforge worker carries 2.5k tokens of fixed context per call. A default `claude -p` with typical plugins carries 26.2k (10×). Shared context is cached across workers. For haiku tasks, thinking is off by default: on a test-writing task that cut output from 10.6k to 4.3k tokens with the same quality.

**Small greenfield builds: not worth it.** On a browser image editor of about 1–1.6k lines:

| | input-equiv | cost | result |
|---|---|---|---|
| one Opus session | 174k | $0.78 | all checks pass, 35 tests |
| tokenforge 0.1 (before the thinking fix) | 532k | $1.14 | all checks pass, 81 tests |

A strong model writes a fresh small app in a handful of big batches, so the code's own output is most of the cost and there is little context re-reading to remove. The `forge` skill tells Claude to work inline in that case.

## Install

Inside Claude Code:

```
/plugin marketplace add chteau/tokenforge
/plugin install tokenforge@tokenforge
```

Requirements: Claude Code and Node.js 18 or newer. Subscription (OAuth) logins and API keys both work. `tmap` needs a release binary for your platform, or Rust to build one.

### Updates

tokenforge is a normal plugin. It never patches Claude Code, wraps the `claude` binary or edits your settings files, so Claude Code's own auto-update keeps working as usual. To update tokenforge itself automatically, open `/plugin`, go to **Marketplaces**, select `tokenforge` and enable auto-update. Otherwise run `/plugin marketplace update tokenforge` whenever you like.

To uninstall, run `/plugin uninstall tokenforge@tokenforge`. Nothing is left behind except `.forge/` folders in the projects where you used it.

## Use

```
/tokenforge:forge build a browser image editor with layers, three filters, undo/redo and PNG export
```

The skill scaffolds the project with the ecosystem's generator, writes `src/contracts.ts`, the `.forge/cheats/*.md` notes and `.forge/plan.json`, then runs the workers and reports the result. For small jobs (under about 5 files) it tells you to work inline instead, because planning would cost more than it saves.

Other skills:

| Skill | What it does |
|---|---|
| `/tokenforge:handoff` | Writes `.forge/HANDOFF.md` (done, decisions, next steps, file map). Run `/clear` afterwards: the handoff reloads automatically, and the conversation continues at a fraction of the context. |
| `/tokenforge:meter` | Token usage of your recent sessions and worker runs. |
| `/tokenforge:terse` | Reply style: `full` (default), `lite` or `off`. |
| `/tokenforge:dashboard` | Opens the local dashboard and prints its address. |

### Terse replies (built in, replaces caveman-style plugins)

On by default. At session start, and again after compaction, tokenforge adds one reply-style rule of about 200 tokens. Nothing is added per prompt. Answers lead with the result and skip background nobody asked for. Code, paths, commands, numbers and negations stay exact. Security warnings and irreversible steps stay in full sentences. Files Claude writes keep their normal style.

Measured with Sonnet on three everyday questions (output tokens):

| | fixed context per call | EADDRINUSE | rebase vs merge | `rm -rf` lockfile in prod |
|---|---|---|---|---|
| no style plugin | 0 | 937 | 761 | 599 |
| caveman 3.1.0 | +1.2k | 408 | 259 | 389 |
| tokenforge terse | **+0.2k** | **353** | **256** | **182** |

The fixed context is re-read on every API call, tool calls included, so the smaller rule matters most in long, tool-heavy sessions.

Switch with `/tokenforge:terse full|lite|off`. `lite` keeps short full sentences. The choice is saved in `~/.config/tokenforge/config.json`. The env var `TFORGE_TERSE` overrides it. If you also run another reply-style plugin, disable one of them: both rules would load.

### Dashboard (local web UI)

A local dashboard starts in the background with your first session. Open it with `/tokenforge:dashboard`, or with `tforge ui` in a terminal. The address is `http://127.0.0.1:7878/`, or the next free port.

- **Overview:**
  - usage limits, with the time left until each reset;
  - today, 7-day and 30-day totals;
  - a 30-day chart split by token type;
  - the last 48 hours;
  - 5-hour windows over the last week;
  - usage per model.
- **Projects:** every folder Claude Code ran in, with sessions, calls and subagent share. Open a session to see its **context-per-call curve**: every point is re-read by the next call, so the area under the curve is what the session cost. Compactions show up as drops.
- **Code map:** the project as a two-level treemap sized by lines and shaded by how many other files call into it. It also has keyword search (`tmap find`) and a list of the most depended-on files.

**Limits and resets.** Exact 5-hour and weekly usage and reset times only exist in the status-line data Claude Code passes to a status-line command. Run `tforge statusline --setup`. It installs a small recorder in `~/.config/tokenforge/` and prints a `statusLine` snippet for you to put in `~/.claude/settings.json`. Your current status line keeps running behind it. tokenforge never edits your settings itself. Without it, the dashboard estimates the 5-hour window from your session timestamps and labels it as an estimate.

**Privacy.** The server listens on 127.0.0.1 only and rejects other Host headers, which blocks DNS rebinding. It only answers GET requests and loads nothing from the internet. It reads your transcripts incrementally: only new bytes, with a cache in `~/.cache/tokenforge/`. It keeps and serves numbers only, never prompt, reply or file text. `TFORGE_UI=0` disables the auto-start, and `tforge ui --stop` stops it.

### tmap: code map (built in, replaces CodeGraph-style indexers)

`tmap` is a small Rust indexer bundled with the plugin. It parses Rust, TypeScript/TSX, JavaScript, Python and Go with tree-sitter and keeps an index in `~/.cache/tokenforge/tmap`. Every command refreshes the index first, re-parsing only changed files. It respects `.gitignore` and skips dependency and build folders even without one.

```
tmap find <words>        ranked definitions: path:start-end  signature
tmap tree [dir|file]     folders, files and their top-level symbols; a file gives its outline
tmap sym|callers|callees <name>
tmap slice <name>        path:start-end, ready for a forge plan's "reads"
```

Measured on a 1,228-file Rust workspace:
- full index from scratch: 0.9s;
- each later command: about 25 ms;
- one CodeGraph query: 3.4s.

Output for "where is orbit speed handled":

| | output |
|---|---|
| `grep -n orbit` | ~5,100 tokens |
| `codegraph explore` | ~6,200 tokens |
| `codegraph query` | ~220 tokens |
| `tmap find orbit speed` | **~70 tokens**, with the right definition and its line range |

**Where it pays off:** the `forge` skill uses it to hand workers exact line ranges, and `tmap tree` is a fast map for you. In A/B runs of normal Sonnet sessions, a session hint did not get the agent to use `tmap`. Redirecting Grep and Read to it was mixed: two small wins, and one run where the agent worked around it and used more tokens. Both are therefore opt-in:
- `TFORGE_MAP=1` adds a one-line hint at session start;
- `TFORGE_REDIRECT=1` answers identifier-like Grep calls and whole-file reads of large source files from the index. Repeating the identical call always goes through.

First use: the launcher downloads the prebuilt binary for your platform from this repo's releases and checks it against the published SHA-256. If no release binary fits, it builds once with `cargo` (about 10s to a minute). `TMAP_BIN` points to your own binary.

Hooks (automatic):

- **Context watch.** When a session passes 80k tokens of context (then every further 40k), Claude and you get one notice suggesting a handoff and `/clear`.
- **Handoff reload.** On startup or `/clear`, if `.forge/HANDOFF.md` is less than 72 hours old, it is loaded into the session.
- **Terse rule.** Injected on startup, `/clear` and after compaction (see above).

## The `tforge` command

The plugin puts `tforge` on Claude's PATH. You can also run it yourself with `node <plugin dir>/bin/tforge`.

```
tforge init                 example .forge/plan.json
tforge validate             check the plan, print task order
tforge run [--only a,b] [--force a,b] [-j N] [--dry-run] [--detach]
tforge wait                 wait for a detached run (up to 9 min per call), print its summary
tforge status               task states and spend
tforge prompt <id>          the exact prompt a worker receives
tforge meter [--last N | --all | files...] [--json]
```

### Plan format

```json
{
  "version": 1,
  "goal": "Browser image editor",
  "context": ["src/contracts.ts", ".forge/cheats/konva.md"],
  "verify": "npx tsc --noEmit && npx vitest run && npx vite build",
  "defaults": { "model": "sonnet", "retries": 2 },
  "tasks": [
    { "id": "history-test", "spec": "Vitest tests for History in contracts.ts ...", "files": ["src/history.test.ts"], "model": "haiku" },
    { "id": "history", "spec": "Implement History from contracts.ts ...", "files": ["src/history.ts"],
      "reads": ["src/history.test.ts"], "deps": ["history-test"], "verify": "npx vitest run src/history.test.ts" }
  ]
}
```

| Field | Meaning |
|---|---|
| `context` | Files every worker sees. They go into the system prompt, so after the first worker they come from the prompt cache at about a tenth of the price. |
| `verify` | Final project-wide check. If it fails, integration workers fix it, up to `retries` times. |
| `tasks[].files` | Files the task owns. Every file has exactly one owner. Writes outside them are recorded in the ledger. |
| `tasks[].reads` | Extra files inlined for this task only. |
| `tasks[].deps` | Tasks that must pass first. A failed dependency blocks its dependents. |
| `tasks[].verify` | The task's check. Without one, the task passes as soon as its files exist. |
| `tasks[].model` | `haiku`, `sonnet` or `opus`. |
| `defaults` | `model`, `integrateModel`, `tools`, `maxTurns` (12), `retries` (2), `escalate` (true), `budgetUsd` (1.5 per attempt), `timeoutMin` (20), `verifyTimeoutMin` (10), `inlineMaxChars` (60000). |

A task reruns only when its definition (or a dependency's) changes. Use `--force` after changing a contract.

`.forge/state.json`, `.forge/ledger.jsonl` (one line per worker attempt: model, turns, tokens, cost, outcome) and the run files are git-ignored automatically. Commit `plan.json` and the cheat sheets if you like.

## Safety

Workers run with `--permission-mode acceptEdits` and only `Read`, `Write` and `Edit` by default. They cannot run commands. Check commands come from your plan and run on your machine, so read a plan before running it, as you would a Makefile. Run builds on a branch or a git worktree. The workers do not load your settings, hooks, CLAUDE.md or MCP servers. Put project rules that workers must follow into a `context` file.

## Environment

| Variable | Default | |
|---|---|---|
| `TFORGE_CLAUDE` | `claude` | Claude Code binary used for workers |
| `TFORGE_WARN_AT` / `TFORGE_WARN_STEP` | `80000` / `40000` | Context-watch thresholds |
| `TFORGE_WATCH` | | `0` disables the context watch |
| `TFORGE_HANDOFF_MAX_AGE_H` | `72` | Ignore older handoffs |
| `TFORGE_TERSE` | | `full`, `lite` or `off`; overrides the saved choice |
| `TFORGE_MAP` | | `1` adds the tmap hint at session start |
| `TFORGE_REDIRECT` | | `1` answers identifier Grep calls and big whole-file reads from tmap |
| `TMAP_BIN` | | Use this tmap binary |
| `TFORGE_UI` | | `0` stops the dashboard from starting with your first session |
| `TFORGE_UI_PORT` | `7878` | Dashboard port (the next free one is used if taken) |
| `TFORGE_NO_DOWNLOAD` | | `1` never downloads tmap; build with cargo instead |

## Development

```
npm test                        # unit and end-to-end tests with a fake claude binary
cargo test --release --manifest-path native/tmap/Cargo.toml -- --test-threads=1
claude --plugin-dir .           # try the plugin locally
claude plugin validate .        # check the manifests
```

MIT licensed.
