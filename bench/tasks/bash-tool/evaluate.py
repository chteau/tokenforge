#!/usr/bin/env python3
"""Evaluator for bash-tool: the `rotate` backup rotation tool built from scratch in Bash."""
import argparse
import json
import os
import re
import shutil
import stat
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "runner"))
import evalkit as ek  # noqa: E402

TASK = json.loads((HERE / "task.json").read_text())
HIDDEN_SCRIPT = HERE / "hidden" / "test_rotate.py"
GROUPS = {
    "snapshot": ["snap_"],
    "list": ["list_"],
    "prune": ["prune_"],
    "restore": ["restore_"],
    "locking": ["lock_"],
    "command_line": ["cli_"],
}
TOOL_DIRS = ["/home/linuxbrew/.linuxbrew/bin", os.path.expanduser("~/.cargo/bin"),
             os.path.expanduser("~/.local/bin"), "/usr/local/bin", "/usr/bin", "/bin"]
TOOL_PATH = os.pathsep.join(TOOL_DIRS)
ENV = {"PATH": TOOL_PATH, "LC_ALL": "C.UTF-8"}
# Source files of other languages, and invocations of other interpreters in shell code.
OTHER_LANG_EXT = {".py", ".pl", ".rb", ".js", ".mjs", ".ts", ".php", ".lua", ".awk", ".go",
                  ".rs", ".c", ".cpp", ".java"}
OTHER_LANG_CMD = re.compile(r"(?:^|[\s;|&(`$])(?:awk|gawk|mawk|nawk|perl|python[0-9.]*|ruby|node|"
                            r"php|lua|bc|flock|jq)(?=[\s;|&)`]|$)", re.M)


def strip_comments(text):
    """Drop shell comment lines and trailing comments (good enough for keyword checks)."""
    out = []
    for line in text.splitlines():
        s = line.lstrip()
        if s.startswith("#"):
            continue
        out.append(re.sub(r"\s#\s.*$", "", line))
    return "\n".join(out)


def is_shell(path: Path) -> bool:
    if path.suffix in (".sh", ".bash"):
        return True
    try:
        first = path.open("rb").readline(200)
    except OSError:
        return False
    return first.startswith(b"#!") and (b"bash" in first or b"/sh" in first)


def tracked(repo):
    _, out = ek.sh(["git", "ls-files", "-co", "--exclude-standard"], repo)
    return [l for l in out.splitlines() if l.strip() and (repo / l).is_file()]


def shell_files(repo):
    return [r for r in tracked(repo) if is_shell(repo / r)]


def nonblank(text):
    return len([l for l in text.splitlines() if l.strip() and not l.lstrip().startswith("#")])


def arch_checks(repo):
    files = tracked(repo)
    shells = shell_files(repo)
    main = repo / "rotate"
    main_text = main.read_text(errors="replace") if main.is_file() else ""
    impl = [r for r in shells if not r.startswith(("tests/", "test/"))]
    libs = [r for r in impl if r.startswith("lib/")]
    sizes = {r: nonblank((repo / r).read_text(errors="replace")) for r in impl}
    total = sum(sizes.values()) or 1
    texts = {r: strip_comments((repo / r).read_text(errors="replace")) for r in shells}
    other_lang = [r for r in files if Path(r).suffix in OTHER_LANG_EXT] + \
        [r for r, t in texts.items() if OTHER_LANG_CMD.search(t)]
    all_impl = "\n".join(texts.get(r, "") for r in impl)
    n_funcs = len(re.findall(r"^\s*(?:function\s+)?[A-Za-z_][\w-]*\s*\(\)\s*\{?", all_impl, re.M))
    return {
        # rotate sources several helper libraries.
        "split_into_libraries": len(libs) >= 2 and bool(re.search(r"^\s*(source|\.)\s", main_text, re.M)),
        # No single file holds most of the code.
        "no_god_file": bool(sizes) and max(sizes.values()) <= 0.6 * total,
        # Strict mode in the entry point.
        "strict_mode": bool(re.search(r"^\s*set\s+-[a-zA-Z]*e[a-zA-Z]*u[a-zA-Z]*o\s+pipefail|"
                                      r"^\s*set\s+-[a-zA-Z]*u[a-zA-Z]*e[a-zA-Z]*o\s+pipefail",
                                      main_text, re.M)),
        # Bash and the allowed tools only.
        "no_other_languages": bool(shells) and not other_lang,
        # Organised into functions with local variables.
        "functions_with_locals": n_funcs >= 8 and len(re.findall(r"\blocal\b", all_impl)) >= 5,
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

    bash = shutil.which("bash", path=TOOL_PATH) or "bash"
    entry = repo / "rotate"
    shells = shell_files(repo)
    build_out = ""
    build_passed = False
    if not entry.is_file():
        build_out = "no rotate script at the repository root"
    elif not entry.stat().st_mode & stat.S_IXUSR:
        build_out = "rotate is not executable"
    else:
        syntax_ok = True
        for r in shells:
            rc, out = ek.sh([bash, "-n", r], repo, timeout=30, env=ENV)
            if rc != 0:
                syntax_ok = False
                build_out += out
        rc, out = ek.sh([str(entry), "--help"], repo.parent, timeout=30, env=ENV)
        build_out += out
        build_passed = syntax_ok and rc == 0 and out.startswith("usage: rotate")

    # shellcheck, when installed.
    lint_passed = None
    lint_out = ""
    shellcheck = shutil.which("shellcheck", path=TOOL_PATH)
    if shellcheck and shells:
        rc, lint_out = ek.sh([shellcheck, "-x", "-S", "warning", *shells], repo, timeout=120, env=ENV)
        lint_passed = rc == 0

    # Agent tests: bash tests/run.sh.
    agent_tests_added = (repo / "tests" / "run.sh").is_file()
    agent_tests_pass = False
    test_out = ""
    if agent_tests_added and build_passed:
        rc, test_out = ek.sh([bash, "tests/run.sh"], repo, timeout=300, env=ENV)
        agent_tests_pass = rc == 0

    hidden = {}
    hidden_out = ""
    if build_passed:
        _, hidden_out = ek.sh([sys.executable, "-I", str(HIDDEN_SCRIPT), str(entry)],
                              repo.parent, timeout=600, env=ENV)
        for m in re.finditer(r"^(PASS|FAIL) (\w+)", hidden_out, flags=re.M):
            hidden[m.group(2)] = m.group(1) == "PASS"
    hidden = {n: hidden.get(n, False) for n in hidden_names()}

    arch = arch_checks(repo)

    scored = ek.score_coding(
        build_passed=build_passed, hidden_results=hidden, requirement_groups=GROUPS,
        original_tests_passed=True, agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass, arch_checks=arch, unrelated=unrelated,
        fmt_ok=lint_passed if lint_passed is not None else True, diff_added=diff_added,
        diff_limit=10 ** 9, rubric=TASK["rubric"])
    checks = {"build_passed": build_passed, "tests_passed": True, "lint_passed": lint_passed,
              "format_passed": None, "typecheck_passed": None}
    details = {"changed_files": files, "unrelated": unrelated, "diff": [diff_added, diff_removed],
               "agent_tests_added": agent_tests_added, "agent_tests_pass": agent_tests_pass,
               "agent_test_output": test_out[-1500:] if not agent_tests_pass else "",
               "arch_checks": arch, "hidden": hidden, "shell_files": shells,
               "shellcheck": "not installed" if shellcheck is None else lint_out[-1500:],
               "hidden_failures": [l for l in hidden_out.splitlines() if l.startswith("FAIL")][:30],
               "build_output": build_out[-2000:] if not build_passed else ""}
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
