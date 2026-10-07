# Changelog

## 0.1.0

- `tforge` driver: runs a `.forge/plan.json` of tasks in fresh, minimal Claude Code workers (no hooks, plugins, MCP or skills; 3 tools). Shared context sits in a cached system prompt. Tests decide when a task is done; failures retry with condensed output and escalate the model on the last attempt; a final check runs integration workers.
- `tforge run --detach` / `tforge wait`: long runs without tool-call timeouts.
- `tforge meter`: per-session token usage from transcripts (calls, average and peak context, cache, output, price-weighted total) plus worker spend.
- Skills: `forge` (plan and run), `handoff` (save state before `/clear`), `meter`.
- Hooks: context-growth warning; reload `.forge/HANDOFF.md` after `/clear`.
