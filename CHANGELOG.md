# Changelog

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
