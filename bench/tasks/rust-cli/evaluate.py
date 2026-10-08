#!/usr/bin/env python3
"""Evaluator for rust-cli: the `budget` command of the tally ledger."""
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
HIDDEN_TARGET = "hidden_budget"
GROUPS = {
    "set": ["budget_set_"],
    "list": ["budget_list_"],
    "remove": ["budget_remove_"],
    "status": ["budget_status_"],
    "config": ["budget_config_"],
    "rename": ["budget_rename_"],
    "errors": ["budget_errors_"],
    "existing_behaviour": ["existing_commands_"],
}


def added_lines(repo, base, pathspec):
    """Added lines (without the leading '+') in the diff against base."""
    ek.sh(["git", "add", "-A", "--intent-to-add", "."], repo)
    _, out = ek.sh(["git", "diff", "-U0", base, "--", *pathspec], repo)
    return [l[1:] for l in out.splitlines() if l.startswith("+") and not l.startswith("+++")]


def strip_tests(text):
    i = text.find("#[cfg(test)]")
    return text if i < 0 else text[:i]


def non_test_sources(repo, rev=None):
    """{path: source without the trailing #[cfg(test)] module} for src/**/*.rs, at rev or in the tree."""
    if rev is None:
        return {str(p.relative_to(repo)): strip_tests(p.read_text(errors="replace"))
                for p in (repo / "src").rglob("*.rs")}
    _, names = ek.sh(["git", "ls-tree", "-r", "--name-only", rev, "src"], repo)
    out = {}
    for n in names.split():
        if n.endswith(".rs"):
            _, text = ek.sh(["git", "show", f"{rev}:{n}"], repo)
            out[n] = strip_tests(text)
    return out


def arch_checks(repo, base):
    before, after = non_test_sources(repo, base), non_test_sources(repo)
    count = lambda srcs, pat: sum(len(re.findall(pat, t)) for t in srcs.values())
    more = lambda pat: count(after, pat) > count(before, pat)
    not_more = lambda pat: count(after, pat) <= count(before, pat)
    return {
        # Budgets are written with the existing crash-safe write, not ad-hoc file writes.
        "persists_via_atomic_write": more(r"write_atomic\(") and not_more(r"\bfs::write\(|File::create\("),
        # Category/amount rules come from the shared validation module.
        "reuses_entry_validation": more(r"\bvalidate::"),
        # Output goes through the shared table/JSON/CSV renderers, never printed by hand.
        "renders_through_output_tables": more(r"Table::new\(") and not_more(r"\bprintln!|\bprint!"),
        # Configuration is read through Config, not straight from the environment.
        "config_not_bypassed": not_more(r"env::var"),
    }


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

    # Did the agent add or update tests?
    agent_tests_added = any(f.startswith("tests/") for f in files) or any(
        re.search(r"#\[test\]", l) for l in src_added)

    # Original test targets, as they exist at the base commit.
    _, ls = ek.sh(["git", "ls-tree", "--name-only", f"{a.base}:tests"], repo)
    orig_targets = sorted(n[:-3] for n in ls.split() if n.endswith(".rs"))

    rc, build_out = ek.sh(["cargo", "build", "--quiet"], repo, timeout=300, env=env)
    build_passed = rc == 0

    fmt_rc, _ = ek.sh(["cargo", "fmt", "--check"], repo, timeout=120, env=env)
    format_passed = fmt_rc == 0
    lint_passed = False
    agent_tests_pass = False
    if build_passed:
        lint_rc, _ = ek.sh(["cargo", "clippy", "--quiet", "--all-targets", "--", "-D", "warnings"],
                           repo, timeout=300, env=env)
        lint_passed = lint_rc == 0
        if agent_tests_added:
            trc, _ = ek.sh(["cargo", "test", "--quiet", "--no-fail-fast"], repo, timeout=400, env=env)
            agent_tests_pass = trc == 0

    # Restore the original integration tests (the agent may have edited them), add hidden tests.
    ek.sh(["git", "checkout", a.base, "--", "tests"], repo)
    ek.overlay(HERE / "hidden", repo)

    original = {}
    orig_ok = False
    hidden = {}
    if build_passed:
        runs = [["cargo", "test", "--lib", "--bins", "--no-fail-fast"]] + [
            ["cargo", "test", "--test", t, "--no-fail-fast"] for t in orig_targets if t != "common"]
        orig_ok = True
        for cmd in runs:
            rc, out = ek.sh(cmd, repo, timeout=300, env=env)
            res = ek.cargo_tests(out)
            original.update({f"{cmd[-2] if '--test' in cmd else 'unit'}::{k}": v for k, v in res.items()})
            if rc != 0 or not res and "--test" in cmd:
                orig_ok = False
        rc, out = ek.sh(["cargo", "test", "--test", HIDDEN_TARGET, "--no-fail-fast"], repo,
                        timeout=300, env=env)
        hidden = ek.cargo_tests(out)
    if not hidden:
        # Build or hidden-test compile failure: every hidden test counts as failed.
        src = (HERE / "hidden" / "tests" / f"{HIDDEN_TARGET}.rs").read_text()
        hidden = {n: False for n in re.findall(r"#\[test\]\s*fn\s+(\w+)", src)}

    arch = arch_checks(repo, a.base)

    fmt_ok = format_passed and lint_passed
    scored = ek.score_coding(
        build_passed=build_passed, hidden_results=hidden, requirement_groups=GROUPS,
        original_tests_passed=orig_ok, agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass, arch_checks=arch, unrelated=unrelated, fmt_ok=fmt_ok,
        diff_added=diff_added, diff_limit=3 * TASK["reference_diff_lines"], rubric=TASK["rubric"])
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
