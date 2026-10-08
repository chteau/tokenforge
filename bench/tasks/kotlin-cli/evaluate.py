#!/usr/bin/env python3
"""Evaluator for kotlin-cli: the mdc Markdown-to-HTML converter built from scratch with kotlinc."""
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
HIDDEN_SCRIPT = HERE / "hidden" / "test_mdc.py"
GROUPS = {
    "command_line": ["cli_"],
    "front_matter": ["fm_"],
    "blocks": ["block_"],
    "inline": ["inline_"],
    "code_blocks": ["code_"],
    "lists": ["list_"],
    "tables": ["table_"],
    "slugs_toc": ["toc_"],
}
SEARCH_PATH = os.pathsep.join(["/home/linuxbrew/.linuxbrew/bin", str(Path.home() / ".cargo/bin"),
                               str(Path.home() / ".local/bin"), "/usr/local/bin", "/usr/bin",
                               os.environ.get("PATH", "")])
# Side effects that belong in the command-line entry point only.
IO_PATTERNS = re.compile(r"\bprintln\s*\(|\bprint\s*\(|\bexitProcess\s*\(|\bSystem\.exit\s*\("
                         r"|\bSystem\.(?:out|err|`in`)\b|\breadText\s*\(|\bwriteText\s*\(|\breadLine\s*\(")


def strip_comments(text):
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r"//[^\n]*", "", text)
    text = re.sub(r'"""(?:.|\n)*?"""', '""', text)
    return re.sub(r'"(?:\\.|[^"\\\n])*"', '""', text)


def main_sources(repo):
    root = repo / "src" / "main" / "kotlin"
    if not root.is_dir():
        return {}
    return {str(p.relative_to(repo)): p.read_text(errors="replace") for p in sorted(root.rglob("*.kt"))}


def arch_checks(repo):
    srcs = main_sources(repo)
    if not srcs:
        return {"split_into_files": False, "declares_package": False,
                "pure_conversion": False, "readme_documents_build": False}
    lines = {k: len([l for l in v.splitlines() if l.strip()]) for k, v in srcs.items()}
    total = sum(lines.values()) or 1
    split = len(srcs) >= 3 and max(lines.values()) <= 0.6 * total
    package = all(re.search(r"^\s*package\s+[\w.]+", v, re.M) for v in srcs.values())
    io_files = [k for k, v in srcs.items() if IO_PATTERNS.search(strip_comments(v))]
    pure = len(io_files) <= 1
    readme = repo / "README.md"
    readme_ok = readme.is_file() and "kotlinc" in readme.read_text(errors="replace")
    return {"split_into_files": split, "declares_package": package, "pure_conversion": pure,
            "readme_documents_build": readme_ok}


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

    kotlinc = shutil.which("kotlinc", path=SEARCH_PATH)
    java = shutil.which("java", path=SEARCH_PATH)
    env = {"PATH": SEARCH_PATH}
    shutil.rmtree(repo / "build", ignore_errors=True)
    jar = repo / "build" / "mdc.jar"
    build_out = ""
    build_passed = False
    if not kotlinc or not java:
        build_out = "kotlinc/java not found"
    elif not (repo / "src" / "main" / "kotlin").is_dir():
        build_out = "no src/main/kotlin"
    else:
        rc, build_out = ek.sh([kotlinc, "src/main/kotlin", "-include-runtime", "-d", "build/mdc.jar"],
                              repo, timeout=600, env=env)
        if rc == 0 and jar.is_file():
            rc2, out = ek.sh([java, "-jar", str(jar), "--help"], repo, timeout=60, env=env)
            build_passed = rc2 == 0 and out.startswith("usage: mdc")
            if not build_passed:
                build_out += "\n--help failed:\n" + out
    warnings = re.findall(r"^.*\bwarning:.*$", build_out, flags=re.M)
    lint_passed = build_passed and not warnings

    # The agent's own tests: src/test/kotlin compiled against the jar, entry point TestMainKt.
    agent_tests_added = agent_tests_pass = False
    tests_out = ""
    if build_passed and (repo / "src" / "test" / "kotlin" / "TestMain.kt").is_file():
        rc, tests_out = ek.sh([kotlinc, "src/test/kotlin", "-cp", "build/mdc.jar", "-d", "build/test-classes"],
                              repo, timeout=600, env=env)
        agent_tests_added = rc == 0 and (repo / "build" / "test-classes" / "TestMainKt.class").is_file()
        if agent_tests_added:
            rc, out = ek.sh([java, "-cp", f"build/mdc.jar{os.pathsep}build/test-classes", "TestMainKt"],
                            repo, timeout=300, env=env)
            tests_out += out
            agent_tests_pass = rc == 0

    hidden = {}
    hidden_out = ""
    if build_passed:
        _, hidden_out = ek.sh([sys.executable, "-I", str(HIDDEN_SCRIPT), str(jar)], repo, timeout=600, env=env)
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
               "hidden_failures": [l for l in hidden_out.splitlines() if l.startswith("FAIL")][:30],
               "agent_tests_output": tests_out[-1500:] if not agent_tests_pass else "",
               "build_output": build_out[-2000:] if not build_passed else ""}
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
