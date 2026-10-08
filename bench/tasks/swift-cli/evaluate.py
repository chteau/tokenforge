#!/usr/bin/env python3
"""Evaluator for swift-cli: the cronx cron expression tool built from scratch with SwiftPM."""
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
HIDDEN_SCRIPT = HERE / "hidden" / "test_cronx.py"
GROUPS = {
    "command_line": ["cli_"],
    "parsing": ["parse_"],
    "validation_errors": ["error_"],
    "next_runs": ["next_"],
    "day_rule": ["dayrule_"],
    "offsets": ["offset_"],
    "calendar": ["calendar_"],
    "explain": ["explain_"],
}
SEARCH_PATH = os.pathsep.join(["/home/linuxbrew/.linuxbrew/bin", str(Path.home() / ".cargo/bin"),
                               str(Path.home() / ".local/bin"), "/usr/local/bin", "/usr/bin",
                               os.environ.get("PATH", "")])
IO_PATTERNS = re.compile(r"\bprint\s*\(|\bexit\s*\(|\bfputs\s*\(|\bFileHandle\.standard|\bCommandLine\b"
                         r"|\breadLine\s*\(")


def strip_comments(text):
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r"//[^\n]*", "", text)
    text = re.sub(r'"""(?:.|\n)*?"""', '""', text)
    return re.sub(r'"(?:\\.|[^"\\\n])*"', '""', text)


def target_sources(repo):
    """{target dir name: {relative path: text}} for Swift files under Sources/."""
    root = repo / "Sources"
    res = {}
    if root.is_dir():
        for p in sorted(root.rglob("*.swift")):
            rel = p.relative_to(root)
            target = rel.parts[0] if len(rel.parts) > 1 else ""
            res.setdefault(target, {})[str(p.relative_to(repo))] = p.read_text(errors="replace")
    return res


def arch_checks(repo):
    targets = target_sources(repo)
    names = ("library_and_thin_executable", "split_into_files", "io_only_in_executable",
             "readme_documents_build")
    if not targets:
        return {n: False for n in names}
    exe = [t for t, files in targets.items()
           if any(Path(k).name == "main.swift" or re.search(r"^\s*@main\b", v, re.M) for k, v in files.items())]
    count = lambda text: len([l for l in text.splitlines() if l.strip()])
    total = sum(count(v) for files in targets.values() for v in files.values()) or 1
    exe_lines = sum(count(v) for t in exe for v in targets[t].values())
    libs = {t: files for t, files in targets.items() if t not in exe and t}
    thin = len(exe) == 1 and bool(libs) and exe_lines <= 0.35 * total
    lib_files = {k: count(v) for files in libs.values() for k, v in files.items()}
    split = len(lib_files) >= 3 and max(lib_files.values()) <= 0.6 * sum(lib_files.values())
    io_targets = {t for t, files in targets.items()
                  if any(IO_PATTERNS.search(strip_comments(v)) for v in files.values())}
    io_ok = bool(exe) and io_targets <= set(exe)
    readme = repo / "README.md"
    readme_ok = readme.is_file() and "swift build" in readme.read_text(errors="replace")
    return dict(zip(names, (thin, split, io_ok, readme_ok)))


def hidden_names():
    return re.findall(r"@test\s*\ndef\s+(\w+)", HIDDEN_SCRIPT.read_text())


def count_tests(out):
    n = sum(int(m) for m in re.findall(r"Test run with (\d+) tests?", out))
    n += sum(int(m) for m in re.findall(r"^\s*Executed (\d+) tests?", out, flags=re.M)[-1:])
    return n


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

    # Fresh build; keep every SwiftPM/clang cache inside the scratch area, not in $HOME.
    for d in (".build", ".swiftpm"):
        shutil.rmtree(repo / d, ignore_errors=True)
    home = repo.parent / "home"
    home.mkdir(exist_ok=True)
    env = {"PATH": SEARCH_PATH, "HOME": str(home), "XDG_CACHE_HOME": str(home / ".cache"),
           "TERM": "dumb", "NO_COLOR": "1"}
    swift = shutil.which("swift", path=SEARCH_PATH)
    build_out = ""
    build_passed = False
    binary = None
    if not swift:
        build_out = "swift not found"
    elif not (repo / "Package.swift").is_file():
        build_out = "no Package.swift"
    else:
        rc, build_out = ek.sh([swift, "build"], repo, timeout=900, env=env)
        if rc == 0:
            _, bin_path = ek.sh([swift, "build", "--show-bin-path"], repo, timeout=300, env=env)
            lines = [l for l in bin_path.splitlines() if l.strip().startswith("/")]
            if lines:
                cand = Path(lines[-1].strip()) / "cronx"
                if cand.is_file():
                    binary = cand
        build_passed = rc == 0 and binary is not None
    warnings = re.findall(r"^.*\bwarning:.*$", build_out, flags=re.M)
    lint_passed = build_passed and not warnings

    agent_tests_added = agent_tests_pass = False
    test_count = 0
    tests_out = ""
    if build_passed and (repo / "Tests").is_dir():
        rc, tests_out = ek.sh([swift, "test"], repo, timeout=900, env=env)
        test_count = count_tests(tests_out)
        agent_tests_added = test_count > 0
        agent_tests_pass = agent_tests_added and rc == 0

    hidden = {}
    hidden_out = ""
    if build_passed:
        _, hidden_out = ek.sh([sys.executable, "-I", str(HIDDEN_SCRIPT), str(binary)], repo, timeout=600, env=env)
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
               "agent_test_count": test_count, "arch_checks": arch, "hidden": hidden,
               "warnings": warnings[:20],
               "hidden_failures": [l for l in hidden_out.splitlines() if l.startswith("FAIL")][:30],
               "agent_tests_output": tests_out[-1500:] if not agent_tests_pass else "",
               "build_output": build_out[-2000:] if not build_passed else ""}
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
