---
name: forge
description: Build a large feature or app with far fewer tokens. Plan contracts and tasks once, then run each task in a small stateless worker that the tests check (tforge). Use for multi-file builds ("build me a ...", "implement this app"), not small edits.
argument-hint: "<what to build>"
---

# forge

A long session re-sends its whole context on every turn, so cost ≈ turns × context size. forge keeps this session small. You plan here. `tforge` runs every implementation task in a fresh worker that sees only the contracts, its own files and its failing checks. Tests decide when a task is done.

Command: `tforge`. The plugin puts it on PATH. If it is missing, use `node "${CLAUDE_SKILL_DIR}/../../bin/tforge"`.

## 0. Fit check (measured)

forge pays off when work is **iterative or exploratory**: many build/test cycles, a large existing codebase, or anything you would otherwise hand to long-running subagents. There, every extra call re-reads a context of 80k+ tokens. A forge attempt starts fresh, with only the slices it needs and condensed errors.

For a small **greenfield** build (about 1k lines, written in a few large batches), one session is already near the floor, because the code's own output tokens dominate. forge measured about 1.5× more expensive there. Work inline in that case.

## Existing codebase: explore once, here

Workers must never explore. Exploration (grep, sed and cat slices) is what makes subagents expensive.
- Locate the code once in this session with `tmap find <words>`, `tmap tree <dir>` and `tmap callers <name>`. Fall back to grep only if tmap is unavailable.
- Give each task exact line ranges. `tmap slice <name>` prints them ready to paste: `"reads": ["crates/x/src/lib.rs:120-260"]`.
- For a large owned file, use a range too: `"files": ["src/big.rs:400-520"]`. The task owns the whole file, but only that slice is inlined.
- Put the signatures workers need into `.forge/cheats/<area>.md` and list it in `context`, instead of contracts you would have to write.
- Set `"tools": ["Read", "Edit", "Grep"]` only when a task truly needs to search.
- Use `verify` for the cheapest check that proves the task, e.g. `cargo check -p <crate>` or `cargo test -p <crate> <filter>`. The driver drops compiler warning blocks when there are errors.

Then skip to step 4.

## 1. Scaffold with tools, not tokens

Create the project with the ecosystem's generator. Examples: `npm create vite@latest . -- --template react-ts`, `cargo new`, `uv init`. Install the libraries and a test runner. Do not read generated files.

Choose libraries over hand-written engines. Example: an image editor uses `konva`, not a custom canvas engine.

## 2. Cheat sheets (`.forge/cheats/<lib>.md`)

Write one cheat sheet for each library the workers use, at most 60 lines.
- Include only the APIs this project needs, with exact signatures.
- Take them from the installed type definitions: grep `node_modules/<lib>` for `.d.ts` files, or read the package's source.
- Never browse docs in this session.

## 3. Contracts

Write `src/contracts.ts`, or the equivalent for your language. It holds:
- every shared type and the state shape;
- each module's exported signatures, each with a one-line doc comment;
- event names and payloads.

Write no implementation. This file is the only definition of module boundaries. Keep it under about 250 lines. Make it type-check now.

## 4. Plan (`.forge/plan.json`)

```json
{
  "version": 1,
  "goal": "one sentence",
  "context": ["src/contracts.ts", ".forge/cheats/konva.md"],
  "verify": "npx tsc --noEmit && npx vitest run && npx vite build",
  "defaults": { "model": "sonnet", "retries": 2 },
  "tasks": [
    { "id": "history-test", "spec": "...", "files": ["src/history.test.ts"], "model": "haiku" },
    { "id": "history", "spec": "...", "files": ["src/history.ts"], "reads": ["src/history.test.ts"],
      "deps": ["history-test"], "verify": "npx vitest run src/history.test.ts" }
  ]
}
```

Task fields:
- **Required:** `id`, `spec`, `files`. Each task owns its files, and no file has two owners.
- **Optional:** `reads`, `deps`, `verify`, `model` (`haiku`, `sonnet` or `opus`), `tools`, `retries`, `maxTurns`, `budgetUsd`.

Rules for good tasks:
- **Size:** a task owns 1–3 files and writes about 300 lines or fewer.
- **Spec:** at most 12 lines. Name the contract it implements, the inputs and outputs, and the edge cases. Workers know nothing else.
- **Tests first for logic:** add an `<id>-test` task on haiku that writes tests from the contract. The implementing task depends on it, and its `verify` runs that test file.
- **UI and glue tasks:** `verify` runs a type check of the project, at least.
- **`context`:** only the contracts and cheat sheets. It is shared by every worker and cached.
- **`reads`:** only the extra files that one task needs, such as its test file.
- **Models:**
  - haiku for tests, styles, config and mechanical wiring;
  - sonnet by default;
  - opus only for genuinely hard algorithms.
- **`deps`:** add one only when a task needs another task's file to exist.
- **Final `verify`:** type check, all tests and the production build.

## 5. Run

1. Run `tforge validate`, then `tforge run --dry-run`.
2. Tell the user in 2–3 lines: number of tasks, models, and the estimated tokens per worker.
3. Run `tforge run --detach`, then `tforge wait`. `wait` blocks for up to 9 minutes and prints the summary. Exit code 3 means the run is still going: call `tforge wait` again. Do nothing else in between.

## 6. Fix failures from this session, cheaply

- Read only the summary that `tforge` printed. Do not open worker-written files to review them: the checks are the review.
- When a task fails, fix its spec, the contracts or a cheat sheet. Then run `tforge run --only <id>`. A changed spec reruns by itself.
- After a contract change, use `--force <ids>` on the tasks that depend on it.
- Edit code directly only for a one-line fix.
- When the final check fails, tforge runs integration workers itself. Step in only if it reports a failure afterwards.

## 7. Finish

Run `tforge status` and report the result and its cost. For UI, take one cropped screenshot at the end, not one per task.
