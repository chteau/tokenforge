#!/usr/bin/env python3
"""Evaluator for ts-lib (greenfield: typed schema validation library "Ward").

Checks (on a scratch copy, never the workspace):
  typecheck_passed  `tsc --noEmit -p .` with the agent's own tsconfig.json
  build_passed      typecheck passes AND `src/index.ts` imports under Node type stripping
  tests_passed      True (greenfield: there is no original suite)
  lint_passed       null (no linter in this toolchain)
  format_passed     null (no formatter in this toolchain); fmt_ok for scoring = typecheck_passed
Hidden tests:
  __hidden__/*.test.ts      runtime behaviour via `node --test` (TAP), grouped by name prefix
  __hidden__/types/*.ts     type-level cases compiled with tsc (strict); one result per file,
                            named "TYPES: <file stem>", passing when tsc reports no error in it
Expected test names are read from the hidden files so a crashing file counts all its tests as failed.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "runner"))
import evalkit  # noqa: E402

TASK = json.loads((HERE / "task.json").read_text())
TASK_ID = TASK["id"]
HIDDEN_DIR = "__hidden__"

REQUIREMENT_GROUPS = {
    "primitive_types_and_messages": ["PRIM:"],
    "string_checks": ["STRING:"],
    "number_checks": ["NUMBER:"],
    "literal_and_enum": ["LITERAL-ENUM:"],
    "objects": ["OBJECT:"],
    "arrays": ["ARRAY:"],
    "unions": ["UNION:"],
    "modifiers_and_immutability": ["MODIFIERS:"],
    "errors_and_safe_parse": ["ERRORS:"],
    "static_types": ["TYPES:"],
}

IMPORT_CHECK = r"""
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const m = await import(pathToFileURL(join(process.argv[2], "src", "index.ts")).href);
const missing = ["s", "ValidationError", "formatPath"].filter((k) => !(k in m));
if (missing.length) { console.error("missing exports: " + missing.join(", ")); process.exit(1); }
console.log("import ok");
"""

TSC_ERROR = re.compile(r"^(?P<file>[^\s(][^(]*)\((?P<line>\d+),(?P<col>\d+)\): error", re.M)


def tsc_bin() -> str:
    return shutil.which("tsc") or "/home/linuxbrew/.linuxbrew/bin/tsc"


def expected_hidden_names(hidden_dir: Path) -> list[str]:
    names = []
    for f in sorted(hidden_dir.rglob("*.test.ts")):
        names += re.findall(r'\btest\(\s*"([^"]+)"', f.read_text())
    return names


def strip_jsonc(text: str) -> str:
    """Remove // and /* */ comments (outside strings) and trailing commas."""
    out, i, n, in_str = [], 0, len(text), False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1]); i += 2; continue
            if c == '"':
                in_str = False
            i += 1
        elif c == '"':
            in_str = True; out.append(c); i += 1
        elif text.startswith("//", i):
            j = text.find("\n", i); i = n if j < 0 else j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2); i = n if j < 0 else j + 2
        else:
            out.append(c); i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


def load_jsonc(path: Path):
    try:
        return json.loads(strip_jsonc(path.read_text()))
    except (OSError, ValueError):
        return None


def is_test_file(p: str) -> bool:
    return bool(re.search(r"\.test\.(ts|mts|js|mjs)$", p))


def no_any_in_public_api(repo: Path, details: dict) -> bool:
    """Emit declarations for src/index.ts and look for `any` in them (comments stripped)."""
    if not (repo / "src" / "index.ts").exists():
        return False
    out_dir = Path(tempfile.mkdtemp(prefix="tfbench-dts-"))
    cfg = repo / ".eval-dts.tsconfig.json"
    cfg.write_text(json.dumps({
        "compilerOptions": {
            "target": "es2024", "lib": ["es2024"], "module": "esnext", "moduleResolution": "bundler",
            "allowImportingTsExtensions": True, "strict": True, "skipLibCheck": True, "types": [],
            "declaration": True, "emitDeclarationOnly": True, "noEmit": False,
            "rootDir": ".", "outDir": str(out_dir),
        },
        "files": ["src/index.ts"],
    }))
    evalkit.sh([tsc_bin(), "-p", str(cfg), "--pretty", "false"], repo, timeout=120)
    cfg.unlink(missing_ok=True)
    dts = list(out_dir.rglob("*.d.ts"))
    hits = []
    for f in dts:
        text = re.sub(r"/\*.*?\*/", "", f.read_text(), flags=re.S)
        text = re.sub(r"//[^\n]*", "", text)
        for line in text.splitlines():
            if re.search(r"\bany\b", line):
                hits.append(f"{f.relative_to(out_dir)}: {line.strip()}")
    details["dts_any_hits"] = hits[:20]
    shutil.rmtree(out_dir, ignore_errors=True)
    return bool(dts) and not hits


def architecture_checks(repo: Path, details: dict) -> dict[str, bool]:
    pkg = load_jsonc(repo / "package.json")
    no_deps = isinstance(pkg, dict) and not pkg.get("dependencies")
    src_files = [
        p for p in (repo / "src").rglob("*.ts")
        if not p.name.endswith(".d.ts") and not is_test_file(p.name) and "node_modules" not in p.parts
    ] if (repo / "src").is_dir() else []
    tsconfig = load_jsonc(repo / "tsconfig.json")
    strict = isinstance(tsconfig, dict) and (tsconfig.get("compilerOptions") or {}).get("strict") is True
    details["src_files"] = sorted(str(p.relative_to(repo)) for p in src_files)
    return {
        "no_runtime_dependencies": no_deps,
        "split_into_modules": len(src_files) >= 3,
        "strict_tsconfig": strict,
        "no_any_in_public_api": no_any_in_public_api(repo, details),
    }


def type_cases(repo: Path, details: dict) -> dict[str, bool]:
    cfg = repo / HIDDEN_DIR / "tsconfig.types.json"
    files = json.loads(cfg.read_text())["files"]
    rc, out = evalkit.sh([tsc_bin(), "-p", str(cfg), "--pretty", "false"], repo, timeout=120)
    details["types_output"] = out[-3000:]
    errored = {Path(m.group("file").strip()).as_posix() for m in TSC_ERROR.finditer(out)}
    # tsc failed without attributing errors to any file (config/crash): nothing passes.
    broken = rc != 0 and not errored
    results = {}
    for f in files:
        rel = f"{HIDDEN_DIR}/{f}"
        bad = broken or any(e.endswith(rel) for e in errored)
        results[f"TYPES: {Path(f).stem}"] = not bad
    return results


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

    if (repo / "tsconfig.json").exists():
        rc, out = evalkit.sh([tsc_bin(), "--noEmit", "-p", ".", "--pretty", "false"], repo, timeout=300)
        typecheck_passed = rc == 0
        details["typecheck_output"] = out[-3000:]
    else:
        typecheck_passed = False
        details["typecheck_output"] = "tsconfig.json missing"

    tmp = Path(tempfile.mkdtemp(prefix="tfbench-imp-"))
    (tmp / "import-index.mjs").write_text(IMPORT_CHECK)
    rc, out = evalkit.sh(["node", str(tmp / "import-index.mjs"), str(repo)], repo, timeout=60)
    imports_ok = rc == 0
    details["import_check"] = out[-2000:]
    build_passed = typecheck_passed and imports_ok

    agent_tests = [
        f for f in changed
        if is_test_file(f) and not f.startswith(HIDDEN_DIR + "/") and "node_modules/" not in f and (repo / f).exists()
    ]
    agent_tests_added = bool(agent_tests)
    agent_tests_pass = False
    if agent_tests_added:
        rc, out = evalkit.sh(["node", "--test", *agent_tests], repo, timeout=300)
        agent_tests_pass = rc == 0
        details["agent_tests_output"] = out[-2000:]
    details["agent_tests"] = agent_tests

    arch = architecture_checks(repo, details)

    hidden_dir = HERE / "hidden"
    shutil.rmtree(repo / HIDDEN_DIR, ignore_errors=True)
    evalkit.overlay(hidden_dir, repo)
    hidden_files = sorted(str(p.relative_to(hidden_dir)) for p in hidden_dir.rglob("*.test.ts"))
    rc, out = evalkit.sh(["node", "--test", "--test-reporter=tap", *hidden_files], repo, timeout=300)
    parsed = evalkit.node_tap(out)
    hidden_results = {name: parsed.get(name, False) for name in expected_hidden_names(hidden_dir)}
    details["hidden_output_tail"] = out[-4000:]
    hidden_results.update(type_cases(repo, details))
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
        diff_limit=10**9,
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
        "imports_ok": imports_ok,
    })
    evalkit.write_result(args.out, TASK_ID, checks, scored, details)
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
