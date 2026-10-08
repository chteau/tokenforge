#!/usr/bin/env python3
"""Evaluator for rust-debug: stale summary cache after same-size ledger changes."""
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
HIDDEN_TARGET = "hidden_stale_totals"
GROUPS = {
    "edits_via_cli": ["stale_edit_", "stale_repeated_"],
    "rename_category": ["stale_rename_"],
    "hand_edited_ledger": ["stale_hand_"],
    "cache_still_effective": ["cache_kept_"],
}
ROOT_CAUSE_FILE = "src/cache.rs"


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
    _, old = ek.sh(["git", "show", f"{base}:{ROOT_CAUSE_FILE}"], repo)
    p = repo / ROOT_CAUSE_FILE
    new = p.read_text() if p.exists() else ""
    norm = lambda t: re.sub(r"\s+", " ", strip_tests(t)).strip()
    elsewhere = [l for f, ls in src_added.items() if f != ROOT_CAUSE_FILE for l in ls]
    commands = "\n".join(q.read_text() for q in (repo / "src" / "commands").glob("*.rs")) \
        if (repo / "src" / "commands").is_dir() else ""
    cfg = repo / "src" / "config.rs"
    cfg_text = cfg.read_text() if cfg.exists() else ""
    return {
        # The fix is in the cache's change detection, where the bug lives.
        "root_cause_fixed_in_cache": norm(old) != norm(new) and bool(new),
        # No workaround at the symptom sites (deleting/invalidating the cache from commands or the store).
        "no_invalidation_at_call_sites": not any(
            re.search(r"cache::|CACHE_FILE|summary\.cache|remove_file", l) for l in elsewhere),
        # The cache is still enabled by default and still used by the reports.
        "cache_not_disabled": bool(re.search(r'"cache\.enabled",\s*"true"', cfg_text))
            and "cache::summary" in commands,
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
