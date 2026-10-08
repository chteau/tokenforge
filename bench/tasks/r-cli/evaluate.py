#!/usr/bin/env python3
"""Evaluator for r-cli: the surveystat survey summariser built from scratch in R 4.6."""
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
HIDDEN_SCRIPT = HERE / "hidden" / "test_surveystat.py"
GROUPS = {
    "schema": ["schema_"],
    "responses": ["data_"],
    "summary": ["summary_"],
    "percentages": ["percent_"],
    "filters": ["filter_"],
    "crosstab": ["crosstab_"],
    "json_output": ["json_"],
    "command_line": ["cli_"],
}
TOOL_PATH = os.pathsep.join(["/home/linuxbrew/.linuxbrew/bin", os.path.expanduser("~/.local/bin"),
                             "/usr/local/bin", "/usr/bin", "/bin", os.environ.get("PATH", "")])
BASE_PACKAGES = {"base", "stats", "utils", "methods", "tools", "grDevices", "graphics"}
SUMMARY = re.compile(r"^tests: (\d+), failures: (\d+)\s*$", re.M)
LINT_SCRIPT = r"""
env <- new.env()
for (f in commandArgs(trailingOnly = TRUE)) sys.source(f, envir = env, keep.source = TRUE)
codetools::checkUsageEnv(env, all = FALSE)
cat("LINT-END\n")
"""


def tracked(repo):
    _, out = ek.sh(["git", "ls-files", "-co", "--exclude-standard"], repo)
    return [l for l in out.splitlines() if (repo / l).is_file()]


def strip_code(text):
    """Remove string literals and comments (approximately) from R code."""
    text = re.sub(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'', '""', text, flags=re.S)
    return re.sub(r"#[^\n]*", "", text)


def arch_checks(lib, bin_text):
    sizes = {k: len([l for l in v.splitlines() if l.strip()]) for k, v in lib.items()}
    total = sum(sizes.values())
    split = len(lib) >= 4 and total > 0 and max(sizes.values()) <= 0.5 * total
    thin = bool(bin_text) and len([l for l in bin_text.splitlines() if l.strip()]) <= 20
    code = {k: strip_code(v) for k, v in lib.items()}
    if bin_text:
        code["bin/surveystat"] = strip_code(bin_text)
    joined = "\n".join(code.values())
    pkgs = set(re.findall(r"\b(?:library|require|requireNamespace|loadNamespace)\s*\(\s*[\"']?([\w.]+)", joined))
    pkgs |= set(re.findall(r"\b([A-Za-z][\w.]*):::?(?=[A-Za-z.])", joined))
    base_only = bool(lib) and pkgs <= BASE_PACKAGES and "install.packages" not in joined
    exiters = [k for k, v in code.items() if re.search(r"(?<![\w.])(?:quit|q)\s*\(", v)]
    return {"split_into_files": split, "thin_executable": thin, "base_r_only": base_only,
            "single_exit_point": len(exiters) == 1}


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
    rscript = shutil.which("Rscript", path=TOOL_PATH) or "Rscript"

    # Isolated R environment: empty user library, throwaway HOME, no user profile/environ.
    rhome = repo.parent / "rhome"
    (rhome / "lib").mkdir(parents=True, exist_ok=True)
    (rhome / "empty").write_text("")
    env = {"PATH": TOOL_PATH, "HOME": str(rhome), "R_LIBS_USER": str(rhome / "lib"), "R_LIBS": "",
           "R_PROFILE_USER": str(rhome / "empty"), "R_ENVIRON_USER": str(rhome / "empty"),
           "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}

    all_files = tracked(repo)
    lib = {f: (repo / f).read_text(errors="replace") for f in all_files
           if re.fullmatch(r"R/[^/]+\.[Rr]", f)}
    binf = repo / "bin" / "surveystat"
    bin_text = binf.read_text(errors="replace") if binf.is_file() else ""

    # Build: every file parses, and the tool starts.
    build_out = ""
    sources = sorted(lib) + (["bin/surveystat"] if bin_text else [])
    syntax_ok = False
    if lib:
        rc, build_out = ek.sh([rscript, "-e", "for (f in commandArgs(TRUE)) invisible(parse(f))",
                               *sources], repo, timeout=60, env=env)
        syntax_ok = rc == 0
    build_passed = False
    if syntax_ok and bin_text:
        rc, out = ek.sh([rscript, "bin/surveystat", "--help"], repo, timeout=60, env=env)
        build_passed = rc == 0 and "Usage: surveystat" in out
        build_out += out

    # Lint: codetools usage check over all R/ functions (undefined names, unused locals, ...).
    lint_out = ""
    lint_passed = False
    if build_passed:
        rc, lint_out = ek.sh([rscript, "-e", LINT_SCRIPT, *sorted(lib)], repo, timeout=120, env=env)
        lint_passed = rc == 0 and lint_out.strip() == "LINT-END"

    # Agent tests: the self-written runner.
    agent_tests_added = (repo / "tests" / "run.R").is_file()
    agent_tests_pass = False
    test_out = ""
    if agent_tests_added and build_passed:
        rc, test_out = ek.sh([rscript, "tests/run.R"], repo, timeout=300, env=env)
        m = SUMMARY.findall(test_out)
        agent_tests_pass = rc == 0 and bool(m) and int(m[-1][0]) > 0 and int(m[-1][1]) == 0

    hidden = {}
    hidden_out = ""
    if build_passed:
        _, hidden_out = ek.sh([sys.executable, "-I", str(HIDDEN_SCRIPT), rscript, str(repo)], repo.parent,
                              timeout=900, env=env)
        for m in re.finditer(r"^(PASS|FAIL) (\w+)", hidden_out, flags=re.M):
            hidden[m.group(2)] = m.group(1) == "PASS"
    hidden = {n: hidden.get(n, False) for n in hidden_names()}

    arch = arch_checks(lib, bin_text)

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
               "lint_output": lint_out[-1500:] if build_passed and not lint_passed else "",
               "hidden_failures": [l for l in hidden_out.splitlines() if l.startswith("FAIL")][:30],
               "agent_test_output": test_out[-1500:] if agent_tests_added and not agent_tests_pass else "",
               "build_output": build_out[-2000:] if not build_passed else ""}
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
