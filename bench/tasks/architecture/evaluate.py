#!/usr/bin/env python3
"""Evaluator for the architecture task: scores ANSWER.md against the hidden ground truth.

Only the numbered-list portion of ANSWER.md counts. From each numbered line
(`1. ...` or `1) ...`) the first `path/to/file.ext:symbol` reference is taken
as that step, so prose after the list (e.g. "similar code NOT on this path")
and side remarks inside a step are never scored as path steps or decoys.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runner"))
import evalkit  # noqa: E402

TASK_ID = "architecture"
HERE = Path(__file__).resolve().parent

NUMBERED = re.compile(r"^\s*(?:[-*+]\s+)?\d+[.)]\s+(.*\S)\s*$")
# `file.ts:Class#method` / `file.ts:Class::method` -> `file.ts:Class.method`
MEMBER_SEP = re.compile(r"(\.(?:ts|tsx|js|mjs|go|rs|py)`?\s*[:#]\s*`?[A-Za-z_][\w.]*)(?:#|::)(?=[A-Za-z_])")

CHECKS = {"build_passed": None, "tests_passed": None, "lint_passed": None,
          "format_passed": None, "typecheck_passed": None}


def extract_numbered_steps(text: str) -> list[tuple[str, str]]:
    steps = []
    for line in text.splitlines():
        m = NUMBERED.match(line)
        if not m:
            continue
        body = MEMBER_SEP.sub(r"\1.", m.group(1))
        found = evalkit.extract_steps(body)
        if not found:
            continue
        path, symbol = found[0]
        symbol = symbol.strip(".")
        if path and symbol:
            steps.append((path, symbol))
    return steps


def zero(reason: str, truth: dict) -> dict:
    return {"rubric": "architecture",
            "components": {"components": 0, "order": 0, "accuracy": 0, "decoys": 0},
            "quality_score": 0, "status": "failed", "found": [],
            "missing": truth["path"], "hallucinated_paths": [], "decoys_cited": [], "reason": reason}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    truth = json.loads((HERE / "hidden" / "ground_truth.json").read_text())
    repo = evalkit.scratch_copy(a.workspace)
    files = evalkit.changed_files(repo, a.base)
    evalkit.overlay(HERE / "hidden", repo)
    task = json.loads((HERE / "task.json").read_text())
    details = {"changed_files": files,
               "unrelated_changes": evalkit.unrelated_changes(files, task["allowed_change_globs"])}

    answer = Path(a.workspace) / "ANSWER.md"
    if not answer.is_file():
        scored = zero("ANSWER.md missing", truth)
    else:
        steps = extract_numbered_steps(answer.read_text(errors="replace"))
        details["steps"] = [f"{p}:{s}" for p, s in steps]
        if not steps:
            scored = zero("no numbered path:symbol steps found in ANSWER.md", truth)
        else:
            scored = evalkit.score_architecture(steps, truth, repo)

    res = evalkit.write_result(a.out, TASK_ID, CHECKS, scored, details)
    print(json.dumps({"status": res["status"], "quality_score": res["quality_score"],
                      "components": res["components"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
