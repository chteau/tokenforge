#!/usr/bin/env python3
"""Evaluator for lua-cli: the tpl Mustache-style template engine built from scratch in Lua 5.5."""
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
HIDDEN_SCRIPT = HERE / "hidden" / "test_tpl.py"
GROUPS = {
    "variables": ["vars_"],
    "sections": ["sections_"],
    "standalone_lines": ["standalone_"],
    "partials": ["partials_"],
    "delimiters": ["delims_"],
    "template_errors": ["errors_"],
    "json_data": ["json_"],
    "command_line": ["cli_"],
}
TOOL_PATH = os.pathsep.join(["/home/linuxbrew/.linuxbrew/bin", os.path.expanduser("~/.local/bin"),
                             "/usr/local/bin", "/usr/bin", "/bin", os.environ.get("PATH", "")])
STDLIB_MODULES = {"string", "table", "math", "io", "os", "utf8", "coroutine", "debug", "package"}
GLOBAL_WRITE = re.compile(r"\bSETTABUP\b.*;\s*_ENV\s+\"([^\"]+)\"")
REQUIRE = re.compile(r"\brequire\s*\(?\s*[\"']([^\"']+)[\"']")
SUMMARY = re.compile(r"^tests: (\d+), failures: (\d+)\s*$", re.M)


def tracked(repo):
    _, out = ek.sh(["git", "ls-files", "-co", "--exclude-standard"], repo)
    return [l for l in out.splitlines() if (repo / l).is_file()]


def strip_comments(text):
    text = re.sub(r"--\[(=*)\[.*?\]\1\]", "", text, flags=re.S)
    return re.sub(r"--[^\n]*", "", text)


def arch_checks(repo, modules, global_writes):
    sizes = {k: len([l for l in v.splitlines() if l.strip()]) for k, v in modules.items()}
    total = sum(sizes.values())
    split = len(modules) >= 4 and total > 0 and max(sizes.values()) <= 0.5 * total
    binf = repo / "bin" / "tpl"
    bin_text = binf.read_text(errors="replace") if binf.is_file() else ""
    thin = bool(bin_text) and len([l for l in bin_text.splitlines() if l.strip()]) <= 15
    code = "\n".join(strip_comments(t) for t in list(modules.values()) + [bin_text])
    reqs = set(REQUIRE.findall(code))
    local_requires = bool(modules) and all(r.startswith("tpl.") or r in STDLIB_MODULES for r in reqs)
    return {"split_into_modules": split, "thin_executable": thin,
            "no_global_variables": bool(modules) and not global_writes,
            "only_project_modules_required": local_requires}


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
    lua = shutil.which("lua", path=TOOL_PATH) or "lua"
    luac = shutil.which("luac", path=TOOL_PATH) or "luac"
    env = {"PATH": TOOL_PATH, "LUA_PATH": ";;", "LUA_CPATH": ";;", "LUA_INIT": "", "LANG": "C.UTF-8"}

    all_files = tracked(repo)
    modules = {f: (repo / f).read_text(errors="replace") for f in all_files
               if f.startswith("tpl/") and f.endswith(".lua")}
    sources = sorted(modules) + (["bin/tpl"] if (repo / "bin" / "tpl").is_file() else [])

    # Build: every source compiles, globals assignments are collected, and the tool starts.
    syntax_ok, global_writes, build_out = bool(modules), [], ""
    for rel in sources:
        rc, out = ek.sh([luac, "-p", "-l", "-l", rel], repo, timeout=30, env=env)
        if rc != 0:
            syntax_ok = False
            build_out += out
        global_writes += [f"{rel}: {m}" for m in GLOBAL_WRITE.findall(out)]
    build_passed = False
    if syntax_ok and "bin/tpl" in sources:
        rc, out = ek.sh([lua, "bin/tpl", "--help"], repo, timeout=30, env=env)
        build_passed = rc == 0 and "Usage: tpl" in out
        build_out += out
    lint_passed = build_passed and not global_writes

    # Agent tests: the self-written runner.
    agent_tests_added = any(f.startswith("tests/") and f.endswith(".lua") for f in all_files) \
        and (repo / "tests" / "run.lua").is_file()
    agent_tests_pass = False
    test_out = ""
    if agent_tests_added and build_passed:
        rc, test_out = ek.sh([lua, "tests/run.lua"], repo, timeout=300, env=env)
        m = SUMMARY.findall(test_out)
        agent_tests_pass = rc == 0 and bool(m) and int(m[-1][0]) > 0 and int(m[-1][1]) == 0

    hidden = {}
    hidden_out = ""
    if build_passed:
        _, hidden_out = ek.sh([sys.executable, "-I", str(HIDDEN_SCRIPT), lua, str(repo)], repo.parent,
                              timeout=600, env=env)
        for m in re.finditer(r"^(PASS|FAIL) (\w+)", hidden_out, flags=re.M):
            hidden[m.group(2)] = m.group(1) == "PASS"
    hidden = {n: hidden.get(n, False) for n in hidden_names()}

    arch = arch_checks(repo, modules, global_writes)

    scored = ek.score_coding(
        build_passed=build_passed, hidden_results=hidden, requirement_groups=GROUPS,
        original_tests_passed=True, agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass, arch_checks=arch, unrelated=unrelated,
        fmt_ok=lint_passed, diff_added=diff_added, diff_limit=10 ** 9, rubric=TASK["rubric"])
    checks = {"build_passed": build_passed, "tests_passed": True, "lint_passed": lint_passed,
              "format_passed": None, "typecheck_passed": None}
    details = {"changed_files": files, "unrelated": unrelated, "diff": [diff_added, diff_removed],
               "agent_tests_added": agent_tests_added, "agent_tests_pass": agent_tests_pass,
               "arch_checks": arch, "hidden": hidden, "global_writes": global_writes[:20],
               "hidden_failures": [l for l in hidden_out.splitlines() if l.startswith("FAIL")][:30],
               "agent_test_output": test_out[-1500:] if agent_tests_added and not agent_tests_pass else "",
               "build_output": build_out[-2000:] if not build_passed else ""}
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
