"""Shared helpers for task evaluators (tasks/<id>/evaluate.py).

Evaluators never modify the agent's workspace: they work on a scratch copy.
Every rubric here is applied identically to both agents; the weights are
documented in README.md ("Quality score").
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

# Tool state that is not part of the agent's solution (tokenforge writes .forge/).
IGNORED_PATHS = (".forge/",)
COPY_IGNORE = shutil.ignore_patterns("target", "node_modules", ".forge")


def sh(cmd, cwd, timeout=600, env=None):
    """Run a shell command; return (returncode, combined output). Timeouts give rc 124."""
    e = dict(os.environ)
    if env:
        e.update(env)
    try:
        p = subprocess.run(cmd, cwd=cwd, shell=isinstance(cmd, str), capture_output=True,
                           text=True, timeout=timeout, env=e)
        return p.returncode, p.stdout + p.stderr
    except subprocess.TimeoutExpired as ex:
        out = (ex.stdout or b"") + (ex.stderr or b"")
        if isinstance(out, bytes):
            out = out.decode(errors="replace")
        return 124, out + f"\n[timeout after {timeout}s]"


def scratch_copy(workspace) -> Path:
    """Copy the workspace (with .git) to a temp dir so evaluation cannot alter the run."""
    dst = Path(tempfile.mkdtemp(prefix="tfbench-eval-")) / "repo"
    shutil.copytree(workspace, dst, ignore=COPY_IGNORE, symlinks=True)
    return dst


def _ignored(path: str) -> bool:
    return any(path.startswith(p) for p in IGNORED_PATHS)


def changed_files(repo, base) -> list[str]:
    """Tracked files changed since base plus untracked files, minus tool state."""
    _, a = sh(["git", "diff", "--name-only", base], repo)
    _, b = sh(["git", "ls-files", "--others", "--exclude-standard"], repo)
    files = {l.strip() for l in (a + "\n" + b).splitlines() if l.strip()}
    return sorted(f for f in files if not _ignored(f))


def diff_size(repo, base) -> tuple[int, int]:
    """(added, removed) lines vs base, including untracked files, excluding tool state."""
    sh(["git", "add", "-A", "--intent-to-add", "."], repo)
    _, out = sh(["git", "diff", "--numstat", base, "--", ".", ":(exclude).forge"], repo)
    add = rem = 0
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) == 3 and parts[0].isdigit():
            add += int(parts[0]); rem += int(parts[1])
    return add, rem


def matches_any(path: str, globs) -> bool:
    from fnmatch import fnmatch
    return any(fnmatch(path, g) for g in globs)


def unrelated_changes(files, allowed_globs) -> list[str]:
    return [f for f in files if not matches_any(f, allowed_globs)]


def overlay(src_dir, repo):
    """Copy hidden files (tests) into the scratch repo, overwriting."""
    src_dir = Path(src_dir)
    for p in src_dir.rglob("*"):
        if p.is_file():
            dst = Path(repo) / p.relative_to(src_dir)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, dst)


# ---------- test-output parsers: return {test_name: passed} ----------

def go_test_json(output: str) -> dict[str, bool]:
    res = {}
    for line in output.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        t, act = ev.get("Test"), ev.get("Action")
        if t and act in ("pass", "fail", "skip"):
            res[t] = act == "pass"
    return res


_CARGO = re.compile(r"^test (\S+) \.\.\. (ok|FAILED|ignored)", re.M)


def cargo_tests(output: str) -> dict[str, bool]:
    return {m.group(1): m.group(2) == "ok" for m in _CARGO.finditer(output)}


_TAP = re.compile(r"^\s*(ok|not ok) \d+ - (.+?)(?:\s+#.*)?$", re.M)


def node_tap(output: str) -> dict[str, bool]:
    """Parse `node --test --test-reporter=tap`. Suites appear as their own entries; keep leaves too."""
    return {m.group(2).strip(): m.group(1) == "ok" for m in _TAP.finditer(output)}


def group_results(results: dict[str, bool], groups: dict[str, list[str]]):
    """Map requirement -> list of test-name prefixes. A requirement is met when it has
    at least one matching test and every matching test passed. Missing tests count as failed."""
    met = {}
    for req, prefixes in groups.items():
        hits = [ok for name, ok in results.items() if any(name.startswith(p) for p in prefixes)]
        met[req] = bool(hits) and all(hits)
    return met


# ---------- rubrics ----------

def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def score_coding(*, build_passed, hidden_results, requirement_groups, original_tests_passed,
                 agent_tests_added, agent_tests_pass, arch_checks, unrelated, fmt_ok,
                 diff_added, diff_limit, rubric="coding"):
    """Coding / debugging / refactor rubric (README: Quality score).

    correctness  40: fraction of hidden behaviour tests passing (0 if build fails)
    regression   20: 10 original suite still passes + 10 agent added/updated tests that pass
    architecture 15: fraction of task-specific structural checks (root cause for debugging)
    completeness 15: fraction of requirement groups fully passing (0 if build fails)
    cleanliness  10: 4 no unrelated files + 3 fmt/lint clean + 3 diff within limit
    """
    total = len(hidden_results)
    passed = sum(hidden_results.values())
    corr = (passed / total if total else 0.0) if build_passed else 0.0
    met = group_results(hidden_results, requirement_groups)
    comp = (sum(met.values()) / len(met) if met else 0.0) if build_passed else 0.0
    reg = (10 if original_tests_passed else 0) + (10 if (agent_tests_added and agent_tests_pass) else 0)
    arch = sum(arch_checks.values()) / len(arch_checks) if arch_checks else 0.0
    clean = (4 if not unrelated else 0) + (3 if fmt_ok else 0) + (3 if diff_added <= diff_limit else 0)
    comps = {"correctness": round(40 * corr, 2), "regression": reg, "architecture": round(15 * arch, 2),
             "completeness": round(15 * comp, 2), "cleanliness": clean}
    q = round(sum(comps.values()), 2)
    if not build_passed or passed == 0:
        status = "failed"
    elif passed == total and original_tests_passed:
        status = "completed"
    else:
        status = "partial"
    return {"rubric": rubric, "components": comps, "quality_score": q, "status": status,
            "requirements_met": met, "hidden_tests_passed": passed, "hidden_tests_total": total}


SEV = {"low": 0, "medium": 1, "high": 2, "critical": 3}
SEV_WEIGHT = {"critical": 3, "high": 2, "medium": 1, "low": 1}


def score_review(findings: list[dict], truth: list[dict], *, valid=True):
    """PR-review rubric.

    truth item: {id, severity, file, lines:[lo,hi], keywords:[[alt,...],...], alt:[{file, lines}]?}
    (alt = other places where the same issue can legitimately be reported; every keyword group
    must match at least one alternative in the finding text, case-insensitive)
    finding:   {file, line, severity, title, explanation}

    recall     70: severity-weighted recall (critical 3, high 2, medium/low 1)
    precision  15: matched findings / reported findings
    severity   15: matched findings whose severity is within one level of the truth
    """
    if not valid:
        return {"rubric": "review", "components": {"recall": 0, "precision": 0, "severity": 0},
                "quality_score": 0, "status": "failed", "matched": {}, "false_positives": [], "missed": [t["id"] for t in truth]}
    used, matched = set(), {}
    for t in truth:
        for i, f in enumerate(findings):
            if i in used:
                continue
            fpath = str(f.get("file", "")).lstrip("./")
            line = f.get("line")
            locs = [(t["file"], t["lines"])] + [(a["file"], a["lines"]) for a in t.get("alt", [])]
            if not any((fpath.endswith(lf) or lf.endswith(fpath or "\0"))
                       and not (isinstance(line, int) and not (lo - 8 <= line <= hi + 8))
                       for lf, (lo, hi) in locs):
                continue
            text = " ".join(str(f.get(k, "")) for k in ("title", "explanation", "description")).lower()
            if all(any(k.lower() in text for k in grp) for grp in t["keywords"]):
                used.add(i); matched[t["id"]] = i
                break
    wt = sum(SEV_WEIGHT[t["severity"]] for t in truth)
    got = sum(SEV_WEIGHT[t["severity"]] for t in truth if t["id"] in matched)
    recall = got / wt if wt else 0.0
    precision = len(matched) / len(findings) if findings else 0.0
    sev_ok = [abs(SEV.get(str(findings[i].get("severity", "")).lower(), -9) - SEV[t["severity"]]) <= 1
              for t in truth for tid, i in matched.items() if tid == t["id"]]
    sev = sum(sev_ok) / len(sev_ok) if sev_ok else 0.0
    comps = {"recall": round(70 * recall, 2), "precision": round(15 * precision, 2), "severity": round(15 * sev, 2)}
    missed = [t["id"] for t in truth if t["id"] not in matched]
    missed_crit = [t["id"] for t in truth if t["id"] in missed and t["severity"] == "critical"]
    q = round(sum(comps.values()), 2)
    status = "completed" if not missed_crit and recall >= 0.75 else ("partial" if matched else "failed")
    return {"rubric": "review", "components": comps, "quality_score": q, "status": status,
            "matched": {k: findings[v].get("title") for k, v in matched.items()},
            "false_positives": [f.get("title") for i, f in enumerate(findings) if i not in used],
            "missed": missed, "missed_critical": missed_crit,
            "true_positives": len(matched), "reported": len(findings)}


def score_architecture(steps: list[tuple[str, str]], truth: dict, repo):
    """Architecture-investigation rubric.

    steps: ordered (path, symbol) pairs extracted from the agent's answer.
    truth: {"path": [[path, symbol], ...] in execution order, "decoys": [[path, symbol], ...]}

    components 60: fraction of ground-truth steps mentioned (path and symbol both match)
    order      15: fraction of consecutive found ground-truth pairs in the right order
    accuracy   15: 15 minus 5 per referenced path that does not exist in the repo
    decoys     10: 10 minus 5 per decoy presented as part of the path
    """
    def hit(step, ref):
        p, s = step; rp, rs = ref
        return (p.endswith(rp) or rp.endswith(p)) and s.split(".")[-1] == rs.split(".")[-1]
    found_idx = []
    for ref in truth["path"]:
        idx = next((i for i, st in enumerate(steps) if hit(st, ref)), None)
        found_idx.append(idx)
    found = [i for i in found_idx if i is not None]
    comp = len(found) / len(truth["path"])
    pairs = [(a, b) for a, b in zip(found_idx, found_idx[1:]) if a is not None and b is not None]
    order = sum(a <= b for a, b in pairs) / len(pairs) if pairs else 0.0
    missing_paths = sorted({p for p, _ in steps if p and not (Path(repo) / p).exists()})
    acc = max(0, 15 - 5 * len(missing_paths))
    decoy_hits = [d for d in truth.get("decoys", []) if any(hit(st, d) for st in steps)]
    dec = max(0, 10 - 5 * len(decoy_hits))
    comps = {"components": round(60 * comp, 2), "order": round(15 * order, 2), "accuracy": acc, "decoys": dec}
    q = round(sum(comps.values()), 2)
    status = "completed" if comp >= 0.8 and not decoy_hits else ("partial" if found else "failed")
    return {"rubric": "architecture", "components": comps, "quality_score": q, "status": status,
            "found": [truth["path"][k] for k, i in enumerate(found_idx) if i is not None],
            "missing": [truth["path"][k] for k, i in enumerate(found_idx) if i is None],
            "hallucinated_paths": missing_paths, "decoys_cited": decoy_hits}


_STEP = re.compile(r"`?((?:[\w.-]+/)*[\w.-]+\.(?:ts|js|mjs|go|rs|py|tsx))`?\s*[:#]\s*`?([A-Za-z_][\w.]*)`?")


def extract_steps(text: str) -> list[tuple[str, str]]:
    """Pull `path/to/file.ext:symbol` references from an answer, in order of appearance."""
    return [(m.group(1).lstrip("./"), m.group(2)) for m in _STEP.finditer(text)]


def write_result(out, task_id, checks: dict, scored: dict, details: dict | None = None):
    res = {"task": task_id, "checks": checks, **scored, "details": details or {}}
    Path(out).write_text(json.dumps(res, indent=2, default=str) + "\n")
    return res
