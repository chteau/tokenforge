#!/usr/bin/env python3
"""Evaluator for rust-tui: greenfield `kanban` terminal board (ratatui + headless script mode)."""
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
HIDDEN_SCRIPT = HERE / "hidden" / "test_kanban.py"
GROUPS = {
    "script_format": ["script_"],
    "navigation": ["nav_"],
    "add": ["add_"],
    "edit": ["edit_"],
    "delete": ["delete_"],
    "move": ["move_"],
    "persistence": ["persist_"],
    "render": ["render_"],
    "cli_errors": ["cli_"],
}
TERMINAL_CRATES = re.compile(r"\b(ratatui|crossterm)\b")


def strip_tests(text):
    i = text.find("#[cfg(test)]")
    return text if i < 0 else text[:i]


def sources(repo):
    """{path: non-test source} for src/**/*.rs."""
    src = repo / "src"
    if not src.is_dir():
        return {}
    return {str(p.relative_to(repo)): strip_tests(p.read_text(errors="replace"))
            for p in src.rglob("*.rs")}


def code_lines(text):
    return sum(1 for l in text.splitlines() if l.strip() and not l.strip().startswith("//"))


def dependencies(repo):
    """Dependency names from Cargo.toml [dependencies] (best effort, no toml parser needed)."""
    p = repo / "Cargo.toml"
    if not p.exists():
        return set()
    deps, section = set(), ""
    for line in p.read_text(errors="replace").splitlines():
        s = line.strip()
        m = re.match(r"^\[([^\]]+)\]$", s)
        if m:
            section = m.group(1).strip()
            if section.startswith("dependencies."):
                deps.add(section.split(".", 1)[1])
            continue
        if section == "dependencies":
            m = re.match(r"^([A-Za-z0-9_-]+)\s*=", s)
            if m:
                deps.add(m.group(1))
    return deps


def arch_checks(repo, bin_path, env):
    srcs = sources(repo)
    sizes = {p: code_lines(t) for p, t in srcs.items()}
    total = sum(sizes.values())
    deps = dependencies(repo)
    all_src = "\n".join(srcs.values())

    # Split into modules: at least two source files, none holding most of the code.
    modular = len([s for s in sizes.values() if s >= 10]) >= 2 and total > 0 and \
        max(sizes.values()) <= 0.75 * total
    # Board/key logic lives in at least one substantial file that never touches the terminal crates.
    logic_isolated = any(sizes[p] >= 40 and not TERMINAL_CRATES.search(t) for p, t in srcs.items())
    # Interactive UI really uses the requested crates.
    uses_tui_crates = "ratatui" in deps and ("crossterm" in deps or "ratatui::crossterm" in all_src)
    # Persistence through serde rather than hand-rolled JSON.
    serde_persistence = "serde_json" in deps
    # Crash-safe save: temporary file renamed over the data file.
    atomic_save = bool(re.search(r"\brename\s*\(", all_src))
    # Script mode runs with no controlling terminal and emits no escape sequences.
    headless = False
    if bin_path.exists():
        tmp = repo.parent / "headless"
        tmp.mkdir(exist_ok=True)
        (tmp / "keys").write_text("a\ntext:x\nEnter\n")
        rc, out = ek.sh(["setsid", str(bin_path), "--data", str(tmp / "b.json"), "--script",
                         str(tmp / "keys"), "--render", "40x6"], tmp, timeout=20,
                        env={**env, "TERM": "dumb"})
        headless = rc == 0 and "\x1b" not in out and "KANBAN" in out
    return {"modular_sources": modular, "logic_isolated_from_terminal": logic_isolated,
            "uses_ratatui_crossterm": uses_tui_crates, "serde_persistence": serde_persistence,
            "atomic_save": atomic_save, "headless_script_mode": headless}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    repo = ek.scratch_copy(a.workspace)
    env = {"CARGO_TARGET_DIR": str(repo / "target"), "CARGO_TERM_COLOR": "never",
           "RUST_BACKTRACE": "0"}
    files = ek.changed_files(repo, a.base)
    diff_added, diff_removed = ek.diff_size(repo, a.base)
    unrelated = ek.unrelated_changes(files, TASK["allowed_change_globs"])

    src_dir, tests_dir = repo / "src", repo / "tests"
    agent_tests_added = (src_dir.is_dir() and any(
        re.search(r"#\[(\w+::)?test\]", p.read_text(errors="replace")) for p in src_dir.rglob("*.rs"))) \
        or (tests_dir.is_dir() and any(tests_dir.rglob("*.rs")))

    has_manifest = (repo / "Cargo.toml").exists()
    build_passed, build_out = False, "no Cargo.toml"
    bin_path = repo / "target" / "release" / "kanban"
    if has_manifest:
        rc, build_out = ek.sh(["cargo", "build", "--release", "--quiet"], repo, timeout=400, env=env)
        build_passed = rc == 0 and bin_path.exists()
        if rc == 0 and not bin_path.exists():
            build_out += "\nno binary target/release/kanban"

    fmt_rc, _ = ek.sh(["cargo", "fmt", "--check"], repo, timeout=120, env=env) if has_manifest else (1, "")
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

    hidden = {}
    hidden_out = ""
    if build_passed:
        _, hidden_out = ek.sh([sys.executable, "-I", str(HIDDEN_SCRIPT), str(bin_path)], repo.parent,
                              timeout=600, env=env)
        hidden = ek.cargo_tests(hidden_out)
    names = re.findall(r"@test\s*\ndef (\w+)", HIDDEN_SCRIPT.read_text())
    hidden = {n: hidden.get(n, False) for n in names}

    # The headless check needs the binary, so it is False whenever the build failed.
    arch = arch_checks(repo, bin_path, env)

    fmt_ok = format_passed and lint_passed
    scored = ek.score_coding(
        build_passed=build_passed, hidden_results=hidden, requirement_groups=GROUPS,
        original_tests_passed=True, agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass, arch_checks=arch, unrelated=unrelated, fmt_ok=fmt_ok,
        diff_added=diff_added, diff_limit=100 * TASK["reference_diff_lines"], rubric=TASK["rubric"])
    checks = {"build_passed": build_passed, "tests_passed": True, "lint_passed": lint_passed,
              "format_passed": format_passed, "typecheck_passed": None}
    details = {"changed_files": files, "unrelated": unrelated, "diff": [diff_added, diff_removed],
               "agent_tests_added": agent_tests_added, "agent_tests_pass": agent_tests_pass,
               "arch_checks": arch, "hidden": hidden,
               "hidden_failures": hidden_out[-3000:] if not all(hidden.values()) else "",
               "build_output": build_out[-2000:] if not build_passed else ""}
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
