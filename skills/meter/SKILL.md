---
name: meter
description: Show token usage of recent Claude Code sessions and tforge worker runs (calls, average and peak context, cache, output). Use when asked how many tokens a session or build used, or to compare two approaches.
argument-hint: "[--last N | --all | transcript.jsonl ...]"
---

# meter

Run `tforge meter $ARGUMENTS`. The plugin puts it on PATH. If it is missing, use `node "${CLAUDE_SKILL_DIR}/../../bin/tforge" meter $ARGUMENTS`.

Report the table. Then explain the main cost driver in 1–2 lines, using these rules:
- Cost ≈ calls × average context. High `avg ctx` means the session should have been split with a handoff, or the work given to `tforge`.
- High `cache-w` compared with `cache-r` means the cache was broken often. Typical causes: switching models, editing CLAUDE.md mid-session, or long pauses.
- `input-equiv` weighs each column by its relative price, so compare runs on that column.
