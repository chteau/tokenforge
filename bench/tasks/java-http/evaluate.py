#!/usr/bin/env python3
"""Evaluator for java-http: the shorty URL-shortener service built from scratch on the JDK."""
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
HIDDEN_SCRIPT = HERE / "hidden" / "test_shorty.py"
GROUPS = {
    "create": ["create_"],
    "validation": ["validate_"],
    "redirects": ["redirect_"],
    "manage_links": ["manage_"],
    "stats": ["stats_"],
    "persistence": ["persist_"],
    "rate_limit": ["limit_"],
    "http_and_cli": ["http_"],
}
TOOL_PATH = os.pathsep.join([
    "/home/linuxbrew/.linuxbrew/bin", str(Path.home() / ".cargo/bin"), str(Path.home() / ".local/bin"),
    "/usr/local/bin", "/usr/bin", "/bin"])
JAVA = shutil.which("java", path=TOOL_PATH) or "java"
JAVAC = shutil.which("javac", path=TOOL_PATH) or "javac"
BASH = shutil.which("bash", path=TOOL_PATH) or "bash"
WRITE_PATTERNS = re.compile(
    r"\bFiles\s*\.\s*(?:write|writeString|move|copy|newBufferedWriter|newOutputStream)\s*\("
    r"|\bnew\s+(?:FileWriter|FileOutputStream|RandomAccessFile)\b"
    r"|\bnew\s+PrintWriter\s*\(\s*new\s+File\b")
JDK_IMPORT = re.compile(r"^(?:java|javax|jdk|com\.sun\.net\.httpserver)\.")


def strip_comments(text):
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r"//[^\n]*", "", text)
    return re.sub(r'"(?:\\.|[^"\\\n])*"', '""', text)


def java_files(repo):
    """(main sources, test sources) as {relative path: text}, outside build output."""
    _, out = ek.sh(["git", "ls-files", "-co", "--exclude-standard"], repo)
    main, tests = {}, {}
    for rel in out.splitlines():
        p = Path(rel)
        if p.suffix != ".java" or p.parts[0] in ("build", "out", "target"):
            continue
        f = repo / rel
        if not f.is_file():
            continue
        (tests if any("test" in x.lower() for x in p.parts) else main)[rel] = f.read_text(errors="replace")
    return main, tests


def arch_checks(main):
    if not main:
        return {"split_into_classes": False, "named_package": False, "jdk_only_imports": False,
                "single_persistence_class": False}
    lines = {k: len([l for l in v.splitlines() if l.strip()]) for k, v in main.items()}
    total = sum(lines.values()) or 1
    split = len(main) >= 4 and max(lines.values()) <= 0.6 * total
    pkgs = {}
    for k, v in main.items():
        m = re.search(r"^\s*package\s+([\w.]+)\s*;", v, re.M)
        pkgs[k] = m.group(1) if m else None
    named = all(pkgs.values())
    own = {p for p in pkgs.values() if p}
    imports = [m.group(1) for v in main.values()
               for m in re.finditer(r"^\s*import\s+(?:static\s+)?([\w.*]+)\s*;", v, re.M)]
    jdk_only = all(JDK_IMPORT.match(i) or any(i.startswith(p + ".") for p in own) for i in imports)
    writers = {k for k, v in main.items() if WRITE_PATTERNS.search(strip_comments(v))}
    return {"split_into_classes": split, "named_package": named, "jdk_only_imports": jdk_only,
            "single_persistence_class": len(writers) == 1}


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
    env = {"PATH": os.pathsep.join([str(Path(JAVA).parent), TOOL_PATH, os.environ.get("PATH", "")]),
           "JAVA": JAVA, "LC_ALL": "C.UTF-8"}

    shutil.rmtree(repo / "build", ignore_errors=True)
    jar = repo / "build" / "shorty.jar"
    build_out = "no build.sh"
    build_passed = False
    if (repo / "build.sh").is_file():
        rc, build_out = ek.sh([BASH, "build.sh"], repo, timeout=300, env=env)
        build_passed = rc == 0 and jar.is_file()

    main_src, test_src = java_files(repo)

    # Lint: the main sources compile cleanly with every javac lint enabled.
    lint_passed = False
    lint_out = ""
    if build_passed and main_src:
        with tempfile.TemporaryDirectory(prefix="shorty-lint-") as out_dir:
            rc, lint_out = ek.sh([JAVAC, "-Xlint:all", "-d", out_dir, *sorted(main_src)], repo,
                                 timeout=300, env=env)
            lint_passed = rc == 0 and not re.search(r"warning:", lint_out)

    names = hidden_names()
    hidden, hidden_out = {}, ""
    if build_passed:
        _, hidden_out = ek.sh([sys.executable, "-I", str(HIDDEN_SCRIPT), str(jar)], repo,
                              timeout=600, env=env)
        hidden = {m.group(2): m.group(1) == "PASS"
                  for m in re.finditer(r"^(PASS|FAIL) (\w+)", hidden_out, re.M)}
    hidden = {n: hidden.get(n, False) for n in names}

    # Agent tests: test sources plus ./test.sh, which must exit 0.
    agent_tests_added = bool(test_src) and (repo / "test.sh").is_file()
    agent_tests_pass = False
    test_out = ""
    if build_passed and agent_tests_added:
        rc, test_out = ek.sh([BASH, "test.sh"], repo, timeout=300, env=env)
        agent_tests_pass = rc == 0

    arch = arch_checks(main_src)

    scored = ek.score_coding(
        build_passed=build_passed, hidden_results=hidden, requirement_groups=GROUPS,
        original_tests_passed=True, agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass, arch_checks=arch, unrelated=unrelated,
        fmt_ok=lint_passed, diff_added=diff_added, diff_limit=10 ** 9, rubric=TASK["rubric"])
    checks = {"build_passed": build_passed, "tests_passed": True, "lint_passed": lint_passed,
              "format_passed": None, "typecheck_passed": None}
    details = {"changed_files": files, "unrelated": unrelated, "diff": [diff_added, diff_removed],
               "agent_tests_added": agent_tests_added, "agent_tests_pass": agent_tests_pass,
               "arch_checks": arch, "hidden": hidden,
               "lint_output": lint_out[-1500:] if not lint_passed else "",
               "hidden_failures": [l for l in hidden_out.splitlines() if l.startswith("FAIL")][:30],
               "test_output": test_out[-1500:] if not agent_tests_pass else "",
               "build_output": build_out[-2000:] if not build_passed else ""}
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
