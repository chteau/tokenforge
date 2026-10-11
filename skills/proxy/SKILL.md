---
name: proxy
description: Turn tokenforge's local proxy on or off for Claude Code (it compresses old tool results and prunes stale context before requests reach the API), or show its status and savings report.
argument-hint: "[on|off|--status|report]"
disable-model-invocation: true
---

Run `tforge proxy $ARGUMENTS` (no argument: `tforge proxy --status`). If `tforge` is missing from PATH, use `node "${CLAUDE_SKILL_DIR}/../../bin/tforge" proxy $ARGUMENTS`. Report its output briefly. On/off applies to new sessions.
