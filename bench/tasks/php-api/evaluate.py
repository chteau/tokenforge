#!/usr/bin/env python3
"""Evaluator for php-api: the boxoffice event-ticketing JSON API built from scratch in PHP."""
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
HIDDEN_SCRIPT = HERE / "hidden" / "test_boxoffice.py"
GROUPS = {
    "events": ["events_"],
    "holds": ["holds_"],
    "purchases": ["purchase_"],
    "refunds": ["refund_"],
    "idempotency": ["idem_"],
    "http_contract": ["http_"],
    "persistence": ["persist_"],
}
TOOL_PATH = os.pathsep.join(["/home/linuxbrew/.linuxbrew/bin", os.path.expanduser("~/.cargo/bin"),
                             os.path.expanduser("~/.local/bin"), "/usr/local/bin", "/usr/bin",
                             os.environ.get("PATH", "")])
SQL_WORD = re.compile(r"\b(SELECT|INSERT|UPDATE|DELETE|WHERE|VALUES)\b", re.I)
PHP_ISSUE = re.compile(r"PHP (Warning|Notice|Deprecated|Fatal error|Parse error)\b.*")


def php_files(repo):
    """{relative path: text} of PHP files in the working tree (tracked or untracked)."""
    _, out = ek.sh(["git", "ls-files", "-co", "--exclude-standard"], repo)
    res = {}
    for rel in out.splitlines():
        p = repo / rel
        if rel.endswith(".php") and p.is_file() and not rel.startswith("vendor/"):
            res[rel] = p.read_text(errors="replace")
    return res


def strip_comments(text):
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    return re.sub(r"(?m)^\s*(//|#(?!\[)).*$", "", text)


def interpolated_sql(code):
    """True if SQL text is built by interpolating or concatenating PHP variables."""
    # Scan single- and double-quoted literals left to right so quotes inside the other kind are skipped.
    for m in re.finditer(r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"", code, flags=re.S):
        s = m.group(0)
        if s.startswith('"') and SQL_WORD.search(s) and re.search(r"\$\w|\{\$", s):
            return True
    for m in re.finditer(r"<<<\s*\"?(\w+)\"?\n(.*?)\n\s*\1\b", code, flags=re.S):
        if SQL_WORD.search(m.group(2)) and re.search(r"\$\w|\{\$", m.group(2)):
            return True
    concat = re.compile(r"""(['"])[^'"\n]*\b(SELECT|INSERT|UPDATE|DELETE|WHERE|VALUES|SET)\b[^'"\n]*\1"""
                        r"""\s*\.\s*\$""", re.I)
    return bool(concat.search(code))


def arch_checks(repo, files):
    src = {k: v for k, v in files.items() if k.startswith("src/")}
    sizes = {k: len([l for l in v.splitlines() if l.strip()]) for k, v in src.items()}
    total = sum(sizes.values())
    split = len(src) >= 5 and total > 0 and max(sizes.values()) <= 0.5 * total
    strict = bool(src) and all(re.search(r"declare\s*\(\s*strict_types\s*=\s*1\s*\)", t) for t in src.values())
    code = {k: strip_comments(v) for k, v in src.items()}
    prepared = bool(code) and any("->prepare(" in c for c in code.values()) and not any(
        interpolated_sql(c) for c in code.values())
    front = files.get("public/index.php", "")
    front_lines = len([l for l in front.splitlines() if l.strip()])
    thin = bool(front) and front_lines <= 30 and not SQL_WORD.search(strip_comments(front)) \
        and "new PDO" not in front
    return {"split_into_classes": split, "strict_types_everywhere": strict,
            "prepared_statements_only": prepared, "thin_front_controller": thin}


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
    php = shutil.which("php", path=TOOL_PATH) or "php"
    env = {"PATH": TOOL_PATH}
    # Never reuse a database the agent left behind.
    shutil.rmtree(repo / "var", ignore_errors=True)

    sources = php_files(repo)
    lint_errors = []
    for rel in sources:
        rc, out = ek.sh([php, "-l", rel], repo, timeout=30, env=env)
        if rc != 0:
            lint_errors.append(out.strip()[-300:])
    build_passed = (repo / "public" / "index.php").is_file() and bool(sources) and not lint_errors

    # Agent tests: tests/run.php must exist and exit 0.
    test_files = [f for f in sources if f.startswith("tests/")]
    agent_tests_added = (repo / "tests" / "run.php").is_file() and len(test_files) >= 2
    agent_tests_pass = False
    test_out = ""
    if agent_tests_added and build_passed:
        rc, test_out = ek.sh([php, "-d", "error_reporting=E_ALL", "tests/run.php"], repo,
                             timeout=300, env=env)
        agent_tests_pass = rc == 0

    hidden = {}
    hidden_out = ""
    server_log = repo.parent / "server.log"
    if build_passed:
        _, hidden_out = ek.sh([sys.executable, "-I", str(HIDDEN_SCRIPT), php, str(repo), str(server_log)],
                              repo, timeout=600, env=env)
        for m in re.finditer(r"^(PASS|FAIL) (\w+)", hidden_out, flags=re.M):
            hidden[m.group(2)] = m.group(1) == "PASS"
    hidden = {n: hidden.get(n, False) for n in hidden_names()}
    log_text = server_log.read_text(errors="replace") if server_log.is_file() else ""
    php_issues = sorted({m.group(0)[:200] for m in PHP_ISSUE.finditer(log_text)})
    lint_passed = build_passed and not php_issues

    arch = arch_checks(repo, sources)

    scored = ek.score_coding(
        build_passed=build_passed, hidden_results=hidden, requirement_groups=GROUPS,
        original_tests_passed=True, agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass, arch_checks=arch, unrelated=unrelated,
        fmt_ok=lint_passed, diff_added=diff_added, diff_limit=10 ** 9, rubric=TASK["rubric"])
    checks = {"build_passed": build_passed, "tests_passed": True, "lint_passed": lint_passed,
              "format_passed": None, "typecheck_passed": None}
    details = {"changed_files": files, "unrelated": unrelated, "diff": [diff_added, diff_removed],
               "agent_tests_added": agent_tests_added, "agent_tests_pass": agent_tests_pass,
               "arch_checks": arch, "hidden": hidden, "php_runtime_issues": php_issues[:20],
               "lint_errors": lint_errors[:10],
               "hidden_failures": [l for l in hidden_out.splitlines() if l.startswith("FAIL")][:30],
               "agent_test_output": test_out[-1500:] if agent_tests_added and not agent_tests_pass else ""}
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
