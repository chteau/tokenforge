#!/usr/bin/env python3
"""Evaluator for paper-proofread: review.json graded against the hidden answer key.

A finding matches a planted error when its file matches (suffix match either
way), its line lies within the error's line range widened by LINE_SLACK (the
error may list alternative locations), and its text (category + description,
plus title/explanation if present) contains at least one keyword from every
keyword group. Findings and errors are paired by maximum bipartite matching, so
one finding can only claim one error.

Rubric "review" (recall-weighted):
  recall     85: matched errors / planted errors
  precision  15: 15 * TP / (TP + 0.5 * FP)  (false positives cost little)
Flooding guard: reporting more than FLOOD_FACTOR x the number of planted errors
scales the whole score by (FLOOD_FACTOR * planted / reported) and caps the status
at partial, so listing every line cannot game recall.
status: completed when recall >= 0.8, partial when anything matched, else failed.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "runner"))
import evalkit  # noqa: E402

TASK = json.loads((HERE / "task.json").read_text())
KEY = json.loads((HERE / "hidden" / "answer_key.json").read_text())
LINE_SLACK = 3
FLOOD_FACTOR = 3
TEXT_KEYS = ("category", "description", "title", "explanation", "message")
CHECKS = {"build_passed": None, "tests_passed": None, "lint_passed": None,
          "format_passed": None, "typecheck_passed": None}


def parse_line(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, str):
        m = re.search(r"\d+", v)
        return int(m.group()) if m else None
    if isinstance(v, list) and v:
        return parse_line(v[0])
    return None


def load_review(repo: Path):
    p = repo / "review.json"
    if not p.is_file():
        return [], False, "review.json not found"
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        return [], False, f"invalid JSON: {e}"
    if isinstance(data, dict):
        for key in ("findings", "errors", "issues", "review", "items"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
    if not isinstance(data, list):
        return [], False, "review.json must contain a JSON array"
    findings = [dict(x) for x in data if isinstance(x, dict)]
    if not findings and data:
        return [], False, "no finding objects in review.json"
    return findings, True, None


def norm_path(p) -> str:
    p = str(p or "").strip().replace("\\", "/")
    while p.startswith("./"):
        p = p[2:]
    return p.lstrip("/")


def can_match(f: dict, t: dict) -> bool:
    fpath = norm_path(f.get("file"))
    line = parse_line(f.get("line"))
    if not fpath or line is None:
        return False
    locs = [(t["file"], t["lines"])] + [(a["file"], a["lines"]) for a in t.get("alt", [])]
    if not any((fpath.endswith(lf) or lf.endswith("/" + fpath) or lf == fpath)
               and lo - LINE_SLACK <= line <= hi + LINE_SLACK for lf, (lo, hi) in locs):
        return False
    text = " ".join(str(f.get(k, "")) for k in TEXT_KEYS).lower()
    return all(any(k.lower() in text for k in grp) for grp in t["keywords"])


def max_matching(findings, truth):
    """Kuhn's algorithm: truth index -> finding index."""
    adj = [[i for i, f in enumerate(findings) if can_match(f, t)] for t in truth]
    owner: dict[int, int] = {}

    def try_assign(ti, seen):
        for fi in adj[ti]:
            if fi in seen:
                continue
            seen.add(fi)
            if fi not in owner or try_assign(owner[fi], seen):
                owner[fi] = ti
                return True
        return False

    for ti in range(len(truth)):
        try_assign(ti, set())
    return {ti: fi for fi, ti in owner.items()}


def score(findings, truth, valid):
    if not valid:
        return {"rubric": "review", "components": {"recall": 0, "precision": 0},
                "quality_score": 0, "status": "failed", "matched": {},
                "missed": [t["id"] for t in truth], "true_positives": 0, "reported": 0}
    m = max_matching(findings, truth)
    tp = len(m)
    fp = len(findings) - tp
    recall = tp / len(truth)
    prec = tp / (tp + 0.5 * fp) if findings else 0.0
    comps = {"recall": round(85 * recall, 2), "precision": round(15 * prec, 2)}
    flood_limit = FLOOD_FACTOR * len(truth)
    flooded = len(findings) > flood_limit
    if flooded:
        f = flood_limit / len(findings)
        comps = {k: round(v * f, 2) for k, v in comps.items()}
    q = round(sum(comps.values()), 2)
    status = "completed" if recall >= 0.8 and not flooded else ("partial" if tp else "failed")
    used = set(m.values())
    return {"rubric": "review", "components": comps, "quality_score": q, "status": status,
            "matched": {truth[ti]["id"]: str(findings[fi].get("description", ""))[:120] for ti, fi in m.items()},
            "missed": [t["id"] for k, t in enumerate(truth) if k not in m],
            "false_positives": [f"{f.get('file')}:{f.get('line')} {str(f.get('description', ''))[:100]}"
                                for i, f in enumerate(findings) if i not in used],
            "true_positives": tp, "reported": len(findings), "flooded": flooded}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    repo = evalkit.scratch_copy(a.workspace)
    findings, valid, problem = load_review(repo)
    scored = score(findings, KEY, valid)
    changed = evalkit.changed_files(repo, a.base)
    details = {"review_valid": valid, "problem": problem, "findings_reported": len(findings),
               "missing_keys": sorted({k for f in findings for k in ("file", "line", "category", "description") if k not in f}),
               "changed_files": changed,
               "unrelated_changes": evalkit.unrelated_changes(changed, TASK["allowed_change_globs"])}
    res = evalkit.write_result(a.out, TASK["id"], CHECKS, scored, details)
    print(json.dumps({"status": res["status"], "quality_score": res["quality_score"],
                      "components": res["components"]}))


if __name__ == "__main__":
    main()
