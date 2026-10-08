# tokenforge benchmark

Does tokenforge reduce Claude Code token use without lowering software-engineering quality? This benchmark answers that with measured data. It runs the same tasks in two configurations:

| | Agent A: `native` | Agent B: `token-forge` |
|---|---|---|
| Claude Code | installed version, `-p` mode | same |
| Model | `claude-opus-5-5` (pinned with `--model`, and checked against the model field of every API response; the report lists `api_models` and flags any run answered by another model) | same |
| Skills, plugins, hooks, MCP, CLAUDE.md, settings | none | **tokenforge only** (this checkout, loaded with `--plugin-dir`) |
| Task, prompt, repo commit, toolchains, permissions, timeout | identical | identical |

Everything is in this directory so you can rerun it and check our numbers.

## Quick start

```bash
cd bench
# credential: --use-local-login (reuses your current login's access token read-only; fine for a session) or
claude setup-token                       # once; then either export it…
export CLAUDE_CODE_OAUTH_TOKEN=...       # …or save it: ~/.config/claude-bench/oauth-token (chmod 600). ANTHROPIC_API_KEY also works
python3 runner/bench.py env build       # freeze the two environment templates
python3 runner/bench.py doctor          # every critical check must pass (makes one tiny API call; --no-api to skip)
python3 runner/bench.py run --smoke     # smoke test: both agents on a one-line fix, isolation verified
python3 runner/bench.py run --all       # full suite: 10 tasks × 2 agents, randomized order
python3 runner/bench.py run --all --subset-reps go-api,rust-debug,architecture --subset-n 3   # + repetitions
python3 runner/bench.py report          # rebuild reports/benchmark-report.{md,json} from all sessions
```

Other commands: `bench.py list`, `bench.py run --task go-api --both`, `bench.py run --task go-api --agent native`.

Run options: `--max-tokens N` (hard stop, all token types, default in `benchmark.config.json`), `--warn-tokens N`, `--max-budget-usd X` (passed to Claude Code as a second stop), `--jobs N` (parallel runs, default 1), `--seed N` (run order).

The runner needs Python 3.10+, git, and the task toolchains: Rust (cargo, clippy, rustfmt), Go 1.22+, Node 22.6+ (native TypeScript type stripping) with `tsc` on PATH, and Python 3 for the smoke task.

## Isolation

Each run gets a fresh, disposable sandbox under `work_root` (default `/var/tmp/cc-sandbox`: no ancestor directory contains `CLAUDE.md` or `.claude/`, and the path never mentions tokenforge or benchmarks):

- `HOME` is an empty directory, so `~/.claude`, `~/.claude.json`, `~/.config` and `~/.cache` from your machine are not visible.
- `CLAUDE_CONFIG_DIR` is an empty directory: no settings, plugins, skills, memory or session history.
- The environment is built from an allow-list, not inherited. It contains PATH (toolchains only), toolchain caches, and the auth token.
- `--strict-mcp-config` without `--mcp-config` means zero MCP servers, including claude.ai connectors.
- The repo is a copy of the canonical task repo at a fixed commit, which is verified before launch. The path is random and neutral: the agent never sees "tokenforge" or "benchmark".
- Fresh session ID, fresh config, fresh repo: no conversation, memory or result from any earlier run can leak in.

**Preflight** (before every run) audits the sandbox: it checks the config and home directories, every ancestor for `CLAUDE.md`, `CLAUDE.local.md`, `.claude/` and `.mcp.json`, managed policy settings, environment variables, PATH and CLI flags. A native run with any finding is not launched and is recorded as `baseline_contaminated`.

**Post-run verification** uses Claude Code's own `init` event, which lists the plugins, MCP servers and skills actually loaded, together with the transcript's hook records. A native run that shows any plugin, MCP server, hook execution or non-built-in skill is flagged. Plugins compiled into the Claude Code binary (`source: <name>@builtin`, for example `cc-plugin-telemetry`) load in every vanilla install, identically for both agents. They count as part of the baseline and are listed in each manifest under `builtin_plugins`. After each run, any process still referencing the sandbox is killed, for example tokenforge's detached dashboard server. The first clean native run records the vanilla built-in skill inventory to `environments/native-clean/vanilla_inventory.json`.

The tokenforge environment loads one plugin: a copy of this checkout without `bench/`, so hidden tests are unreachable. Its `tmap` binary goes where tokenforge's own installer puts it (`$HOME/.cache/tokenforge/bin/`). tokenforge's dependencies (node for its hooks, the bundled tmap binary, nested `claude -p` calls) are recorded in each run's `environment_manifest.json`.

### Things the runner adds to both agents (identical)

- `--permission-mode bypassPermissions` (configurable in `permission_args`). Headless runs cannot answer permission prompts, so both agents get the same unrestricted tool access inside the sandbox. Edit `permission_args` if you prefer an allow-list.
- A `claude` shim first on PATH. It runs the real binary unchanged except that it drops `--no-session-persistence`. tokenforge's `tkit distill` and `tforge` workers call `claude -p` with that flag, so without the shim their tokens would not be counted.

## Token measurement

The source of truth is every transcript (`*.jsonl`) in the run's `CLAUDE_CONFIG_DIR`: the main session, subagents, and nested sessions. API requests are deduplicated by `requestId`. All token fields are exact API `usage` values:

- `input_tokens` = uncached input + cache writes + cache reads (everything the model read)
- `uncached_input_tokens` = uncached input + cache writes
- `cached_input_tokens` = cache reads
- `output_tokens` (includes thinking)
- `total_tokens` = input + output
- `input_equivalent_tokens` = price-weighted (cache write 1.25×, cache read 0.1×, output 5×), which approximates what a run costs against your usage limits
- `first_request_context_tokens` = the context size of the first request. The tokenforge-minus-native difference on the same task is the measured fixed overhead of tokenforge's instructions, skills and hook context.

Claude Code's `result` event (`usage`, `modelUsage`, `total_cost_usd`) is saved as a cross-check. Anything computed from text length (tool-result tokens, hook context tokens) is reported only under `estimated` and never mixed with exact numbers. Missing values are `null`, never 0.

tokenforge's own overhead is always included: its hook-injected context, its skill listing and its nested model calls all count toward its total.

**About the 5k–25k target in the original spec:** Claude Code's built-in system prompt and tool definitions alone are roughly 15–25k tokens, and they are re-read (from cache) on every request. A realistic run therefore totals hundreds of thousands to a few million tokens, mostly cache reads. The default `--max-tokens` is set accordingly. Pass a lower value if you want a tighter stop.

## Quality score (0–100, identical for both agents)

Coding, debugging and refactoring rubric (`evalkit.score_coding`):

| Component | Points | Measured by |
|---|---:|---|
| Correctness | 40 | fraction of hidden behaviour tests passing (0 if the build fails) |
| Regression protection | 20 | 10 if the original suite still passes, plus 10 if the agent added tests that pass |
| Architecture | 15 | task-specific structural checks (root-cause checks for debugging) |
| Completeness | 15 | fraction of requirement groups whose hidden tests all pass |
| Cleanliness | 10 | 4 for no unrelated files changed, 3 for fmt/lint clean, 3 for a diff within 3× the reference size |

PR review (`score_review`): 70 for severity-weighted recall (critical 3, high 2, medium/low 1), 15 for precision, 15 for severity within one level. A finding matches a planted issue when the file matches, the line is within ±8, and the keyword groups match.

Architecture investigation (`score_architecture`): 60 for ground-truth steps found (path and symbol), 15 for order, 15 for accuracy (−5 per non-existent path), 10 for decoys (−5 per dead look-alike cited as part of the path).

Status: `completed` (every hidden test passes and the original suite passes; for review, no missed critical issue and recall ≥ 75%), `partial`, or `failed`. A run counts as task-completed only when the agent finished on its own and the evaluation says `completed`. Budget-exceeded and timed-out runs keep their real token counts and are never counted as completed.

`.forge/` (tokenforge's state directory) is excluded from diffs and from the unrelated-change check.

## Tasks

| id | category | language | what |
|---|---|---|---|
| rust-cli | greenfield | Rust | new subcommand integrated with existing store, filters, renderers |
| rust-debug | debugging | Rust | subtle planted bug; user bug report only |
| go-api | feature | Go | new REST endpoint through existing auth, service and repository layers |
| go-feature | feature | Go | multi-layer scheduled-notification feature |
| banking-web | feature | TypeScript | fictional bank: filtering and CSV export across view, API and service |
| banking-transfers | feature | TypeScript | fictional bank: scheduled transfers reusing existing transfer rules |
| pr-review | review | Go | flawed PR with planted issues; hidden ground truth |
| architecture | architecture | TypeScript | trace a behaviour through a confusing ~10k-line repo |
| cross-module-debug | debugging | TypeScript | symptom far from its root cause (cache key mismatch) |
| refactor | refactor | Rust | remove duplicated logic without changing behaviour |

Each task has hidden tests or ground truth plus a reference solution. `scripts/validate_task.sh <id>` proves that the untouched repo scores low and the reference scores ≥ 90. See `tasks/README.md` for the task-pack contract.

## Layout

```
bench/
├── benchmark.config.json   model, limits, permission args, toolchain env
├── runner/                 bench.py (CLI), isolation.py, telemetry.py, evalkit.py, report.py
├── environments/           frozen templates + manifests for native-clean and token-forge
├── fixtures/               source repos used by the tasks
├── tasks/                  task packs (prompt, setup, hidden tests, evaluator, reference)
├── runs/<timestamp>/<task>/<agent>-r<n>/   immutable raw data per run
├── results/aggregated/
├── reports/                benchmark-report.md / .json
└── scripts/validate_task.sh
```

Each run directory holds `manifest.json`, `environment_manifest.json`, `prompt.txt`, `stream.jsonl` (the full stream-json output), `stderr.txt`, `transcripts/`, `init.json`, `telemetry.json`, `diff.patch`, `git_status.txt`, `eval.json` and `eval.log`. The runner refuses to overwrite an existing run directory.

## Limitations

- Results are for one model, one Claude Code version and one tokenforge version; all three are recorded in every manifest.
- With one repetition per task, per-task differences include run-to-run noise. Use repetitions (`--reps`, `--subset-reps`) and read medians.
- Files read through Bash (`cat`, `sed -n`, `head`) are detected heuristically, and context precision is approximate.
- The PR-review and architecture graders use deterministic keyword and path matching. They are strict, and a correct finding phrased unusually can be missed for either agent equally.
