#!/usr/bin/env python3
"""Evaluator for node-ssg (greenfield static site generator CLI).

Checks (on a scratch copy, never the workspace):
  build_passed      `node --check bin/ssg.mjs` succeeds AND (`node bin/ssg.mjs --help` exits 0
                    OR building the hidden blog fixture exits 0)
  tests_passed      True (greenfield: there is no original suite)
  lint_passed       null (no linter in this toolchain)
  format_passed     null (no formatter in this toolchain)
  typecheck_passed  `tsc --noEmit -p .` when the agent wrote TypeScript and a tsconfig.json; else null
Agent tests: test files the agent added (`*.test.{js,mjs,cjs,ts}` or files under test/ or tests/),
run with `node --test` before the hidden files are added.
Hidden tests: black-box CLI checks in hidden/tests/*.test.mjs, run against the scratch repo through
SSG_REPO, TAP output, grouped by name prefix. Expected test names are read from the hidden files so a
crashing file counts all its tests as failed.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "runner"))
import evalkit  # noqa: E402

TASK = json.loads((HERE / "task.json").read_text())
TASK_ID = TASK["id"]
ENTRY = "bin/ssg.mjs"
HIDDEN_DIR_NAME = "_hidden_eval"

REQUIREMENT_GROUPS = {
    "cli_and_exit_codes": ["CLI:"],
    "front_matter_parsing": ["FM-PARSE:"],
    "front_matter_errors": ["FM-ERROR:"],
    "markdown_blocks": ["MD-HEADING:", "MD-PARAGRAPH:", "MD-LIST:", "MD-CRLF:"],
    "markdown_inline_and_escaping": ["MD-INLINE:", "MD-ESCAPE:"],
    "code_blocks": ["MD-CODE:"],
    "slugs": ["SLUG:"],
    "post_pages": ["POST:"],
    "layout_template": ["LAYOUT:"],
    "index_page": ["INDEX:"],
    "tag_pages": ["TAGS:"],
    "feed": ["FEED:"],
    "static_copy": ["STATIC:"],
    "drafts": ["DRAFTS:"],
    "determinism": ["DETERMINISM:"],
}

SRC_EXT = (".js", ".mjs", ".cjs", ".ts", ".mts", ".cts")
TEST_FILE = re.compile(r"(^|/)(tests?|__tests__)/|\.(test|spec)\.[cm]?[jt]s$")
SKIP_DIRS = {".git", "node_modules", HIDDEN_DIR_NAME, ".forge"}


def tsc_bin() -> str:
    return shutil.which("tsc") or "/home/linuxbrew/.linuxbrew/bin/tsc"


def expected_hidden_names(hidden_dir: Path) -> list[str]:
    names = []
    for f in sorted(hidden_dir.rglob("*.test.mjs")):
        names += re.findall(r'\btest\(\s*"([^"]+)"', f.read_text())
    return names


def all_files(repo: Path) -> list[str]:
    out = []
    for p in repo.rglob("*"):
        rel = p.relative_to(repo)
        if any(part in SKIP_DIRS for part in rel.parts) or not p.is_file():
            continue
        out.append(rel.as_posix())
    return sorted(out)


def source_files(repo: Path) -> list[str]:
    return [f for f in all_files(repo) if f.endswith(SRC_EXT) and not f.endswith(".d.ts") and not TEST_FILE.search(f)]


def test_files(repo: Path) -> list[str]:
    return [f for f in all_files(repo) if f.endswith(SRC_EXT) and not f.endswith(".d.ts") and TEST_FILE.search(f)]


IMPORT_RE = re.compile(
    r"""(?:\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?|\bexport\s+[\w*{}\s,$]+\s+from\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']"""
)


def builtin_modules(repo: Path) -> set[str]:
    rc, out = evalkit.sh(["node", "-p", "require('node:module').builtinModules.join('\\n')"], repo, timeout=60)
    return set(out.split()) if rc == 0 else set()


def architecture_checks(repo: Path) -> dict[str, bool]:
    srcs = source_files(repo)
    texts = {f: (repo / f).read_text(errors="replace") for f in srcs}
    builtins = builtin_modules(repo)

    def specifiers(text):
        return IMPORT_RE.findall(text)

    # 1. No runtime dependencies: nothing in package.json dependencies, only relative or built-in imports.
    deps_ok = True
    pkg = repo / "package.json"
    if pkg.exists():
        try:
            data = json.loads(pkg.read_text())
            deps_ok = not data.get("dependencies") and not data.get("peerDependencies") and not data.get("optionalDependencies")
        except ValueError:
            deps_ok = False
    bare = sorted({
        s for t in texts.values() for s in specifiers(t)
        if not (s.startswith(".") or s.startswith("/") or s.startswith("node:") or s.split("/")[0] in builtins)
    })
    no_deps = bool(srcs) and deps_ok and not bare and not (repo / "node_modules").exists()

    # 2. Markdown rendering is a pure module separate from file I/O, in a project of >= 3 modules.
    renderers = [f for f, t in texts.items() if re.search(r"\bstrong\b|<em\b|<pre\b", t)]
    io_re = re.compile(r"""["'](?:node:)?(fs|fs/promises|child_process)["']""")
    md_separated = len(srcs) >= 3 and bool(renderers) and all(not io_re.search(texts[f]) for f in renderers)

    # 3. An HTML escaping helper exists and is used where code blocks are rendered.
    all_text = "\n".join(texts.values())
    names = set(re.findall(
        r"(?:function\s+|(?:const|let|var)\s+)(\w*[eE]sc\w*)\s*(?:=|\(|:)", all_text
    )) | set(re.findall(r"^\s*(?:export\s+)?(?:static\s+)?(\w*[eE]sc\w*)\s*\([^)]*\)\s*(?::[^{]+)?\{", all_text, re.M))
    names = {n for n in names if len(n) >= 3}
    code_files = [t for t in texts.values() if "<pre" in t or "language-" in t]
    escape_used = any(
        len(re.findall(rf"\b{re.escape(n)}\b", all_text)) >= 2 and any(re.search(rf"\b{re.escape(n)}\b", t) for t in code_files)
        for n in names
    )

    # 4. No child_process (sync shell-outs) anywhere in the source.
    no_child = bool(srcs) and not any(re.search(r"child_process|\bexecSync\b|\bspawnSync\b", t) for t in texts.values())

    return {
        "no_runtime_dependencies": no_deps,
        "markdown_separated_from_io": md_separated,
        "html_escape_helper_used": escape_used,
        "no_child_process": no_child,
    }


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

    srcs = source_files(repo)
    details["source_files"] = srcs

    # Build: syntax check + --help (or the first hidden build) must succeed.
    entry = repo / ENTRY
    build_passed = False
    if entry.exists():
        rc, out = evalkit.sh(["node", "--check", ENTRY], repo, timeout=60)
        details["check_output"] = out[-1500:]
        if rc == 0:
            rc_h, out_h = evalkit.sh(["node", ENTRY, "--help"], repo, timeout=60)
            details["help_output"] = out_h[-1500:]
            if rc_h == 0:
                build_passed = True
            else:
                tmp_out = repo.parent / "probe-out"
                rc_b, out_b = evalkit.sh(["node", ENTRY, "build", str(HERE / "hidden" / "fixtures" / "blog"), str(tmp_out)],
                                         repo, timeout=120)
                details["probe_build_output"] = out_b[-1500:]
                build_passed = rc_b == 0
    else:
        details["check_output"] = f"{ENTRY} not found"

    # Typecheck only when the agent used TypeScript and configured it.
    typecheck_passed = None
    if any(f.endswith((".ts", ".mts", ".cts")) for f in srcs) and (repo / "tsconfig.json").exists():
        rc, out = evalkit.sh([tsc_bin(), "--noEmit", "-p", "."], repo, timeout=300)
        typecheck_passed = rc == 0
        details["typecheck_output"] = out[-3000:]

    # Agent-written tests (run before hidden files exist in the tree).
    agent_tests = test_files(repo)
    agent_tests_added = bool(agent_tests)
    agent_tests_pass = False
    if agent_tests_added:
        rc, out = evalkit.sh(["node", "--test", *agent_tests], repo, timeout=300)
        agent_tests_pass = rc == 0
        details["agent_tests_output"] = out[-2000:]
    details["agent_tests"] = agent_tests

    arch = architecture_checks(repo)

    # Hidden black-box tests.
    hidden_dir = HERE / "hidden"
    target = repo / HIDDEN_DIR_NAME
    evalkit.overlay(hidden_dir, target)
    hidden_files = sorted(str(p.relative_to(repo)) for p in target.rglob("*.test.mjs"))
    rc, out = evalkit.sh(["node", "--test", "--test-reporter=tap", "--test-concurrency=4", *hidden_files], repo,
                         timeout=300, env={"SSG_REPO": str(repo)})
    parsed = evalkit.node_tap(out)
    hidden_results = {name: parsed.get(name, False) for name in expected_hidden_names(hidden_dir)}
    details["hidden_failed"] = [n for n, ok in hidden_results.items() if not ok]
    details["hidden_output_tail"] = out[-4000:]

    scored = evalkit.score_coding(
        build_passed=build_passed,
        hidden_results=hidden_results,
        requirement_groups=REQUIREMENT_GROUPS,
        original_tests_passed=True,
        agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass,
        arch_checks=arch,
        unrelated=unrelated,
        fmt_ok=typecheck_passed is not False,
        diff_added=diff_added,
        diff_limit=100000,
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
