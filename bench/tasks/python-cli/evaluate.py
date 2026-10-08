#!/usr/bin/env python3
"""Evaluator for python-cli: the greenfield `ledgerstat` CSV report tool."""
import argparse
import ast
import json
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "runner"))
import evalkit as ek  # noqa: E402

TASK = json.loads((HERE / "task.json").read_text())
HIDDEN_MODULE = "test_hidden_ledgerstat"
GROUPS = {
    "input_parsing": ["test_input_"],
    "categories": ["test_categories_"],
    "monthly": ["test_monthly_"],
    "merchants": ["test_merchants_"],
    "budget": ["test_budget_"],
    "date_filters": ["test_filter_"],
    "output_formats": ["test_format_"],
    "bad_rows": ["test_badrows_"],
    "fatal_errors": ["test_errors_"],
    "config_errors": ["test_config_"],
    "cli": ["test_cli_"],
}
_UNITTEST = re.compile(r"^(test_\w+) \(.*?\) \.\.\. (ok|FAIL|ERROR|skipped.*)$", re.M)


def is_test_file(rel: str) -> bool:
    name = rel.rsplit("/", 1)[-1]
    return name.endswith(".py") and (name.startswith("test_") or name.endswith("_test.py"))


def package_sources(repo: Path) -> dict[str, str]:
    """Non-test .py files of the ledgerstat package."""
    pkg = repo / "ledgerstat"
    out = {}
    if pkg.is_dir():
        for p in sorted(pkg.rglob("*.py")):
            rel = str(p.relative_to(repo))
            if "__pycache__" in rel or "/tests/" in rel or is_test_file(rel):
                continue
            out[rel] = p.read_text(errors="replace")
    return out


def public_functions(src: str):
    tree = ast.parse(src)
    for node in tree.body:
        bodies = [node] if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) else (
            [n for n in node.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
            if isinstance(node, ast.ClassDef) and not node.name.startswith("_") else [])
        for fn in bodies:
            if not fn.name.startswith("_"):
                yield fn


def annotated(fn) -> bool:
    if fn.returns is not None:
        return True
    a = fn.args
    params = [p for p in a.posonlyargs + a.args + a.kwonlyargs if p.arg not in ("self", "cls")]
    return any(p.annotation is not None for p in params)


def arch_checks(repo: Path) -> dict:
    srcs = package_sources(repo)
    modules = [r for r in srcs if not r.endswith(("/__init__.py", "/__main__.py"))]
    sizes = {r: len([l for l in t.splitlines() if l.strip()]) for r, t in srcs.items()}
    total = sum(sizes.values())
    joined = "\n".join(srcs.values())
    fns, ok_parse = [], True
    for text in srcs.values():
        try:
            fns.extend(public_functions(text))
        except SyntaxError:
            ok_parse = False
    hinted = sum(annotated(f) for f in fns)
    return {
        # Parsing, reports and the command line live in separate modules.
        "modules_separated": len(modules) >= 3,
        # No single module holds most of the code.
        "no_god_module": total > 0 and max(sizes.values()) <= 0.6 * total,
        # CSV is read with the csv module, never with ad-hoc comma splitting.
        "uses_csv_module": bool(re.search(r"^\s*(import csv\b|from csv import)", joined, re.M))
        and not re.search(r"\.split\(\s*(['\"]),\1\s*\)", joined),
        # Public functions carry type hints.
        "type_hints": ok_parse and len(fns) >= 3 and hinted >= 0.8 * len(fns),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    repo = ek.scratch_copy(a.workspace)
    env = {"PYTHONDONTWRITEBYTECODE": "1", "PYTHONHASHSEED": "0"}
    files = ek.changed_files(repo, a.base)
    diff_added, diff_removed = ek.diff_size(repo, a.base)
    unrelated = ek.unrelated_changes(files, TASK["allowed_change_globs"])

    rc, cout = ek.sh("python3 -m compileall -q -x '(^|/)\\.git/' .", repo, timeout=120)
    hrc, hout = ek.sh(["python3", "-m", "ledgerstat", "--help"], repo, timeout=30, env=env)
    build_passed = rc == 0 and hrc == 0

    # Agent-written tests: any test_*.py / *_test.py file, run by unittest discovery.
    agent_tests_added = any(is_test_file(f) for f in files)
    agent_tests_pass = False
    if agent_tests_added and build_passed:
        trc, tout = ek.sh(["python3", "-m", "unittest", "discover"], repo, timeout=300, env=env)
        m = re.search(r"^Ran (\d+) tests?", tout, re.M)
        agent_tests_pass = trc == 0 and bool(m) and int(m.group(1)) > 0

    arch = arch_checks(repo)

    ek.overlay(HERE / "hidden", repo)
    hidden = {}
    if build_passed:
        _, out = ek.sh(["python3", "-m", "unittest", "-v", HIDDEN_MODULE], repo / "_hidden",
                       timeout=600, env=env)
        hidden = {m.group(1): m.group(2) == "ok" for m in _UNITTEST.finditer(out)}
    if not hidden:
        src = (HERE / "hidden" / "_hidden" / f"{HIDDEN_MODULE}.py").read_text()
        hidden = {n: False for n in re.findall(r"^    def (test_\w+)\(", src, re.M)}

    scored = ek.score_coding(
        build_passed=build_passed, hidden_results=hidden, requirement_groups=GROUPS,
        original_tests_passed=True, agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass, arch_checks=arch, unrelated=unrelated, fmt_ok=True,
        diff_added=diff_added, diff_limit=100000, rubric=TASK["rubric"])
    checks = {"build_passed": build_passed, "tests_passed": True, "lint_passed": None,
              "format_passed": None, "typecheck_passed": None}
    details = {"changed_files": files, "unrelated": unrelated, "diff": [diff_added, diff_removed],
               "agent_tests_added": agent_tests_added, "agent_tests_pass": agent_tests_pass,
               "arch_checks": arch, "hidden": hidden,
               "build_output": (cout + hout)[-2000:] if not build_passed else ""}
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
