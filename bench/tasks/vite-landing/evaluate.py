#!/usr/bin/env python3
"""Evaluator for vite-landing (greenfield Vite + TypeScript landing page).

Checks (on a scratch copy, never the workspace; node_modules and dist are rebuilt fresh):
  build_passed      `npm ci || npm install`, then `npm run build` exits 0 and writes dist/index.html
  typecheck_passed  `npm run typecheck` (fallback `npx tsc --noEmit -p .` when the script is missing)
  tests_passed      True: greenfield, there is no original suite
  lint_passed       null (no linter required by the task)
  format_passed     null (no formatter required by the task); fmt_ok for scoring = typecheck_passed
Hidden checks: hidden/browser-check.mjs serves dist/ over HTTP and drives headless Chrome over
the DevTools Protocol. Test names carry requirement-group prefixes; the expected names are read
from the script so a crash counts every check as failed.
Agent tests (optional credit): test files the agent added, run with `npm test` (CI=true).
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "runner"))
import evalkit  # noqa: E402

TASK = json.loads((HERE / "task.json").read_text())
TASK_ID = TASK["id"]
CHECK_SCRIPT = HERE / "hidden" / "browser-check.mjs"
CHROME = shutil.which("google-chrome") or "/usr/bin/google-chrome"

REQUIREMENT_GROUPS = {
    "page_structure_and_nav": ["STRUCT:"],
    "hero": ["HERO:"],
    "signup_modal": ["MODAL:"],
    "signup_form_validation": ["FORM:"],
    "features_grid": ["FEATURES:"],
    "pricing_toggle": ["PRICING:"],
    "faq": ["FAQ:"],
    "footer": ["FOOTER:"],
}

FEATURE_TITLES = [
    "Shared timelines", "Smart reminders", "Workload balance", "Integrations",
    "Reports that write themselves", "Private by default",
]
SKIP_DIRS = {"node_modules", "dist", ".git", ".forge", "coverage", ".vite"}
MARKUP_EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".vue", ".svelte", ".html"}
TS_LIKE_EXT = {".ts", ".tsx", ".vue", ".svelte"}
TEST_RE = re.compile(r"(^|/)(tests?|__tests__|e2e)/|\.(test|spec)\.[cm]?[jt]sx?$")


def expected_names() -> list[str]:
    src = CHECK_SCRIPT.read_text()
    names = re.findall(r'\b(?:check|formCase)\(\s*"([^"]+)"', src)
    names += re.findall(r'\bconst name = "([^"]+)"', src)
    return names


def project_files(repo: Path) -> list[Path]:
    out = []
    for p in repo.rglob("*"):
        rel = p.relative_to(repo).parts
        if any(part in SKIP_DIRS for part in rel) or not p.is_file():
            continue
        out.append(p)
    return out


def load_jsonc(path: Path) -> dict:
    text = path.read_text(errors="replace")
    text = re.sub(r'("(?:\\.|[^"\\])*")|//[^\n]*|/\*.*?\*/', lambda m: m.group(1) or "", text, flags=re.S)
    text = re.sub(r",(\s*[}\]])", r"\1", text)
    try:
        return json.loads(text)
    except ValueError:
        return {}


def read_pkg(repo: Path) -> dict:
    try:
        return json.loads((repo / "package.json").read_text())
    except (OSError, ValueError):
        return {}


def strict_mode_on(repo: Path) -> bool:
    configs = [p for p in repo.glob("tsconfig*.json")]
    if not configs:
        return False
    values = [load_jsonc(p).get("compilerOptions", {}).get("strict") for p in configs]
    if any(v is False for v in values):
        return False
    if any(v is True for v in values):
        return True
    try:  # TypeScript >= 6 enables strict by default.
        ver = json.loads((repo / "node_modules" / "typescript" / "package.json").read_text())["version"]
        return int(ver.split(".")[0]) >= 6
    except (OSError, ValueError, KeyError):
        return False


def architecture_checks(repo: Path, changed: list[str]) -> dict[str, bool]:
    files = project_files(repo)
    rel = lambda p: str(p.relative_to(repo))  # noqa: E731
    source = [p for p in files if p.suffix in MARKUP_EXT and not TEST_RE.search(rel(p))]
    texts = {rel(p): p.read_text(errors="replace") for p in source}
    all_src = "\n".join(texts.values())

    index = repo / "index.html"
    index_html = index.read_text(errors="replace") if index.exists() else ""
    scripts = re.findall(r"<script\b([^>]*)>(.*?)</script\s*>", index_html, flags=re.S | re.I)
    no_inline_logic = bool(index_html) and all("src=" in attrs and not body.strip() for attrs, body in scripts)

    ts_text = "\n".join(t for r, t in texts.items() if Path(r).suffix in TS_LIKE_EXT)
    features_from_data = (
        1 <= all_src.count("feature-card") <= 3
        and all(ts_text.count(t) >= 1 for t in FEATURE_TITLES)
        and not any(t in index_html for t in FEATURE_TITLES)
    )
    plans_from_data = 1 <= all_src.count("plan-card") <= 2

    pkg = read_pkg(repo)
    deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
    js_sources = [
        rel(p) for p in files
        if p.suffix in {".js", ".jsx", ".mjs", ".cjs"} and not (p.parent == repo and ("config" in p.name or p.name.startswith(".")))
    ]
    ts_sources = [p for p in files if p.suffix in TS_LIKE_EXT and not p.name.endswith(".d.ts")]
    typescript_project = "vite" in deps and "typescript" in deps and bool(ts_sources) and not js_sources

    return {
        "typescript_strict_mode": strict_mode_on(repo),
        "typescript_vite_project": typescript_project,
        "features_rendered_from_data": features_from_data,
        "plans_rendered_from_data": plans_from_data,
        "no_inline_script_in_index_html": no_inline_logic,
        "build_output_not_committed": bool(changed) and not any(
            f.startswith(("dist/", "node_modules/")) for f in changed
        ),
    }


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run_browser_checks(repo: Path, details: dict) -> dict[str, bool]:
    port = free_port()
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1", "--directory", str(repo / "dist")],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(50):
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    break
            except OSError:
                time.sleep(0.1)
        rc, out = evalkit.sh(["node", str(CHECK_SCRIPT), f"http://127.0.0.1:{port}/", CHROME], repo, timeout=180)
    finally:
        server.kill()
        server.wait()
    parsed: dict = {}
    for line in reversed(out.strip().splitlines()):
        try:
            parsed = json.loads(line)
            break
        except ValueError:
            continue
    details["browser_notes"] = parsed.get("notes", {})
    if parsed.get("error"):
        details["browser_error"] = parsed["error"][:2000]
    if not parsed:
        details["browser_output_tail"] = out[-3000:]
    return parsed.get("results", {})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    repo = evalkit.scratch_copy(args.workspace)
    base = args.base
    details: dict = {}

    changed = evalkit.changed_files(repo, base)
    diff_added, diff_removed = evalkit.diff_size(repo, base)
    unrelated = evalkit.unrelated_changes(changed, TASK["allowed_change_globs"])
    shutil.rmtree(repo / "dist", ignore_errors=True)

    pkg = read_pkg(repo)
    scripts = pkg.get("scripts", {})
    env = {"CI": "true", "npm_config_audit": "false", "npm_config_fund": "false", "npm_config_update_notifier": "false"}
    install_ok = False
    if pkg:
        rc = 1
        if (repo / "package-lock.json").exists():
            rc, out = evalkit.sh(["npm", "ci"], repo, timeout=300, env=env)
        if rc != 0:
            rc, out = evalkit.sh(["npm", "install"], repo, timeout=300, env=env)
        install_ok = rc == 0
        details["install_output"] = out[-2000:]

    build_passed = False
    if install_ok and "build" in scripts:
        rc, out = evalkit.sh(["npm", "run", "build"], repo, timeout=300, env=env)
        build_passed = rc == 0 and (repo / "dist" / "index.html").exists()
        details["build_output"] = out[-3000:]

    typecheck_passed = False
    if install_ok:
        cmd = ["npm", "run", "typecheck"] if "typecheck" in scripts else ["npx", "--no-install", "tsc", "--noEmit", "-p", "."]
        rc, out = evalkit.sh(cmd, repo, timeout=300, env=env)
        typecheck_passed = rc == 0
        details["typecheck_cmd"] = " ".join(cmd)
        details["typecheck_output"] = out[-3000:]

    agent_tests = [f for f in changed if TEST_RE.search(f) and (repo / f).is_file()]
    agent_tests_added = bool(agent_tests)
    agent_tests_pass = False
    if agent_tests_added and install_ok and "test" in scripts:
        rc, out = evalkit.sh(["npm", "test"], repo, timeout=240, env=env)
        agent_tests_pass = rc == 0
        details["agent_tests_output"] = out[-2000:]
    details["agent_tests"] = agent_tests

    arch = architecture_checks(repo, changed)

    names = expected_names()
    got = run_browser_checks(repo, details) if build_passed else {}
    hidden_results = {n: bool(got.get(n, False)) for n in names}
    details["hidden_failed"] = [n for n, ok in hidden_results.items() if not ok]

    scored = evalkit.score_coding(
        build_passed=build_passed,
        hidden_results=hidden_results,
        requirement_groups=REQUIREMENT_GROUPS,
        original_tests_passed=True,
        agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass,
        arch_checks=arch,
        unrelated=unrelated,
        fmt_ok=typecheck_passed,
        diff_added=diff_added,
        diff_limit=1_000_000,
        rubric=TASK["rubric"],
    )
    checks = {
        "build_passed": build_passed,
        "tests_passed": True,
        "lint_passed": None,
        "format_passed": None,
        "typecheck_passed": typecheck_passed,
    }
    details.update({
        "changed_files": changed,
        "unrelated_files": unrelated,
        "diff_added": diff_added,
        "diff_removed": diff_removed,
        "architecture_checks": arch,
    })
    evalkit.write_result(args.out, TASK_ID, checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
