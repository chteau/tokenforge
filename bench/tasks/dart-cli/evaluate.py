#!/usr/bin/env python3
"""Evaluator for dart-cli: the `habits` streak tracker built from scratch in Dart."""
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
HIDDEN_SCRIPT = HERE / "hidden" / "test_habits.py"
GROUPS = {
    "habits": ["habits_"],
    "marking": ["mark_"],
    "dates": ["date_"],
    "day_streaks": ["streak_"],
    "weekly_streaks": ["weekly_"],
    "report": ["report_"],
    "storage": ["store_"],
    "command_line": ["cli_"],
}
TOOL_DIRS = ["/home/cheeteau/fvm/default/bin", "/home/linuxbrew/.linuxbrew/bin",
             os.path.expanduser("~/.cargo/bin"), os.path.expanduser("~/.local/bin"),
             "/usr/local/bin", "/usr/bin", "/bin"]
TOOL_PATH = os.pathsep.join(TOOL_DIRS)
ENV = {"PATH": TOOL_PATH, "DART_SUPPRESS_ANALYTICS": "true", "PUB_ENVIRONMENT": "eval"}
# File-system calls that read or write the data file.
FILE_IO = re.compile(r"\.(?:readAsString|readAsBytes|readAsLines|writeAsString|writeAsBytes|"
                     r"openWrite|openRead|open|rename|copy)(?:Sync)?\s*\(")


def strip_comments(text):
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r"//[^\n]*", "", text)
    return re.sub(r"'''.*?'''|\"\"\".*?\"\"\"|'(?:\\.|[^'\\\n])*'|\"(?:\\.|[^\"\\\n])*\"",
                  "''", text, flags=re.S)


def dart_sources(repo, top):
    d = repo / top
    if not d.is_dir():
        return {}
    return {str(p.relative_to(repo)): p.read_text(errors="replace")
            for p in sorted(d.rglob("*.dart")) if ".dart_tool" not in p.parts}


def nonblank(text):
    return len([l for l in text.splitlines() if l.strip()])


def no_dependencies(repo):
    pub = repo / "pubspec.yaml"
    if not pub.is_file():
        return False
    text = pub.read_text(errors="replace")
    m = re.findall(r"^(dependencies|dev_dependencies|dependency_overrides):[ \t]*(.*)$\n?((?:[ \t]+\S.*\n?)*)",
                   text, flags=re.M)
    return all(rest.strip() in ("", "{}") and not body.strip() for _, rest, body in m)


def arch_checks(repo):
    lib = dart_sources(repo, "lib")
    entry = repo / "bin" / "habits.dart"
    entry_text = entry.read_text(errors="replace") if entry.is_file() else ""
    sizes = {k: nonblank(v) for k, v in lib.items()}
    if entry_text:
        sizes["bin/habits.dart"] = nonblank(entry_text)
    total = sum(sizes.values()) or 1
    io_files = {k for k, v in {**lib, "bin/habits.dart": entry_text}.items()
                if FILE_IO.search(strip_comments(v))}
    return {
        # Logic split into several libraries under lib/.
        "split_into_libraries": len(lib) >= 3,
        # No single file holds most of the code.
        "no_god_file": bool(sizes) and max(sizes.values()) <= 0.6 * total,
        # bin/habits.dart only wires the command line to the library.
        "thin_entrypoint": bool(entry_text) and nonblank(strip_comments(entry_text)) <= 30,
        # Data-file reads and writes live in exactly one storage library.
        "single_storage_library": len(io_files) == 1,
        # No pub packages.
        "no_dependencies": no_dependencies(repo),
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

    dart = shutil.which("dart", path=TOOL_PATH)
    shutil.rmtree(repo / ".dart_tool", ignore_errors=True)
    shutil.rmtree(repo / "build", ignore_errors=True)
    exe = repo.parent / "habits-exe"
    build_out = ""
    build_passed = False
    if dart is None:
        build_out = "dart not found"
    elif not (repo / "pubspec.yaml").is_file() or not (repo / "bin" / "habits.dart").is_file():
        build_out = "missing pubspec.yaml or bin/habits.dart"
    else:
        rc, out = ek.sh([dart, "pub", "get", "--offline"], repo, timeout=180, env=ENV)
        build_out = out
        if rc == 0:
            rc, out = ek.sh([dart, "compile", "exe", "bin/habits.dart", "-o", str(exe)],
                            repo, timeout=300, env=ENV)
            build_out += out
        build_passed = rc == 0 and exe.is_file()

    lint_passed = format_passed = False
    analyze_out = ""
    if build_passed:
        rc, analyze_out = ek.sh([dart, "analyze", "--fatal-infos", "--fatal-warnings"], repo,
                                timeout=300, env=ENV)
        lint_passed = rc == 0
        dirs = [d for d in ("bin", "lib", "test") if (repo / d).is_dir()]
        rc, _ = ek.sh([dart, "format", "--output=none", "--set-exit-if-changed", *dirs], repo,
                      timeout=120, env=ENV)
        format_passed = rc == 0

    # Agent tests: test/**/*_test.dart, each run with `dart run`.
    test_files = sorted(str(p.relative_to(repo)) for p in (repo / "test").rglob("*_test.dart")) \
        if (repo / "test").is_dir() else []
    agent_tests_added = bool(test_files)
    agent_tests_pass = False
    test_failures = []
    if agent_tests_added and build_passed:
        for t in test_files:
            rc, out = ek.sh([dart, "run", t], repo, timeout=180, env=ENV)
            if rc != 0:
                test_failures.append(f"{t}: rc={rc} {out[-300:]}")
        agent_tests_pass = not test_failures

    hidden = {}
    hidden_out = ""
    if build_passed:
        _, hidden_out = ek.sh([sys.executable, "-I", str(HIDDEN_SCRIPT), str(exe)],
                              repo.parent, timeout=300)
        for m in re.finditer(r"^(PASS|FAIL) (\w+)", hidden_out, flags=re.M):
            hidden[m.group(2)] = m.group(1) == "PASS"
    hidden = {n: hidden.get(n, False) for n in hidden_names()}

    arch = arch_checks(repo)

    scored = ek.score_coding(
        build_passed=build_passed, hidden_results=hidden, requirement_groups=GROUPS,
        original_tests_passed=True, agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass, arch_checks=arch, unrelated=unrelated,
        fmt_ok=lint_passed and format_passed, diff_added=diff_added, diff_limit=10 ** 9,
        rubric=TASK["rubric"])
    checks = {"build_passed": build_passed, "tests_passed": True, "lint_passed": lint_passed,
              "format_passed": format_passed, "typecheck_passed": None}
    details = {"changed_files": files, "unrelated": unrelated, "diff": [diff_added, diff_removed],
               "agent_tests_added": agent_tests_added, "agent_tests_pass": agent_tests_pass,
               "agent_test_files": test_files, "agent_test_failures": test_failures[:10],
               "arch_checks": arch, "hidden": hidden,
               "analyze_output": analyze_out[-1500:] if not lint_passed else "",
               "hidden_failures": [l for l in hidden_out.splitlines() if l.startswith("FAIL")][:30],
               "build_output": build_out[-2000:] if not build_passed else ""}
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
