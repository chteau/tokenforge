#!/usr/bin/env python3
"""Evaluator for c-cli: the csvq CSV query tool built from scratch in C11 with Make."""
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
HIDDEN_SCRIPT = HERE / "hidden" / "test_csvq.py"
GROUPS = {
    "rfc4180_parsing": ["parse_"],
    "where_filters": ["where_"],
    "select": ["select_"],
    "sort": ["sort_"],
    "aggregation": ["agg_"],
    "output_quoting": ["out_"],
    "errors": ["err_"],
    "command_line": ["cli_"],
}
TOOL_PATH = os.pathsep.join([
    "/home/linuxbrew/.linuxbrew/bin", str(Path.home() / ".cargo/bin"), str(Path.home() / ".local/bin"),
    "/usr/local/bin", "/usr/bin", "/bin"])
MAKE = shutil.which("make", path=TOOL_PATH) or "make"
GCC = shutil.which("gcc", path=TOOL_PATH) or "gcc"
SAN_FLAGS = "-fsanitize=address,undefined -fno-omit-frame-pointer -g"
SAN_ENV = {"ASAN_OPTIONS": "detect_leaks=0:abort_on_error=0",
           "UBSAN_OPTIONS": "halt_on_error=1:print_stacktrace=0", "CSVQ_SANITIZE": "1"}
UNSAFE = re.compile(r"\b(?:gets|strcpy|strcat|sprintf|vsprintf)\s*\(")


def strip_comments(text):
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r"//[^\n]*", "", text)
    return re.sub(r'"(?:\\.|[^"\\\n])*"', '""', text)


def sources(repo):
    """{relative path: text} of non-test C sources and headers."""
    _, out = ek.sh(["git", "ls-files", "-co", "--exclude-standard"], repo)
    res = {}
    for rel in out.splitlines():
        p = Path(rel)
        if p.suffix not in (".c", ".h") or any("test" in x.lower() for x in p.parts):
            continue
        f = repo / rel
        if f.is_file():
            res[rel] = f.read_text(errors="replace")
    return res


def clean_objects(repo):
    for p in list(repo.rglob("*.o")) + [repo / "csvq"]:
        if ".git" not in p.parts and p.is_file():
            p.unlink()


def build(repo, env, extra=None):
    clean_objects(repo)
    cmd = [MAKE, f"CC={GCC}"] + ([f"EXTRA_CFLAGS={extra}"] if extra else [])
    rc, out = ek.sh(cmd, repo, timeout=300, env=env)
    return rc == 0 and (repo / "csvq").is_file(), out


def run_hidden(repo, env=None):
    _, out = ek.sh([sys.executable, "-I", str(HIDDEN_SCRIPT), str(repo / "csvq")], repo,
                   timeout=300, env=env)
    res = {m.group(2): m.group(1) == "PASS" for m in re.finditer(r"^(PASS|FAIL) (\w+)", out, re.M)}
    return res, out


def hidden_names():
    return re.findall(r"@test\s*\ndef\s+(\w+)", HIDDEN_SCRIPT.read_text())


def arch_checks(repo, srcs, sanitizer_clean):
    impls = {k: v for k, v in srcs.items() if k.endswith(".c")}
    hdrs = {k: v for k, v in srcs.items() if k.endswith(".h")}
    lines = {k: len([l for l in v.splitlines() if l.strip()]) for k, v in srcs.items()}
    total = sum(lines.values()) or 1
    split = (len(impls) >= 3 and len(hdrs) >= 2
             and max((lines[k] for k in impls), default=total) <= 0.6 * total)
    guarded = bool(hdrs) and all(
        re.search(r"#\s*pragma\s+once", t) or re.search(r"#\s*ifndef\s+(\w+)\s*\n\s*#\s*define\s+\1\b", t)
        for t in hdrs.values())
    safe = bool(impls) and not any(UNSAFE.search(strip_comments(t)) for t in srcs.values())
    return {"split_into_modules": split, "headers_guarded": guarded,
            "no_unsafe_string_functions": safe, "sanitizer_clean": sanitizer_clean}


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
    env = {"PATH": TOOL_PATH + os.pathsep + os.environ.get("PATH", ""), "LC_ALL": "C"}

    has_makefile = (repo / "Makefile").is_file() or (repo / "makefile").is_file()
    build_passed, build_out = build(repo, env) if has_makefile else (False, "no Makefile")
    mk_text = "\n".join(p.read_text(errors="replace") for p in (repo / "Makefile", repo / "makefile")
                        if p.is_file())
    warnings = re.findall(r"^.*\bwarning:.*$", build_out, flags=re.M)
    flags_set = all(f in mk_text for f in ("-Wall", "-Wextra")) and re.search(r"-std=(c|gnu)11\b", mk_text)
    lint_passed = bool(build_passed and not warnings and flags_set)

    # Agent tests: sources under tests/ (or *test*.c) run by `make test`.
    agent_tests_added = any(re.search(r"(^|/)tests?/|test", f) and f.endswith((".c", ".sh", ".py"))
                            for f in files)
    agent_tests_pass = False
    test_out = ""
    if build_passed and agent_tests_added:
        rc, test_out = ek.sh([MAKE, f"CC={GCC}", "test"], repo, timeout=300, env=env)
        agent_tests_pass = rc == 0

    names = hidden_names()
    hidden, hidden_out = ({}, "")
    if build_passed:
        build(repo, env)  # `make test` may have rebuilt objects with other flags
        hidden, hidden_out = run_hidden(repo)
    hidden = {n: hidden.get(n, False) for n in names}

    # Instrumented build: every hidden test that passes normally must also pass under ASan/UBSan.
    sanitizer_clean = False
    san_failures = []
    if build_passed and any(hidden.values()):
        ok, _ = build(repo, env, SAN_FLAGS)
        instrumented = ok and b"__asan_init" in (repo / "csvq").read_bytes()
        if instrumented:
            san, san_out = run_hidden(repo, {**env, **SAN_ENV})
            san_failures = [n for n, v in hidden.items() if v and not san.get(n, False)]
            sanitizer_clean = not san_failures
            san_failures = [l for l in san_out.splitlines()
                            if l.startswith("FAIL") and l.split()[1].rstrip(":") in san_failures][:10]
        else:
            san_failures = ["instrumented build failed or EXTRA_CFLAGS ignored"]

    srcs = sources(repo)
    arch = arch_checks(repo, srcs, sanitizer_clean)

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
               "makefile_sets_flags": bool(flags_set), "sanitizer_failures": san_failures,
               "hidden_failures": [l for l in hidden_out.splitlines() if l.startswith("FAIL")][:30],
               "test_output": test_out[-1500:] if not agent_tests_pass else "",
               "build_output": build_out[-2000:] if not build_passed else ""}
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
