---
name: lean
description: Turn tokenforge's lean tool set on or off (hides Workflow, Monitor, Cron and other agent-orchestration tools from Claude Code to cut fixed context per request).
argument-hint: "[on|max|ultra|off|status]"
disable-model-invocation: true
---

Run `tforge lean $ARGUMENTS`. If `tforge` is missing from PATH, use `node "${CLAUDE_SKILL_DIR}/../../bin/tforge" lean $ARGUMENTS`. Report its one-line output. Changes apply to new sessions.
