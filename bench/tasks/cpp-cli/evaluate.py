#!/usr/bin/env python3
"""Evaluator for cpp-cli: the kvdb key-value store built from scratch with CMake."""
import argparse
import json
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "runner"))
import evalkit as ek  # noqa: E402

TASK = json.loads((HERE / "task.json").read_text())
HIDDEN_SCRIPT = HERE / "hidden" / "test_kvdb.py"
GROUPS = {
    "set_get": ["basic_"],
    "delete": ["del_"],
    "scan": ["scan_"],
    "persistence": ["persist_"],
    "stats": ["stats_"],
    "compaction": ["compact_"],
    "crash_recovery": ["recovery_"],
    "command_line": ["cli_"],
}
IMPL_EXT = {".cpp", ".cc", ".cxx"}
HDR_EXT = {".h", ".hpp", ".hh", ".hxx"}
# Directory names that do not by themselves define a component.
GENERIC_DIRS = {"", ".", "src", "source", "sources", "lib", "include", "app", "kvdb"}
WRITE_PATTERNS = re.compile(
    r"\bofstream\b|\bstd::fstream\b|\bfopen\s*\(|\bfwrite\s*\(|\bfputs\s*\("
    r"|\bopen\s*\([^;]*\bO_(?:WRONLY|RDWR|CREAT|APPEND|TRUNC)\b"
    r"|(?<![\w.>])::write\s*\(|\bpwrite\s*\(|\bftruncate\s*\(|\bresize_file\s*\(|\brename\s*\(")


def strip_comments(text):
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r"//[^\n]*", "", text)
    text = re.sub(r'"(?:\\.|[^"\\\n])*"', '""', text)  # string literals
    return "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))


def sources(repo):
    """{relative path: text} of non-test C++ sources (outside build directories)."""
    _, out = ek.sh(["git", "ls-files", "-co", "--exclude-standard"], repo)
    res = {}
    for rel in out.splitlines():
        p = Path(rel)
        if p.suffix not in IMPL_EXT | HDR_EXT:
            continue
        parts = [x.lower() for x in p.parts]
        if any(x.startswith("build") or x.startswith("cmake-build") for x in parts[:-1]):
            continue
        if any("test" in x for x in parts):
            continue
        f = repo / rel
        if f.is_file():
            res[rel] = f.read_text(errors="replace")
    return res


def component_key(rel):
    p = Path(rel)
    parent = p.parent.name.lower()
    return f"dir:{p.parent}" if parent not in GENERIC_DIRS else f"stem:{p.stem.lower()}"


def arch_checks(repo):
    srcs = sources(repo)
    impls = {k: v for k, v in srcs.items() if Path(k).suffix in IMPL_EXT}
    hdrs = {k: v for k, v in srcs.items() if Path(k).suffix in HDR_EXT}
    if not impls:
        return {"split_into_components": False, "no_using_namespace_std_in_headers": False,
                "single_storage_component": False, "raii_file_handles": False}
    lines = {k: len([l for l in v.splitlines() if l.strip()]) for k, v in srcs.items()}
    total = sum(lines.values()) or 1
    biggest = max(lines[k] for k in impls)
    split = len(impls) >= 3 and len(hdrs) >= 2 and biggest <= 0.6 * total

    no_using = bool(hdrs) and not any(
        re.search(r"\busing\s+namespace\s+std\s*;", strip_comments(t)) for t in hdrs.values())

    code = {k: strip_comments(v) for k, v in srcs.items()}
    writers = {component_key(k) for k, v in code.items() if WRITE_PATTERNS.search(v)}
    single_storage = len(writers) == 1

    allc = "\n".join(code.values())
    n = lambda pat: len(re.findall(pat, allc))
    fopen, fclose = n(r"\bfopen\s*\("), n(r"\bfclose\b")
    posix_open = n(r"(?<![\w.>])::open\s*\(|(?<![\w.:>~])\bopen\s*\([^;)]*\bO_[A-Z]+")
    posix_close = n(r"(?<![\w.>])::close\s*\(|(?<![\w.:>~])\bclose\s*\(\s*\w+\s*\)")
    raw_new = n(r"\bnew\s+(?:std::)?(?:i|o)?fstream\b|\bnew\s+FILE\b")
    raii = raw_new == 0 and fclose >= fopen and (posix_open == 0 or posix_close > 0)
    return {"split_into_components": split, "no_using_namespace_std_in_headers": no_using,
            "single_storage_component": single_storage, "raii_file_handles": raii}


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

    # Fresh out-of-tree build; force -Wall -Wextra so warnings are visible either way.
    shutil.rmtree(repo / "build", ignore_errors=True)
    (repo / "CMakeCache.txt").unlink(missing_ok=True)
    env = {"CXXFLAGS": "-Wall -Wextra", "CLICOLOR_FORCE": "0", "CMAKE_COLOR_DIAGNOSTICS": "OFF"}
    build_out = ""
    build_passed = False
    if (repo / "CMakeLists.txt").is_file():
        rc, out = ek.sh(["cmake", "-S", ".", "-B", "build", "-G", "Ninja"], repo, timeout=120, env=env)
        build_out = out
        if rc == 0:
            rc, out = ek.sh(["cmake", "--build", "build"], repo, timeout=300, env=env)
            build_out += out
        build_passed = rc == 0 and (repo / "build" / "kvdb").is_file()
    else:
        build_out = "no CMakeLists.txt"
    binary = repo / "build" / "kvdb"

    cmake_text = "\n".join(p.read_text(errors="replace") for p in repo.rglob("*")
                           if p.is_file() and "build" not in p.relative_to(repo).parts[:1]
                           and (p.name == "CMakeLists.txt" or p.suffix == ".cmake"))
    warnings = re.findall(r"^.*\bwarning:.*$", build_out, flags=re.M)
    flags_set = "-Wall" in cmake_text and "-Wextra" in cmake_text
    lint_passed = build_passed and not warnings and flags_set

    # Agent tests registered with CTest.
    agent_tests_added = agent_tests_pass = False
    ctest_count = 0
    if build_passed:
        _, out = ek.sh(["ctest", "--test-dir", "build", "-N"], repo, timeout=60)
        m = re.search(r"Total Tests:\s*(\d+)", out)
        ctest_count = int(m.group(1)) if m else 0
        agent_tests_added = ctest_count > 0
        if agent_tests_added:
            rc, _ = ek.sh(["ctest", "--test-dir", "build", "--timeout", "60", "--output-on-failure"],
                          repo, timeout=150)
            agent_tests_pass = rc == 0

    hidden = {}
    hidden_out = ""
    if build_passed:
        _, hidden_out = ek.sh([sys.executable, "-I", str(HIDDEN_SCRIPT), str(binary)],
                              repo, timeout=300)
        for m in re.finditer(r"^(PASS|FAIL) (\w+)", hidden_out, flags=re.M):
            hidden[m.group(2)] = m.group(1) == "PASS"
    names = hidden_names()
    hidden = {n: hidden.get(n, False) for n in names}

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
               "ctest_count": ctest_count, "arch_checks": arch, "hidden": hidden,
               "warnings": warnings[:20], "cmake_sets_wall_wextra": flags_set,
               "hidden_failures": [l for l in hidden_out.splitlines() if l.startswith("FAIL")][:30],
               "build_output": build_out[-2000:] if not build_passed else ""}
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
