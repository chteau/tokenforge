#!/usr/bin/env python3
"""Evaluator for pr-review: review of the invoice export pull request."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "runner"))
import evalkit  # noqa: E402

TASK = json.loads((HERE / "task.json").read_text())
TRUTH = json.loads((HERE / "hidden" / "ground_truth.json").read_text())
REQUIRED = ("file", "line", "severity", "title", "explanation")


def load_review(repo: Path):
    """Return (findings, valid, problem)."""
    p = repo / "review.json"
    if not p.is_file():
        return [], False, "review.json not found"
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        return [], False, f"invalid JSON: {e}"
    if isinstance(data, dict):
        for key in ("findings", "issues", "comments", "review"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
    if not isinstance(data, list):
        return [], False, "review.json must contain a JSON array"
    findings = []
    for item in data:
        if not isinstance(item, dict):
            continue
        f = dict(item)
        if isinstance(f.get("line"), str) and f["line"].strip().isdigit():
            f["line"] = int(f["line"].strip())
        if isinstance(f.get("line"), float):
            f["line"] = int(f["line"])
        findings.append(f)
    if not findings and data:
        return [], False, "no finding objects in review.json"
    return findings, True, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    repo = evalkit.scratch_copy(a.workspace)
    findings, valid, problem = load_review(repo)
    scored = evalkit.score_review(findings, TRUTH, valid=valid)
    changed = evalkit.changed_files(repo, a.base)
    details = {
        "review_valid": valid,
        "problem": problem,
        "findings_reported": len(findings),
        "missing_keys": sorted({k for f in findings for k in REQUIRED if k not in f}),
        "changed_files": changed,
        "unrelated_changes": [f for f in changed if f != "review.json"],
    }
    checks = {"build_passed": None, "tests_passed": None, "lint_passed": None,
              "format_passed": None, "typecheck_passed": None}
    evalkit.write_result(a.out, TASK["id"], checks, scored, details)


if __name__ == "__main__":
    main()
