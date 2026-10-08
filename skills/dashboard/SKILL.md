---
name: dashboard
description: Open the local tokenforge dashboard (token usage, limits and reset times, sessions, code map).
disable-model-invocation: true
---

Run `tforge ui --detach`. The plugin puts it on PATH. If it is missing, use `node "${CLAUDE_SKILL_DIR}/../../bin/tforge" ui --detach`.

Reply with the URL it prints and nothing else. If the overview says limits are estimated, add one line: `tforge statusline --setup` enables exact limits and reset times (and shows the savings in the status line).
