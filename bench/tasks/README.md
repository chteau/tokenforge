# Task pack contract

Each task lives in `tasks/<id>/`. Nothing in this directory except what `setup.sh` copies is ever shown to an agent.

```
tasks/<id>/
├── task.json        metadata (below)
├── prompt.md        the task text only; the runner wraps it in the standard template
├── setup.sh         `setup.sh DEST` builds the canonical git repo at DEST
├── evaluate.py      `evaluate.py --workspace W --base SHA --out OUT.json`
├── hidden/          hidden tests and ground truth (never copied into the agent workspace)
└── reference/
    └── solution.patch   reference solution (`git apply` on a fresh setup); validates the evaluator
```

## task.json

```json
{
  "id": "go-api",
  "title": "Add invoice refund endpoint",
  "category": "feature",            // greenfield | debugging | feature | review | architecture | refactor
  "language": "go",
  "rubric": "coding",               // coding | debugging | refactor | review | architecture
  "timeout_s": 1500,
  "relevant_files": ["internal/billing/**", "internal/handlers/billing*.go"],
  "allowed_change_globs": ["internal/billing/**", "internal/handlers/**", "cmd/server/*.go"],
  "reference_diff_lines": 180
}
```

- `relevant_files`: globs of files a well-targeted agent needs to read. Used only for the approximate context-precision metric.
- `allowed_change_globs`: files the solution may reasonably touch. Changes elsewhere are counted as unrelated.
- `reference_diff_lines`: added lines in `reference/solution.patch`. The cleanliness check allows up to 3× this.

## setup.sh

- Deterministic and offline. Copies source from `fixtures/<family>/...` (paths relative to the script), then `git init -q -b main && git add -A && git commit -q -m "<msg>"`.
- The runner exports a fixed `GIT_AUTHOR_*`/`GIT_COMMITTER_*` name, email and date, so the commit hash is the same on every run.
- PR-review tasks may create several commits and branches, and must leave the PR branch checked out.
- The repo must not contain `CLAUDE.md`, `AGENTS.md`, `.claude/`, hidden tests, or ground truth. It must never mention benchmarks, Claude or tokenforge, and comments must not hint at the planted bug.

## evaluate.py

- Imports `runner/evalkit.py`: `sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runner"))`.
- Never modifies the workspace. It runs `evalkit.scratch_copy()` first, then overlays `hidden/` onto the copy.
- Writes the JSON from `evalkit.write_result()`. `checks` holds `build_passed`, `tests_passed` (original visible suite), `lint_passed`, `format_passed` and `typecheck_passed`, using `null` where a check does not apply.
- Scores with the rubric functions in `evalkit` so both agents get identical scoring.
- For review tasks: the prompt asks for `review.json` in the repo root. For architecture tasks: it asks for `ANSWER.md`.

## Validation

`scripts/validate_task.sh <id>` runs setup, then evaluates the untouched base (expected: failed or low), applies the reference patch, and evaluates again (expected: ≥ 90 and completed). Every task must pass it.

## Toolchains (offline, no third-party dependencies)

- Rust: std only, edition 2021. `cargo build`, `cargo test`, `cargo fmt --check`, `cargo clippy -- -D warnings`.
- Go 1.26: stdlib only. `go build ./...`, `go test ./...`, `gofmt -l`, `go vet ./...`.
- TypeScript: Node 26 native type stripping (erasable syntax only: no enums, namespaces or parameter properties), `node --test`, and `tsc --noEmit` with a `tsconfig.json` (`allowImportingTsExtensions`, `noEmit`, `erasableSyntaxOnly`, `strict`). No npm packages.
