---
name: handoff
description: Save this session's working state to .forge/HANDOFF.md so the user can /clear and continue with a small context. Use between phases, when context is large, or when the tokenforge context warning says so.
disable-model-invocation: true
---

# handoff

Write `.forge/HANDOFF.md` in the project root, at most 60 lines. Cover only what a fresh session cannot cheaply rediscover.
Recent requests, changed files and the last reply are already saved automatically in `.forge/snapshots/`; don't repeat them. Spend the lines on decisions, next steps and gotchas.

```markdown
# Handoff: <goal in one line>
## Done
- <finished step>: <where it lives>
## Decisions
- <decision>: <reason> (include rejected options when they matter)
## Next
1. <exact next step, with file paths and commands>
## File map
- path/to/file: <role, one line>
## Gotchas
- <trap found during this session>
```

Rules:
- Never paste code bodies. Point to `path:line` instead.
- Name the exact commands that build, test and run (tforge included).
- Overwrite the previous handoff. Don't append to it.

Then tell the user in one line: run `/clear`. The handoff reloads automatically in the next session.
