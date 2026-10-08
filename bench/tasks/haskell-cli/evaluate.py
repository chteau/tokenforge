#!/usr/bin/env python3
"""Evaluator for haskell-cli: the cells spreadsheet evaluator built from scratch with GHC + make."""
import argparse
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "runner"))
import evalkit as ek  # noqa: E402

TASK = json.loads((HERE / "task.json").read_text())
HIDDEN_SCRIPT = HERE / "hidden" / "test_cells.py"
GROUPS = {
    "grid_input": ["grid_"],
    "arithmetic": ["arith_"],
    "functions": ["func_"],
    "errors": ["err_"],
    "cycles": ["cycle_"],
    "output": ["out_"],
    "command_line": ["cli_"],
}
TOOL_PATH = os.pathsep.join([
    "/home/linuxbrew/.linuxbrew/bin", str(Path.home() / ".cargo/bin"), str(Path.home() / ".local/bin"),
    "/usr/local/bin", "/usr/bin", "/bin"])
IMPURE = re.compile(r"\bIO\b|^\s*import\s+(?:qualified\s+)?(?:System\.(?:IO|Exit|Environment|Directory|Process)"
                    r"|Data\.IORef|Control\.Concurrent)\b", re.M)
UNSAFE = re.compile(r"\bunsafePerformIO\b|\bunsafeCoerce\b|\bfromJust\b")
WARN_OFF = re.compile(r"(?<![\w-])-w(?![\w-])|-Wno-|-Wwarn\b")


def strip_comments(text):
    text = re.sub(r"\{-(?!#).*?-\}", " ", text, flags=re.S)
    text = re.sub(r'"(?:\\.|[^"\\\n])*"', '""', text)
    return re.sub(r"--[^\n]*", "", text)


def hs_files(repo, top):
    d = repo / top
    return {str(p.relative_to(repo)): p.read_text(errors="replace")
            for p in sorted(d.rglob("*.hs")) if "build" not in p.relative_to(repo).parts} if d.is_dir() else {}


def arch_checks(repo):
    lib = hs_files(repo, "src")
    app = hs_files(repo, "app")
    code = {k: strip_comments(v) for k, v in lib.items()}
    sizes = {k: len([l for l in v.splitlines() if l.strip()]) for k, v in {**lib, **app}.items()}
    total = sum(sizes.values())
    return {
        "modules_separated": len(lib) >= 4 and total > 0 and max(sizes.values()) <= 0.5 * total,
        "export_lists": bool(code) and all(re.search(r"\bmodule\s+[\w.]+\s*\(", v) for v in code.values()),
        # Parsing and evaluation stay pure: no IO outside app/.
        "pure_core": bool(code) and not any(IMPURE.search(v) for v in code.values()),
        "no_unsafe_or_partial": bool(code) and not any(
            UNSAFE.search(strip_comments(v)) for v in {**lib, **app}.values()),
    }


def hidden_names():
    return re.findall(r"@test\s*\ndef\s+(\w+)", HIDDEN_SCRIPT.read_text())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    repo = ek.scratch_copy(a.workspace)
    files = ek.changed_files(repo, a.base)
    diff_added, diff_removed = ek.diff_size(repo, a.base)
    unrelated = ek.unrelated_changes(files, TASK["allowed_change_globs"])

    home = Path(tempfile.mkdtemp(prefix="tfbench-ghc-"))
    env = {"PATH": TOOL_PATH, "HOME": str(home), "XDG_CACHE_HOME": str(home / "cache"),
           "XDG_CONFIG_HOME": str(home / "config"), "XDG_DATA_HOME": str(home / "data"),
           "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
    make = shutil.which("make", path=TOOL_PATH) or "make"
    shutil.rmtree(repo / "build", ignore_errors=True)
    binary = repo / "build" / "cells"

    build_out, build_passed = "", False
    if (repo / "Makefile").is_file():
        rc, build_out = ek.sh([make, "build"], repo, timeout=900, env=env)
        build_passed = rc == 0 and binary.is_file()
    else:
        build_out = "no Makefile"

    makefile = (repo / "Makefile").read_text(errors="replace") if (repo / "Makefile").is_file() else ""
    pragmas = "\n".join(re.findall(r"\{-#\s*OPTIONS_GHC[^#]*#-\}", "\n".join(
        {**hs_files(repo, "src"), **hs_files(repo, "app")}.values())))
    warnings = re.findall(r"^.*\bwarning:.*$", build_out, flags=re.M)
    flags_ok = "-Wall" in makefile and not WARN_OFF.search(strip_comments(makefile) + "\n" + pragmas)
    lint_passed = build_passed and not warnings and flags_ok

    # Agent tests: Haskell sources under test/, run by `make test`.
    agent_tests_added = any(re.match(r"test/.*\.hs$", f) for f in files)
    agent_tests_pass = False
    test_out = ""
    if build_passed and agent_tests_added:
        rc, test_out = ek.sh([make, "test"], repo, timeout=900, env=env)
        agent_tests_pass = rc == 0

    hidden, hidden_out = {}, ""
    if build_passed:
        _, hidden_out = ek.sh([sys.executable, "-I", str(HIDDEN_SCRIPT), str(binary)], repo,
                              timeout=600, env={"PATH": TOOL_PATH})
        for m in re.finditer(r"^(PASS|FAIL) (\w+)", hidden_out, flags=re.M):
            hidden[m.group(2)] = m.group(1) == "PASS"
    hidden = {n: hidden.get(n, False) for n in hidden_names()}

    arch = arch_checks(repo)

    scored = ek.score_coding(
        build_passed=build_passed, hidden_results=hidden, requirement_groups=GROUPS,
        original_tests_passed=True, agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass, arch_checks=arch, unrelated=unrelated,
        fmt_ok=lint_passed, diff_added=diff_added, diff_limit=10 ** 9, rubric=TASK["rubric"])
    checks = {"build_passed": build_passed, "tests_passed": True, "lint_passed": lint_passed,
              "format_passed": None, "typecheck_passed": None}
    details = {"changed_files": files, "unrelated": unrelated, "diff": [diff_added, diff_removed],
               "agent_tests_added": agent_tests_added, "agent_tests_pass": agent_tests_pass,
               "arch_checks": arch, "hidden": hidden, "warnings": warnings[:20],
               "makefile_sets_wall": flags_ok,
               "hidden_failures": [l for l in hidden_out.splitlines() if l.startswith("FAIL")][:30],
               "test_output": test_out[-2000:] if agent_tests_added and not agent_tests_pass else "",
               "build_output": build_out[-2000:] if not build_passed else ""}
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)
    shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    main()
