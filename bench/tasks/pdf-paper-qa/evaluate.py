#!/usr/bin/env python3
"""Evaluator for pdf-paper-qa: grades the numbered answers in ANSWER.md.

Each of the ten answers is correct when every check in hidden/answer_key.json
passes:
  number   - some number in the answer equals one of `values` within abs_tol or
             rel_tol (scientific forms such as 3e-4, 3 × 10^-4, 3x10⁻⁴ and
             thousands separators are understood)
  keywords - every group has at least one keyword in the answer (case-insensitive)
  choice   - of the listed options, the one mentioned FIRST in the answer is the
             expected one (so listing several candidates does not earn credit)
An answer containing more than MAX_NUMBERS numbers is counted wrong (hedging).

Rubric "qa": quality = 100 * correct / 10.
status: completed when >= 8 correct, partial when any correct, else failed.
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
MAX_NUMBERS = 8
CHECKS = {"build_passed": None, "tests_passed": None, "lint_passed": None,
          "format_passed": None, "typecheck_passed": None}

ITEM = re.compile(r"^\s*(?:[-*+]\s+)?(?:\*\*|__)?(?:Q(?:uestion)?\s*)?(\d{1,2})\s*(?:\*\*|__)?\s*[.):]\s*(?:\*\*|__)?\s*(.*)$", re.I)
HEADING = re.compile(r"^\s*#{1,6}\s*(?:Q(?:uestion)?\s*)?(\d{1,2})\b[.):]?\s*(.*)$", re.I)
SUP = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺", "0123456789-+")
SCI = re.compile(r"(\d+(?:\.\d+)?)\s*(?:×|x|\*|·|⋅)\s*10\s*(?:\^|\*\*)?\s*\{?\s*\(?\s*([-+]?\d+)\s*\)?\}?")
NUM = re.compile(r"(?<![\w.])-?\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][-+]?\d+)?")


def parse_answers(text: str) -> dict[int, str]:
    answers: dict[int, str] = {}
    cur = None
    for line in text.splitlines():
        m = HEADING.match(line) or ITEM.match(line)
        if m and 1 <= int(m.group(1)) <= 10 and int(m.group(1)) not in answers:
            cur = int(m.group(1))
            answers[cur] = m.group(2)
        elif cur is not None and line.strip():
            answers[cur] += " " + line.strip()
    return answers


def numbers(text: str) -> list[float]:
    t = text.translate(SUP).replace("−", "-").replace("–", "-").replace(" ", " ").replace(" ", " ")
    out = []

    def sci(m):
        out.append(float(m.group(1)) * 10 ** int(m.group(2)))
        return " "
    t = SCI.sub(sci, t)
    for m in NUM.finditer(t):
        try:
            out.append(float(m.group().replace(",", "")))
        except ValueError:
            pass
    return out


def check(ans: str, c: dict) -> bool:
    low = ans.lower()
    if c["type"] == "number":
        tol_a, tol_r = c.get("abs_tol", 0.0), c.get("rel_tol", 0.0)
        return any(abs(n - v) <= max(tol_a, tol_r * abs(v)) + 1e-12 for n in numbers(ans) for v in c["values"])
    if c["type"] == "keywords":
        return all(any(k.lower() in low for k in g) for g in c["groups"])
    if c["type"] == "choice":
        first = {}
        for name, aliases in c["options"].items():
            pos = [low.find(a.lower()) for a in aliases if a.lower() in low]
            if pos:
                first[name] = min(pos)
        return bool(first) and min(first, key=first.get) == c["answer"]
    raise ValueError(c["type"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    repo = evalkit.scratch_copy(a.workspace)
    changed = evalkit.changed_files(repo, a.base)
    details = {"changed_files": changed,
               "unrelated_changes": evalkit.unrelated_changes(changed, TASK["allowed_change_globs"])}
    p = repo / "ANSWER.md"
    answers = parse_answers(p.read_text(errors="replace")) if p.is_file() else {}
    details["answer_found"] = p.is_file()
    details["answers_parsed"] = sorted(answers)
    per_q = {}
    for q in KEY:
        ans = answers.get(q["id"], "")
        hedged = len(numbers(ans)) > MAX_NUMBERS
        per_q[str(q["id"])] = bool(ans) and not hedged and all(check(ans, c) for c in q["checks"])
    correct = sum(per_q.values())
    total = len(KEY)
    q = round(100 * correct / total, 2)
    status = "completed" if correct >= 8 else ("partial" if correct else "failed")
    scored = {"rubric": "qa", "components": {"answers": q}, "quality_score": q, "status": status,
              "correct": correct, "total": total, "per_question": per_q,
              "wrong": [k for k, v in per_q.items() if not v]}
    res = evalkit.write_result(a.out, TASK["id"], CHECKS, scored, details)
    print(json.dumps({"status": res["status"], "quality_score": res["quality_score"],
                      "components": res["components"]}))


if __name__ == "__main__":
    main()
