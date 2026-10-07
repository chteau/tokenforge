---
name: terse
description: Switch tokenforge's terse reply style (full, lite, off) or show it.
argument-hint: "[full|lite|off|status]"
disable-model-invocation: true
---

Run `tforge terse $ARGUMENTS`. The plugin puts it on PATH. If it is missing, use `node "${CLAUDE_SKILL_DIR}/../../bin/tforge" terse $ARGUMENTS`.

Then reply with its one-line output and nothing else. Apply the new style from your next reply on:
- **full:** answer first, no filler, fragments allowed.
- **lite:** answer first, no filler, short full sentences.
- **off:** ignore the earlier tokenforge reply-style rule and write normally.

In every mode, negations, numbers, code, paths, commands and errors stay exact.
