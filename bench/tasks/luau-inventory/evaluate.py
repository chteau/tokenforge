#!/usr/bin/env python3
"""Evaluator for luau-inventory: Roblox-style inventory, stacking and crafting modules run under lune.

checks:
  build_passed      every module under src/ loads under lune (a generated loader requires each one)
  tests_passed      True (greenfield: there is no original suite)
  lint_passed       null (no linter available for Luau here)
  format_passed     null (no formatter available); fmt_ok for scoring = build_passed
  typecheck_passed  null (no Luau analyzer available)
"""
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
HIDDEN_SCRIPT = "hidden_tests/run.luau"
GROUPS = {
    "items": ["items_"],
    "signal": ["signal_"],
    "inventory_basics": ["new_"],
    "add": ["add_"],
    "remove": ["remove_"],
    "move": ["move_"],
    "change_events": ["events_"],
    "save_load": ["save_"],
    "crafting": ["craft_"],
}
ROBLOX_ONLY = re.compile(r"\bgame\s*[:.]|\bworkspace\b|\bInstance\s*\.\s*new\b|\bscript\s*\.\s*Parent\b")
GLOBAL_TABLES = re.compile(r"\b_G\b|\bshared\s*[.\[]")
TOP_LEVEL_GLOBAL = re.compile(r"^(?:[A-Za-z_]\w*\s*=(?!=)|function\s+[A-Za-z_]\w*\s*\()", re.M)


def lune_bin():
    found = shutil.which("lune")
    if found:
        return found
    fallback = Path.home() / ".local" / "bin" / "lune"
    return str(fallback) if fallback.exists() else "lune"


def module_files(repo):
    """Luau modules under src/, excluding spec/test files."""
    src = repo / "src"
    if not src.is_dir():
        return []
    out = []
    for p in sorted(src.rglob("*")):
        if p.suffix not in (".luau", ".lua") or not p.is_file():
            continue
        rel = p.relative_to(repo)
        if re.search(r"\.(spec|test)\.luau?$", p.name) or "__tests__" in rel.parts:
            continue
        out.append(rel)
    return out


def require_path(rel: Path) -> str:
    """String require for a module relative to the repo root (init files resolve to their folder)."""
    target = rel.parent if rel.stem == "init" else rel.with_suffix("")
    return "./" + target.as_posix()


def strip_comments(text: str) -> str:
    text = re.sub(r"--\[(=*)\[.*?\]\1\]", "", text, flags=re.S)
    return re.sub(r"--[^\n]*", "", text)


def load_modules(repo, lune, mods):
    """Require every module in its own lune process (a module that fails to load can make later
    requires of it hang inside one process); return (all loaded, output)."""
    if not mods:
        return False, "no Luau modules under src/"
    loader = repo / "__load_module.luau"
    ok_all, outs = True, []
    for rel in mods:
        loader.write_text(f'require("{require_path(rel)}")\nprint("loaded {rel.as_posix()}")\n')
        rc, out = ek.sh([lune, "run", loader.name], repo, timeout=20)
        if rc != 0:
            ok_all = False
            outs.append(f"FAILED {rel.as_posix()}:\n{out.strip()[-600:]}")
    loader.unlink()
    return ok_all, "\n".join(outs)


def arch_checks(repo, mods):
    texts = {rel: (repo / rel).read_text(errors="replace") for rel in mods}
    code = {rel: strip_comments(t) for rel, t in texts.items()}

    def strict(t):
        t = t.lstrip("\ufeff")
        first = next((l for l in t.splitlines() if l.strip()), "")
        return first.strip().startswith("--!strict")

    has = bool(mods)
    return {
        # Every module opts into strict type checking.
        "strict_mode_everywhere": has and all(strict(t) for t in texts.values()),
        # Split into several ModuleScripts (items / signal / inventory / crafting), not one blob.
        "modular_layout": len(mods) >= 3,
        # Testable outside the engine: no Roblox-only globals.
        "no_roblox_only_globals": has and not any(ROBLOX_ONLY.search(c) for c in code.values()),
        # State lives in objects: no _G/shared tables, no top-level global assignments.
        "no_global_state": has and not any(GLOBAL_TABLES.search(c) or TOP_LEVEL_GLOBAL.search(c)
                                           for c in code.values()),
        # Public types are exported for consumers.
        "exports_types": sum(len(re.findall(r"^\s*export\s+type\s+\w+", c, re.M)) for c in code.values()) >= 2,
    }


def hidden_names():
    src = (HERE / "hidden" / HIDDEN_SCRIPT).read_text()
    return re.findall(r'^test\("(\w+)"', src, re.M)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    repo = ek.scratch_copy(a.workspace)
    lune = lune_bin()
    env_path = os.pathsep.join([str(Path.home() / ".local" / "bin"), os.environ.get("PATH", "")])
    files = ek.changed_files(repo, a.base)
    diff_added, diff_removed = ek.diff_size(repo, a.base)
    unrelated = ek.unrelated_changes(files, TASK["allowed_change_globs"])

    mods = module_files(repo)
    build_passed, build_out = load_modules(repo, lune, mods)

    # The agent's own suite: `lune run tests/run.luau` must exist and exit 0.
    agent_tests_added = (repo / "tests" / "run.luau").is_file()
    agent_tests_pass = False
    agent_out = ""
    if agent_tests_added:
        rc, agent_out = ek.sh([lune, "run", "tests/run.luau"], repo, timeout=60, env={"PATH": env_path})
        agent_tests_pass = rc == 0

    ek.overlay(HERE / "hidden", repo)
    hidden = {n: False for n in hidden_names()}
    hidden_out = ""
    if build_passed:
        _, hidden_out = ek.sh([lune, "run", HIDDEN_SCRIPT], repo, timeout=60)
        for m in re.finditer(r"^(ok|not ok) (\w+)", hidden_out, re.M):
            if m.group(2) in hidden:
                hidden[m.group(2)] = m.group(1) == "ok"

    arch = arch_checks(repo, mods)
    scored = ek.score_coding(
        build_passed=build_passed, hidden_results=hidden, requirement_groups=GROUPS,
        original_tests_passed=True, agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass, arch_checks=arch, unrelated=unrelated, fmt_ok=build_passed,
        diff_added=diff_added, diff_limit=1_000_000, rubric=TASK["rubric"])
    checks = {"build_passed": build_passed, "tests_passed": True, "lint_passed": None,
              "format_passed": None, "typecheck_passed": None}
    failed_lines = [l for l in hidden_out.splitlines() if l.startswith("not ok")]
    details = {"changed_files": files, "unrelated": unrelated, "diff": [diff_added, diff_removed],
               "modules": [m.as_posix() for m in mods], "agent_tests_added": agent_tests_added,
               "agent_tests_pass": agent_tests_pass, "arch_checks": arch, "hidden": hidden,
               "hidden_failures": failed_lines[:40],
               "build_output": build_out[-2000:] if not build_passed else "",
               "agent_test_output": agent_out[-1500:] if agent_tests_added and not agent_tests_pass else ""}
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
