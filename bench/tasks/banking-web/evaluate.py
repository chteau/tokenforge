#!/usr/bin/env python3
"""Evaluator for banking-web (transaction filters + CSV export + web view).

Checks (on a scratch copy, never the workspace):
  typecheck_passed  `tsc --noEmit -p .` on the agent's tree (before hidden tests are added)
  build_passed      typecheck passes AND every non-test module under apps/, packages/,
                    server/ and seed/ imports without error under Node type stripping
  tests_passed      the original visible suite (explicit list of base test files)
  lint_passed       null (no linter in this toolchain)
  format_passed     null (no formatter in this toolchain); fmt_ok for scoring = typecheck_passed
Hidden tests: tests/hidden/*.test.ts, TAP output, grouped by name prefix. Expected test
names are read from the hidden files so a crashing file counts all its tests as failed.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "runner"))
import evalkit  # noqa: E402

TASK = json.loads((HERE / "task.json").read_text())
TASK_ID = TASK["id"]

ORIGINAL_TESTS = [
    "tests/unit/money.test.ts",
    "tests/unit/dates.test.ts",
    "tests/unit/validation.test.ts",
    "tests/unit/ttl-cache.test.ts",
    "tests/unit/router.test.ts",
    "tests/unit/html.test.ts",
    "tests/unit/transfer-form-client.test.ts",
    "tests/unit/ledger.test.ts",
    "tests/unit/transfer-rules.test.ts",
    "tests/unit/auth.test.ts",
    "tests/unit/json-file-store.test.ts",
    "tests/api/auth.api.test.ts",
    "tests/api/accounts.api.test.ts",
    "tests/api/transactions.api.test.ts",
    "tests/api/transfers.api.test.ts",
    "tests/api/dashboard.api.test.ts",
    "tests/api/cards-support-statements.api.test.ts",
    "tests/api/web.api.test.ts",
    "tests/api/persistence.api.test.ts",
]

REQUIREMENT_GROUPS = {
    "filter_dates_in_user_timezone": ["WEB-FILTER-DATE:"],
    "filter_type_and_amount": ["WEB-FILTER-TYPE-AMOUNT:"],
    "filter_text_search": ["WEB-FILTER-TEXT:"],
    "paging_after_filtering": ["WEB-PAGING:"],
    "filter_validation": ["WEB-VALIDATION:"],
    "csv_format": ["WEB-CSV-FORMAT:"],
    "csv_scope_and_filters": ["WEB-CSV-SCOPE:"],
    "authorization": ["WEB-AUTHZ:"],
    "web_view": ["WEB-VIEW:"],
}

IMPORT_CHECK = r"""
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.argv[2];
const files = [];
function walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.endsWith(".test.ts")) files.push(p);
  }
}
for (const d of ["apps", "packages", "server", "seed"]) walk(join(root, d));
let failed = 0;
for (const f of files) {
  try { await import(pathToFileURL(f).href); }
  catch (e) { failed++; console.error("IMPORT FAILED", f, String(e && e.stack || e).split("\n").slice(0, 3).join(" | ")); }
}
console.log(`imported ${files.length - failed}/${files.length}`);
process.exit(failed ? 1 : 0);
"""


def tsc_bin() -> str:
    return shutil.which("tsc") or "/home/linuxbrew/.linuxbrew/bin/tsc"


def expected_hidden_names(hidden_dir: Path) -> list[str]:
    names = []
    for f in sorted(hidden_dir.rglob("*.test.ts")):
        names += re.findall(r'\btest\(\s*"([^"]+)"', f.read_text())
    return names


def added_lines(repo: Path, base: str, paths_filter) -> list[tuple[str, str]]:
    """(path, line) for every added line in files accepted by paths_filter."""
    _, out = evalkit.sh(["git", "diff", "-U0", base, "--", "."], repo)
    res, cur = [], None
    for line in out.splitlines():
        if line.startswith("+++ "):
            cur = line[6:] if line.startswith("+++ b/") else None
        elif line.startswith("+") and not line.startswith("+++") and cur and paths_filter(cur):
            res.append((cur, line[1:]))
    return res


def is_test_path(p: str) -> bool:
    return p.startswith("tests/") or p.endswith(".test.ts")


def architecture_checks(repo: Path, base: str, changed: list[str]) -> dict[str, bool]:
    src_added = added_lines(repo, base, lambda p: p.endswith(".ts") and not is_test_path(p))
    routes_text = "\n".join(p.read_text() for p in (repo / "server" / "routes").glob("*.ts"))
    views_added = [l for p, l in src_added if p.startswith("apps/web/views/")]
    routes_added = [l for p, l in src_added if p.startswith("server/routes/")]
    return {
        # Business logic (filter/CSV) lives in the transactions package, not only in route handlers.
        "logic_in_transactions_package": any(
            f.startswith("packages/transactions/src/") and not is_test_path(f) for f in changed
        ),
        # The export is a regular route-table entry declared with the api() helper.
        "csv_route_uses_route_table": bool(
            re.search(r"""api\(\s*["']GET["']\s*,\s*["'][^"']*transactions\.csv["']""", routes_text)
        ),
        # Routes keep going through services instead of reaching into repositories.
        "routes_do_not_touch_repositories": bool(routes_added) and not any("deps.repos." in l for l in routes_added),
        # Views stay pure render functions.
        "views_stay_pure": bool(views_added) and not any(re.search(r"\b(ctx|deps|services|repos)\.", l) for l in views_added),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    repo = evalkit.scratch_copy(args.workspace)
    base = args.base
    details: dict = {}

    changed = evalkit.changed_files(repo, base)
    diff_added, diff_removed = evalkit.diff_size(repo, base)
    unrelated = evalkit.unrelated_changes(changed, TASK["allowed_change_globs"])

    rc, out = evalkit.sh([tsc_bin(), "--noEmit", "-p", "."], repo, timeout=300)
    typecheck_passed = rc == 0
    details["typecheck_output"] = out[-3000:]

    tmp = Path(tempfile.mkdtemp(prefix="tfbench-imp-"))
    (tmp / "import-all.mjs").write_text(IMPORT_CHECK)
    rc, out = evalkit.sh(["node", str(tmp / "import-all.mjs"), str(repo)], repo, timeout=120)
    imports_ok = rc == 0
    details["import_check"] = out[-2000:]
    build_passed = typecheck_passed and imports_ok

    present = [t for t in ORIGINAL_TESTS if (repo / t).exists()]
    rc, out = evalkit.sh(["node", "--test", *present], repo, timeout=300)
    original_tests_passed = rc == 0 and len(present) == len(ORIGINAL_TESTS)
    details["original_tests_missing"] = sorted(set(ORIGINAL_TESTS) - set(present))
    details["original_tests_output"] = out[-3000:]

    agent_tests = [
        f for f in changed
        if f.startswith("tests/") and f.endswith(".test.ts") and not f.startswith("tests/hidden/") and (repo / f).exists()
    ]
    agent_tests_added = bool(agent_tests)
    agent_tests_pass = False
    if agent_tests_added:
        rc, out = evalkit.sh(["node", "--test", *agent_tests], repo, timeout=300)
        agent_tests_pass = rc == 0
        details["agent_tests_output"] = out[-2000:]
    details["agent_tests"] = agent_tests

    arch = architecture_checks(repo, base, changed)

    hidden_dir = HERE / "hidden"
    evalkit.overlay(hidden_dir, repo)
    hidden_files = sorted(str(p.relative_to(hidden_dir)) for p in hidden_dir.rglob("*.test.ts"))
    rc, out = evalkit.sh(["node", "--test", "--test-reporter=tap", *hidden_files], repo, timeout=300)
    parsed = evalkit.node_tap(out)
    hidden_results = {name: parsed.get(name, False) for name in expected_hidden_names(hidden_dir)}
    details["hidden_failed"] = [n for n, ok in hidden_results.items() if not ok]
    details["hidden_output_tail"] = out[-4000:]

    scored = evalkit.score_coding(
        build_passed=build_passed,
        hidden_results=hidden_results,
        requirement_groups=REQUIREMENT_GROUPS,
        original_tests_passed=original_tests_passed,
        agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass,
        arch_checks=arch,
        unrelated=unrelated,
        fmt_ok=typecheck_passed,
        diff_added=diff_added,
        diff_limit=3 * TASK["reference_diff_lines"],
        rubric=TASK["rubric"],
    )
    checks = {
        "build_passed": build_passed,
        "tests_passed": original_tests_passed,
        "lint_passed": None,
        "format_passed": None,
        "typecheck_passed": typecheck_passed,
    }
    details.update({
        "changed_files": changed,
        "unrelated_files": unrelated,
        "diff_added": diff_added,
        "diff_removed": diff_removed,
        "architecture_checks": arch,
        "imports_ok": imports_ok,
    })
    evalkit.write_result(args.out, TASK_ID, checks, scored, details)
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
