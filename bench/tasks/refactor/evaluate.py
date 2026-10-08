#!/usr/bin/env python3
"""Evaluator for refactor: consolidate duplicated entry validation."""
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
HIDDEN_TARGET = "hidden_validation"
GROUPS = {
    "add_is_canonical": ["add_rules_"],
    "edit_consistent": ["edit_rules_"],
    "rename_consistent": ["rename_rules_"],
    "import_consistent": ["import_rules_"],
}
# Each rule's error message should be produced by exactly one place in the (non-test) source.
SINGLE_SOURCE = {
    "category_rules_single_source": ["may only contain letters, digits, '-' and '_'",
                                     "category is longer than", "category must not be empty"],
    "amount_rules_single_source": ["amount must be greater than zero", "amount exceeds the maximum"],
    "date_rules_single_source": ["is outside the supported range"],
    "text_and_tag_rules_single_source": ["payee must not contain control characters", "payee is longer than",
                                         "note is longer than", "tag must not be empty"],
}


def added_lines(repo, base, pathspec):
    """Added lines (without the leading '+') in the diff against base, per file."""
    ek.sh(["git", "add", "-A", "--intent-to-add", "."], repo)
    _, out = ek.sh(["git", "diff", "-U0", base, "--", *pathspec], repo)
    per_file, cur = {}, None
    for l in out.splitlines():
        if l.startswith("+++ "):
            cur = l[6:] if l.startswith("+++ b/") else None
        elif l.startswith("+") and cur:
            per_file.setdefault(cur, []).append(l[1:])
    return per_file


def strip_tests(text):
    i = text.find("#[cfg(test)]")
    return text if i < 0 else text[:i]


def arch_checks(repo, base, files, src_added):
    sources = {str(p.relative_to(repo)): strip_tests(p.read_text(errors="replace"))
               for p in (repo / "src").rglob("*.rs")}
    checks = {}
    for name, msgs in SINGLE_SOURCE.items():
        checks[name] = all(sum(t.count(m) for t in sources.values()) == 1 for m in msgs)
    # The character-class rules for categories and tags live in a single module.
    char_files = [f for f, t in sources.items()
                  if re.search(r"is_ascii_lowercase\(\)|is_ascii_alphanumeric\(\)", t)]
    checks["char_rules_in_one_module"] = len(char_files) == 1
    return checks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    repo = ek.scratch_copy(a.workspace)
    env = {"CARGO_TARGET_DIR": str(repo / "target"), "CARGO_NET_OFFLINE": "true",
           "CARGO_TERM_COLOR": "never", "RUST_BACKTRACE": "0"}
    files = ek.changed_files(repo, a.base)
    diff_added, diff_removed = ek.diff_size(repo, a.base)
    unrelated = ek.unrelated_changes(files, TASK["allowed_change_globs"])
    src_added = added_lines(repo, a.base, ["src"])

    agent_tests_added = any(f.startswith("tests/") for f in files) or any(
        "#[test]" in l for ls in src_added.values() for l in ls)

    _, ls = ek.sh(["git", "ls-tree", "--name-only", f"{a.base}:tests"], repo)
    orig_targets = sorted(n[:-3] for n in ls.split() if n.endswith(".rs"))

    rc, build_out = ek.sh(["cargo", "build", "--quiet"], repo, timeout=300, env=env)
    build_passed = rc == 0
    fmt_rc, _ = ek.sh(["cargo", "fmt", "--check"], repo, timeout=120, env=env)
    format_passed = fmt_rc == 0
    lint_passed = agent_tests_pass = False
    if build_passed:
        lint_rc, _ = ek.sh(["cargo", "clippy", "--quiet", "--all-targets", "--", "-D", "warnings"],
                           repo, timeout=300, env=env)
        lint_passed = lint_rc == 0
        if agent_tests_added:
            trc, _ = ek.sh(["cargo", "test", "--quiet", "--no-fail-fast"], repo, timeout=400, env=env)
            agent_tests_pass = trc == 0

    arch = arch_checks(repo, a.base, files, src_added)

    # Restore the original integration tests (the agent may have edited them), add hidden tests.
    ek.sh(["git", "checkout", a.base, "--", "tests"], repo)
    ek.overlay(HERE / "hidden", repo)

    original, hidden, orig_ok = {}, {}, False
    if build_passed:
        runs = [("unit", ["cargo", "test", "--lib", "--bins", "--no-fail-fast"])] + [
            (t, ["cargo", "test", "--test", t, "--no-fail-fast"]) for t in orig_targets]
        orig_ok = True
        for label, cmd in runs:
            rc, out = ek.sh(cmd, repo, timeout=300, env=env)
            res = ek.cargo_tests(out)
            original.update({f"{label}::{k}": v for k, v in res.items()})
            if rc != 0 or (not res and label != "unit"):
                orig_ok = False
        rc, out = ek.sh(["cargo", "test", "--test", HIDDEN_TARGET, "--no-fail-fast"], repo,
                        timeout=300, env=env)
        hidden = ek.cargo_tests(out)
    if not hidden:
        src = (HERE / "hidden" / "tests" / f"{HIDDEN_TARGET}.rs").read_text()
        hidden = {n: False for n in re.findall(r"#\[test\]\s*fn\s+(\w+)", src)}

    scored = ek.score_coding(
        build_passed=build_passed, hidden_results=hidden, requirement_groups=GROUPS,
        original_tests_passed=orig_ok, agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass, arch_checks=arch, unrelated=unrelated,
        fmt_ok=format_passed and lint_passed, diff_added=diff_added,
        diff_limit=3 * TASK["reference_diff_lines"], rubric=TASK["rubric"])
    checks = {"build_passed": build_passed, "tests_passed": orig_ok, "lint_passed": lint_passed,
              "format_passed": format_passed, "typecheck_passed": None}
    details = {"changed_files": files, "unrelated": unrelated, "diff": [diff_added, diff_removed],
               "agent_tests_added": agent_tests_added, "agent_tests_pass": agent_tests_pass,
               "arch_checks": arch, "hidden": hidden,
               "original_failed": sorted(k for k, v in original.items() if not v),
               "build_output": build_out[-2000:] if not build_passed else ""}
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
