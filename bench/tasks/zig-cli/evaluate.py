#!/usr/bin/env python3
"""Evaluator for zig-cli: the zj JSON toolkit built from scratch with `zig build`."""
import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "runner"))
import evalkit as ek  # noqa: E402

TASK = json.loads((HERE / "task.json").read_text())
HIDDEN_SCRIPT = HERE / "hidden" / "test_zj.py"
GROUPS = {
    "validate": ["validate_"],
    "error_positions": ["errpos_"],
    "unicode": ["unicode_"],
    "fmt_min": ["fmt_", "min_"],
    "sort_keys": ["sort_"],
    "query": ["query_"],
    "deep_nesting": ["deep_"],
    "command_line": ["cli_"],
}
TOOL_PATH = os.pathsep.join([
    "/home/linuxbrew/.linuxbrew/bin", str(Path.home() / ".cargo/bin"), str(Path.home() / ".local/bin"),
    "/usr/local/bin", "/usr/bin", "/bin"])
TEST_BLOCK = re.compile(r'^\s*test\s*(?:"[^"\n]*"|[A-Za-z_]\w*)?\s*\{', re.M)


def strip_comments(text):
    text = re.sub(r'"(?:\\.|[^"\\\n])*"', '""', text)
    return re.sub(r"//[^\n]*", "", text)


def zig_files(repo):
    """{relative path: text} of the project's .zig files (tracked or untracked, not ignored)."""
    _, out = ek.sh(["git", "ls-files", "-co", "--exclude-standard"], repo)
    res = {}
    for rel in out.splitlines():
        p = repo / rel
        parts = Path(rel).parts
        if rel.endswith(".zig") and p.is_file() and not any(x in (".zig-cache", "zig-out") for x in parts):
            res[rel] = p.read_text(errors="replace")
    return res


def arch_checks(files):
    src = {k: v for k, v in files.items() if k.startswith("src/")}
    # Code outside test blocks is hard to separate reliably; count non-blank lines per file.
    sizes = {k: len([l for l in v.splitlines() if l.strip()]) for k, v in src.items()}
    total = sum(sizes.values())
    code = {k: strip_comments(v) for k, v in src.items()}
    tests = sum(len(TEST_BLOCK.findall(v)) for v in files.values())
    return {
        # Parser, output, queries and the command line live in separate files.
        "split_into_modules": len(src) >= 3,
        "no_god_file": total > 0 and max(sizes.values()) <= 0.6 * total,
        # The parser is hand-written, as required.
        "own_parser": bool(src) and not any(re.search(r"\bstd\s*\.\s*json\b", v) for v in code.values()),
        "no_mutable_globals": bool(src) and not any(
            re.search(r"^(?:pub\s+)?var\s", v, re.M) for v in code.values()),
        "unit_tests": tests >= 5,
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

    env = {"PATH": TOOL_PATH, "NO_COLOR": "1"}
    zig = shutil.which("zig", path=TOOL_PATH) or "zig"
    for d in ("zig-out", ".zig-cache"):
        shutil.rmtree(repo / d, ignore_errors=True)
    binary = repo / "zig-out" / "bin" / "zj"

    build_out, build_passed = "", False
    if (repo / "build.zig").is_file():
        rc, build_out = ek.sh([zig, "build"], repo, timeout=600, env=env)
        build_passed = rc == 0 and binary.is_file()
    else:
        build_out = "no build.zig"

    sources = zig_files(repo)
    fmt_ok = False
    if sources:
        rc, _ = ek.sh([zig, "fmt", "--check", *sorted(sources)], repo, timeout=120, env=env)
        fmt_ok = rc == 0

    # Agent tests: Zig test blocks run by `zig build test`.
    agent_tests_added = any(TEST_BLOCK.search(v) for v in sources.values())
    agent_tests_pass = False
    test_out = ""
    if build_passed and agent_tests_added:
        rc, test_out = ek.sh([zig, "build", "test"], repo, timeout=600, env=env)
        agent_tests_pass = rc == 0

    hidden, hidden_out = {}, ""
    if build_passed:
        _, hidden_out = ek.sh([sys.executable, "-I", str(HIDDEN_SCRIPT), str(binary)], repo, timeout=600)
        for m in re.finditer(r"^(PASS|FAIL) (\w+)", hidden_out, flags=re.M):
            hidden[m.group(2)] = m.group(1) == "PASS"
    hidden = {n: hidden.get(n, False) for n in hidden_names()}

    arch = arch_checks(sources)

    scored = ek.score_coding(
        build_passed=build_passed, hidden_results=hidden, requirement_groups=GROUPS,
        original_tests_passed=True, agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass, arch_checks=arch, unrelated=unrelated,
        fmt_ok=fmt_ok, diff_added=diff_added, diff_limit=10 ** 9, rubric=TASK["rubric"])
    checks = {"build_passed": build_passed, "tests_passed": True, "lint_passed": None,
              "format_passed": fmt_ok, "typecheck_passed": None}
    details = {"changed_files": files, "unrelated": unrelated, "diff": [diff_added, diff_removed],
               "agent_tests_added": agent_tests_added, "agent_tests_pass": agent_tests_pass,
               "arch_checks": arch, "hidden": hidden,
               "hidden_failures": [l for l in hidden_out.splitlines() if l.startswith("FAIL")][:30],
               "test_output": test_out[-2000:] if agent_tests_added and not agent_tests_pass else "",
               "build_output": build_out[-2000:] if not build_passed else ""}
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
