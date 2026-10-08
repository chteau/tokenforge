#!/usr/bin/env python3
"""Evaluator for ruby-cli: the logtally access-log analyzer built from scratch in Ruby."""
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
HIDDEN_SCRIPT = HERE / "hidden" / "test_logtally.py"
GROUPS = {
    "parsing": ["parse_"],
    "gzip": ["gzip_"],
    "filters": ["filter_"],
    "text_report": ["report_"],
    "latency": ["latency_"],
    "json_output": ["json_"],
    "errors": ["errors_"],
    "command_line": ["cli_"],
}
TOOL_PATH = os.pathsep.join(["/home/linuxbrew/.linuxbrew/bin", os.path.expanduser("~/.cargo/bin"),
                             os.path.expanduser("~/.local/bin"), "/usr/local/bin", "/usr/bin",
                             os.environ.get("PATH", "")])
TEST_CMD = 'Dir.glob("test/**/*_test.rb").sort.each { |f| require File.expand_path(f) }'
SHELL_OUT = re.compile(r"%x[({\[]|\bsystem\s*\(|\bIO\.popen\b|\bOpen3\b|\bProcess\.spawn\b|`\s*(?:gunzip|zcat|gzip)\b")


def tracked(repo):
    _, out = ek.sh(["git", "ls-files", "-co", "--exclude-standard"], repo)
    return [l for l in out.splitlines() if (repo / l).is_file()]


def strip_comments(text):
    text = re.sub(r"^=begin.*?^=end", "", text, flags=re.M | re.S)
    return re.sub(r"(?m)^\s*#.*$", "", text)


def arch_checks(repo, lib):
    sub = {k: v for k, v in lib.items() if k.startswith("lib/logtally/")}
    sizes = {k: len([l for l in v.splitlines() if l.strip()]) for k, v in lib.items()}
    total = sum(sizes.values())
    split = len(sub) >= 4 and total > 0 and max(sizes.values()) <= 0.5 * total
    binf = repo / "bin" / "logtally"
    bin_text = binf.read_text(errors="replace") if binf.is_file() else ""
    thin = bool(bin_text) and len([l for l in bin_text.splitlines() if l.strip()]) <= 15
    frozen = bool(lib) and all(
        re.search(r"\A(?:#!.*\n)?(?:#.*\n)*?#\s*frozen_string_literal:\s*true", t) for t in lib.values())
    code = "\n".join(strip_comments(t) for t in lib.values())
    stdlib = ("OptionParser" in code and "Zlib::" in code and "GzipReader" in code
              and not SHELL_OUT.search(code))
    return {"split_into_files": split, "thin_executable": thin, "frozen_string_literals": frozen,
            "stdlib_optparse_and_zlib": stdlib}


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
    ruby = shutil.which("ruby", path=TOOL_PATH) or "ruby"
    env = {"PATH": TOOL_PATH, "RUBYOPT": "", "LANG": "C.UTF-8"}

    all_files = tracked(repo)
    lib = {f: (repo / f).read_text(errors="replace") for f in all_files
           if f.startswith("lib/") and f.endswith(".rb")}
    sources = sorted(lib) + (["bin/logtally"] if (repo / "bin" / "logtally").is_file() else [])

    # Build: syntax check with warnings, then the executable must start.
    syntax_ok, warnings, build_out = bool(lib), [], ""
    for rel in sources:
        rc, out = ek.sh([ruby, "-wc", rel], repo, timeout=30, env=env)
        if rc != 0:
            syntax_ok = False
            build_out += out
        warnings += [l for l in out.splitlines() if "warning:" in l]
    build_passed = False
    if syntax_ok and "bin/logtally" in sources:
        rc, out = ek.sh([ruby, "-w", "bin/logtally", "--help"], repo, timeout=30, env=env)
        build_passed = rc == 0 and "Usage: logtally" in out
        warnings += [l for l in out.splitlines() if "warning:" in l]
        build_out += out
    lint_passed = build_passed and not warnings

    # Agent tests: minitest files under test/, run with the documented command.
    test_files = [f for f in all_files if f.startswith("test/") and f.endswith("_test.rb")]
    agent_tests_added = bool(test_files)
    agent_tests_pass = False
    test_out = ""
    if agent_tests_added and build_passed:
        rc, test_out = ek.sh([ruby, "-Ilib", "-Itest", "-e", TEST_CMD], repo, timeout=300, env=env)
        m = re.search(r"^(\d+) runs, \d+ assertions, (\d+) failures, (\d+) errors", test_out, re.M)
        agent_tests_pass = rc == 0 and bool(m) and int(m.group(1)) > 0

    hidden = {}
    hidden_out = ""
    if build_passed:
        _, hidden_out = ek.sh([sys.executable, "-I", str(HIDDEN_SCRIPT), ruby, str(repo)], repo.parent,
                              timeout=600, env=env)
        for m in re.finditer(r"^(PASS|FAIL) (\w+)", hidden_out, flags=re.M):
            hidden[m.group(2)] = m.group(1) == "PASS"
    hidden = {n: hidden.get(n, False) for n in hidden_names()}

    arch = arch_checks(repo, lib)

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
               "hidden_failures": [l for l in hidden_out.splitlines() if l.startswith("FAIL")][:30],
               "agent_test_output": test_out[-1500:] if agent_tests_added and not agent_tests_pass else "",
               "build_output": build_out[-2000:] if not build_passed else ""}
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
