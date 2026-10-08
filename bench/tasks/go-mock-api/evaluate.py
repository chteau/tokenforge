#!/usr/bin/env python3
"""Evaluator for go-mock-api: greenfield in-memory books REST API (black-box HTTP contract)."""
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
CONTRACT = HERE / "hidden" / "_contract"

REQUIREMENT_GROUPS = {
    "health_endpoint": ["TestHealth"],
    "listing_and_pagination": ["TestList"],
    "filtering": ["TestFilter"],
    "sorting": ["TestSort"],
    "query_validation": ["TestQuery"],
    "get_by_id": ["TestGet"],
    "method_routing": ["TestRouting"],
    "write_authentication": ["TestAuth"],
    "create": ["TestCreate"],
    "body_validation": ["TestValidation"],
    "isbn_conflicts": ["TestConflict"],
    "update": ["TestUpdate"],
    "delete": ["TestDelete"],
    "configuration": ["TestConfig"],
    "graceful_shutdown": ["TestShutdown"],
}

GO_ENV = {"GOTOOLCHAIN": "local", "GOPROXY": "off", "CGO_ENABLED": "0"}
TEST_FUNC = re.compile(r"^func (Test\w+)\(", re.M)
SKIP_DIRS = {".git", "vendor", "_contract", "testdata"}


def go(cmd, cwd, timeout=300, env=None):
    return evalkit.sh(cmd, cwd, timeout=timeout, env={**GO_ENV, **(env or {})})


def source_files(repo: Path, tests: bool):
    out = []
    for p in repo.rglob("*.go"):
        rel = p.relative_to(repo)
        if any(part in SKIP_DIRS or part.startswith((".", "_")) for part in rel.parts[:-1]):
            continue
        if p.name.endswith("_test.go") == tests:
            out.append((str(rel), p.read_text(errors="replace")))
    return out


TOP_LEVEL_MAP = re.compile(r"^var\s+\w+(\s*,\s*\w+)*\s*(=\s*)?(map\[|make\(\s*map\[)", re.M)
VAR_BLOCK = re.compile(r"^var\s*\((.*?)^\)", re.M | re.S)
BLOCK_MAP = re.compile(r"^\s*\w+(\s*,\s*\w+)*\s*(=\s*)?(map\[|make\(\s*map\[)", re.M)
ROUTE = re.compile(r'"(GET|POST|PUT|DELETE|PATCH)\s+/[^"]*"')


def arch_checks(repo: Path) -> dict[str, bool]:
    prod = source_files(repo, tests=False)
    allsrc = "\n".join(s for _, s in prod)
    pkgs = {str(Path(f).parent) for f, _ in prod}
    gomod = (repo / "go.mod").read_text(errors="replace") if (repo / "go.mod").is_file() else ""
    routes = {m.group(0) for m in ROUTE.finditer(allsrc)}
    global_maps = any(TOP_LEVEL_MAP.search(s) or any(BLOCK_MAP.search(b) for b in VAR_BLOCK.findall(s))
                      for _, s in prod)
    if not prod:
        return {k: False for k in ("code_is_split_up", "store_guarded_by_mutex", "no_global_mutable_maps",
                                   "servemux_method_patterns", "graceful_shutdown_wiring", "stdlib_only")}
    return {
        # HTTP handling separated from storage: several packages or files.
        "code_is_split_up": len(pkgs) >= 2 or len(prod) >= 3,
        # in-memory store guarded by a mutex
        "store_guarded_by_mutex": bool(re.search(r"\bsync\.(RW)?Mutex\b", allsrc)),
        # no package-level mutable maps (shared state belongs inside the guarded store)
        "no_global_mutable_maps": not global_maps,
        # Go 1.22+ ServeMux method patterns for (most of) the routes
        "servemux_method_patterns": len(routes) >= 5 and "http.NewServeMux" in allsrc,
        # graceful shutdown via http.Server.Shutdown on a signal
        "graceful_shutdown_wiring": ".Shutdown(" in allsrc and bool(re.search(r"signal\.Notify(Context)?\(", allsrc)),
        # stdlib only
        "stdlib_only": "require" not in gomod,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    repo = evalkit.scratch_copy(a.workspace)
    changed = evalkit.changed_files(repo, a.base)
    unrelated = evalkit.unrelated_changes(changed, TASK["allowed_change_globs"])
    added, removed = evalkit.diff_size(repo, a.base)
    details = {"changed_files": changed, "unrelated": unrelated, "diff": [added, removed]}

    has_go = bool(source_files(repo, tests=False))
    rc, out = go(["go", "build", "./..."], repo)
    build_ok = rc == 0 and has_go
    details["build_output"] = out[-3000:]

    work = Path(tempfile.mkdtemp(prefix="gomock-eval-"))
    binary = work / "api"
    bin_ok = False
    if build_ok:
        rc, out = go(["go", "build", "-o", str(binary), "."], repo)
        bin_ok = rc == 0 and binary.is_file()
        details["binary_build_output"] = out[-3000:]

    rc_fmt, fmt_out = evalkit.sh(["gofmt", "-l", "."], repo)
    fmt_ok = rc_fmt == 0 and not fmt_out.strip()
    rc_vet, vet_out = go(["go", "vet", "./..."], repo)
    vet_ok = rc_vet == 0 and build_ok
    details["gofmt"] = fmt_out[-2000:]
    details["vet"] = vet_out[-3000:]

    # Agent's own tests (there is no original suite in a greenfield repo).
    agent_tests = source_files(repo, tests=True)
    agent_tests_added = bool(agent_tests) and any(TEST_FUNC.search(s) for _, s in agent_tests)
    agent_tests_pass = False
    if build_ok and agent_tests_added:
        rc_t, tout = go(["go", "test", "-count=1", "-timeout=120s", "./..."], repo, timeout=180)
        agent_tests_pass = rc_t == 0
        details["agent_test_output"] = tout[-3000:]
    details["agent_test_files"] = [f for f, _ in agent_tests]

    arch = arch_checks(repo)

    # Hidden black-box contract tests, run from a copy outside the agent's module.
    contract = work / "contract"
    shutil.copytree(CONTRACT, contract)
    expected = set()
    for p in CONTRACT.glob("*_test.go"):
        expected |= set(TEST_FUNC.findall(p.read_text()))
    hidden = {n: False for n in expected}
    if bin_ok:
        _, hout = go(["go", "test", "-json", "-count=1", "-timeout=200s", "."], contract, timeout=240,
                     env={"API_BIN": str(binary)})
        res = evalkit.go_test_json(hout)
        for n in expected:
            hidden[n] = res.get(n, False)
        if not any(res.get(n) for n in expected):
            details["hidden_output"] = hout[-4000:]
    shutil.rmtree(work, ignore_errors=True)

    scored = evalkit.score_coding(
        build_passed=bin_ok, hidden_results=hidden, requirement_groups=REQUIREMENT_GROUPS,
        original_tests_passed=True, agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass, arch_checks=arch, unrelated=unrelated,
        fmt_ok=fmt_ok and vet_ok, diff_added=added, diff_limit=10 * TASK["reference_diff_lines"],
        rubric=TASK["rubric"])
    details["arch_checks"] = arch
    details["hidden_results"] = hidden
    checks = {"build_passed": build_ok, "tests_passed": None,  # no original suite in a greenfield repo
              "lint_passed": vet_ok, "format_passed": fmt_ok, "typecheck_passed": None}
    evalkit.write_result(a.out, TASK["id"], checks, scored, details)


if __name__ == "__main__":
    main()
