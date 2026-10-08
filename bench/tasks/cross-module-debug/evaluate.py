#!/usr/bin/env python3
"""Evaluator for cross-module-debug (stale dashboard balance for transfer recipients).

Root cause: the transfer service emits accountsChanged with the initiating user as owner
of both legs, so the recipient's per-user summary cache entry is never invalidated.

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
    "recipient_dashboard_fresh": ["DBG-SYMPTOM:"],
    "original_regression_test": ["DBG-ORIGINAL:"],
    "cache_still_effective": ["DBG-CACHE:"],
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


SYMPTOM_SITE = (
    "server/services/dashboard-service.ts",
    "server/routes/dashboard-routes.ts",
    "apps/web/views/dashboard.ts",
    "server/cache/",
)


def architecture_checks(repo: Path, base: str, changed: list[str]) -> dict[str, bool]:
    svc = repo / "packages" / "transfers" / "src" / "transfer-service.ts"
    svc_text = svc.read_text() if svc.exists() else ""
    config = (repo / "server" / "config.ts").read_text() if (repo / "server" / "config.ts").exists() else ""
    dash = repo / "server" / "services" / "dashboard-service.ts"
    dash_text = dash.read_text() if dash.exists() else ""
    return {
        # The fix lands where the wrong cache-invalidation event is produced or wired
        # (the transfer service, or the event wiring in server/deps.ts — both are legitimate root-cause fixes).
        "fix_at_event_source": any((f.startswith("packages/transfers/src/") or f == "server/deps.ts")
                                   and not is_test_path(f) for f in changed),
        # The event no longer names the initiating user as owner of every changed account,
        # or the wiring resolves each account's real owner.
        "event_owner_corrected": (bool(svc_text) and not re.search(r"ownerId\s*:\s*actor\.userId", svc_text))
        or "server/deps.ts" in changed,
        # The cache is not disabled or shortened.
        "cache_ttl_and_reads_intact": "summaryTtlMs: 5 * MINUTE_MS" in config
        and "summaryCache.get(" in dash_text
        and "summaryCache.set(" in dash_text,
        # No workaround at the symptom site (dashboard reader, cache module, dashboard view/route).
        "symptom_site_untouched": not any(f.startswith(SYMPTOM_SITE) for f in changed),
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
