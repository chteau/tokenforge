#!/usr/bin/env python3
import argparse, re, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "runner"))
import evalkit as ek

ap = argparse.ArgumentParser(); ap.add_argument("--workspace"); ap.add_argument("--base"); ap.add_argument("--out")
a = ap.parse_args()
task = __import__("json").loads((HERE / "task.json").read_text())
repo = ek.scratch_copy(a.workspace)
files = ek.changed_files(repo, a.base)
added, _ = ek.diff_size(repo, a.base)
rc, out = ek.sh("python3 -m unittest discover -s tests -t . -p 'test_slug.py' -v", repo)
orig_ok = rc == 0
agent_tests = any(f.startswith("tests/") for f in files)
rc2, _ = ek.sh("python3 -m unittest discover -s tests -t . -v", repo)
ek.overlay(HERE / "hidden", repo)
_, hout = ek.sh("python3 -m unittest -v tests.test_hidden_slug", repo)
hidden = {m.group(1): m.group(2) == "ok" for m in re.finditer(r"^(test_\w+) \(.*?\) \.\.\. (ok|FAIL|ERROR)", hout, re.M)}
build = "SyntaxError" not in hout
scored = ek.score_coding(build_passed=build, hidden_results=hidden,
    requirement_groups={"collapse": ["test_collapse"], "preserve": ["test_unchanged"]},
    original_tests_passed=orig_ok, agent_tests_added=agent_tests, agent_tests_pass=rc2 == 0,
    arch_checks={"fix_in_slugify": "textutil/slug.py" in files}, unrelated=ek.unrelated_changes(files, task["allowed_change_globs"]),
    fmt_ok=True, diff_added=added, diff_limit=3 * task["reference_diff_lines"] + 20, rubric="debugging")
ek.write_result(a.out, "smoke", {"build_passed": build, "tests_passed": orig_ok, "lint_passed": None,
    "format_passed": None, "typecheck_passed": None}, scored, {"changed_files": files, "hidden": hidden})
