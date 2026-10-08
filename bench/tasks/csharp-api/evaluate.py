#!/usr/bin/env python3
"""Evaluator for csharp-api: greenfield .NET 8 minimal-API library-loans service (black-box HTTP contract)."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "runner"))
import evalkit  # noqa: E402

TASK = json.loads((HERE / "task.json").read_text())
CONTRACT = HERE / "hidden" / "contract.py"
APP_PROJ = "src/LibraryApi/LibraryApi.csproj"
APP_DIR = "src/LibraryApi"

REQUIREMENT_GROUPS = {
    "health_and_clock": ["test_health_"],
    "book_listing_filter_sort_paging": ["test_booklist_"],
    "query_validation": ["test_query_"],
    "get_by_id": ["test_get_"],
    "problem_details_format": ["test_problem_"],
    "api_key_authentication": ["test_auth_"],
    "book_creation": ["test_bookcreate_"],
    "body_validation": ["test_validation_"],
    "members": ["test_member_"],
    "book_deletion": ["test_bookdelete_"],
    "loan_creation": ["test_loancreate_"],
    "loan_rules": ["test_loanrules_"],
    "loan_return": ["test_return_"],
    "overdue_fines": ["test_fines_"],
    "loan_listing": ["test_loanlist_"],
    "configuration": ["test_config_"],
}

DOTNET_HOME = Path.home() / ".dotnet"
DOTNET_ENV = {
    "PATH": f"{DOTNET_HOME}{os.pathsep}{os.environ.get('PATH', '')}",
    "DOTNET_ROOT": str(DOTNET_HOME),
    "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
    "DOTNET_NOLOGO": "1",
    "DOTNET_SKIP_FIRST_TIME_EXPERIENCE": "1",
    "MSBUILDDISABLENODEREUSE": "1",
    "DOTNET_CLI_UI_LANGUAGE": "en",
    "UseSharedCompilation": "false",
}
NO_SERVERS = ["--disable-build-servers", "-nodeReuse:false"]
SKIP_DIRS = {"bin", "obj", ".git", ".vs", "TestResults", "node_modules"}
WARNING_RE = re.compile(r":\s+warning\s+[A-Z]+\d+", re.I)


def dotnet(args, cwd, timeout=300):
    return evalkit.sh(["dotnet", *args], cwd, timeout=timeout, env=DOTNET_ENV)


def walk(repo: Path, suffix: str):
    for p in repo.rglob(f"*{suffix}"):
        rel = p.relative_to(repo)
        if p.is_file() and not any(part in SKIP_DIRS for part in rel.parts[:-1]):
            yield p


def clean_build_dirs(repo: Path):
    for p in list(repo.rglob("*")):
        if p.is_dir() and p.name in ("bin", "obj") and ".git" not in p.parts:
            shutil.rmtree(p, ignore_errors=True)


def app_sources(repo: Path):
    root = repo / APP_DIR
    return [(str(p.relative_to(repo)), p.read_text(errors="replace")) for p in walk(root, ".cs")] if root.is_dir() else []


SYNC_RE = re.compile(r"\block\s*\(|\bConcurrent(Dictionary|Bag|Queue|Stack)\b|\bReaderWriterLock(Slim)?\b|"
                     r"\bSemaphoreSlim\b|\bMonitor\.Enter\b|\bInterlocked\.|\bImmutableInterlocked\b|"
                     r"\bSystem\.Threading\.Lock\b|\bnew\s+Lock\s*\(")
ROUTE_RE = re.compile(r"\.Map(Get|Post|Put|Delete|Patch|Methods)\s*\(")
SYSTIME_RE = re.compile(r"\bDateTime(Offset)?\s*\.\s*(Now|UtcNow|Today)\b")


def arch_checks(repo: Path) -> dict[str, bool]:
    src = app_sources(repo)
    proj = repo / APP_PROJ
    csproj = proj.read_text(errors="replace") if proj.is_file() else ""
    if not src:
        return {k: False for k in ("code_split_into_layers", "endpoints_separate_from_store", "store_is_thread_safe",
                                   "nullable_enabled", "clock_injected", "no_third_party_packages")}
    sync_files = {f for f, s in src if SYNC_RE.search(s)}
    route_files = {f for f, s in src if ROUTE_RE.search(s)}
    systime_files = [f for f, s in src if SYSTIME_RE.search(s)]
    folders = {str(Path(f).parent) for f, _ in src}
    return {
        # endpoints, domain rules and storage are not all in one file
        "code_split_into_layers": len(src) >= 3 or len(folders) >= 2,
        # the synchronised store lives outside the files that map the routes
        "endpoints_separate_from_store": bool(sync_files) and bool(route_files) and not (sync_files & route_files),
        # shared in-memory state is guarded (lock / Concurrent* / Interlocked ...)
        "store_is_thread_safe": bool(sync_files),
        # nullable reference types enabled in the app project
        "nullable_enabled": bool(re.search(r"<Nullable>\s*enable\s*</Nullable>", csproj, re.I)),
        # system time read in at most one place (the clock implementation), never next to the routes
        "clock_injected": len(systime_files) <= 1 and not (set(systime_files) & route_files),
        # app uses only the SDK and shared framework
        "no_third_party_packages": bool(csproj) and "<PackageReference" not in csproj,
    }


def test_projects(repo: Path):
    out = []
    for p in walk(repo, ".csproj"):
        text = p.read_text(errors="replace")
        if "Microsoft.NET.Test.Sdk" in text or re.search(r"<IsTestProject>\s*true", text, re.I):
            out.append(("vstest", p))
        elif p.relative_to(repo).parts[0] == "tests" and re.search(r"<OutputType>\s*Exe", text, re.I):
            out.append(("console", p))
    return out


TOTAL_RE = re.compile(r"Total(?: tests)?:\s*(\d+)")


def run_agent_tests(repo: Path, target: Path | None, details) -> tuple[bool, bool]:
    projects = test_projects(repo)
    details["agent_test_projects"] = [f"{k}:{p.relative_to(repo)}" for k, p in projects]
    if not projects:
        return False, False
    ok = True
    vstest = [p for k, p in projects if k == "vstest"]
    console = [p for k, p in projects if k == "console"]
    logs = []
    if vstest:
        targets = [target] if target is not None and target.suffix == ".sln" else vstest
        for t in targets:
            rc, out = dotnet(["test", str(t), *NO_SERVERS], repo, timeout=420)
            logs.append(out[-2500:])
            totals = [int(n) for n in TOTAL_RE.findall(out)]
            ok = ok and rc == 0 and sum(totals) > 0
    for p in console:
        rc, out = dotnet(["run", "--project", str(p)], repo, timeout=240)
        logs.append(out[-1500:])
        ok = ok and rc == 0
    details["agent_test_output"] = "\n---\n".join(logs)[-4000:]
    return True, ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    repo = evalkit.scratch_copy(a.workspace)
    changed = evalkit.changed_files(repo, a.base)
    unrelated = evalkit.unrelated_changes(changed, TASK["allowed_change_globs"])
    added, removed = evalkit.diff_size(repo, a.base)
    details = {"changed_files": changed, "unrelated": unrelated, "diff": [added, removed]}
    clean_build_dirs(repo)

    app = repo / APP_PROJ
    sln = repo / "LibraryApi.sln"
    target = sln if sln.is_file() else (app if app.is_file() else None)
    details["build_target"] = str(target.relative_to(repo)) if target else None

    build_ok = lint_ok = False
    fmt_ok = None
    if target is not None and app.is_file():
        rc, out = dotnet(["build", str(target), *NO_SERVERS], repo, timeout=420)
        build_ok = rc == 0
        details["build_output"] = out[-3000:]
        if build_ok:
            rc_l, lout = dotnet(["build", str(target), "--no-restore", "--no-incremental", "-warnaserror",
                                 *NO_SERVERS], repo, timeout=420)
            lint_ok = rc_l == 0 and not WARNING_RE.search(out)
            details["lint_output"] = lout[-3000:]
            rc_f, fout = dotnet(["format", str(target), "--verify-no-changes", "--no-restore"], repo, timeout=150)
            fmt_ok = None if rc_f == 124 else rc_f == 0
            details["format_output"] = fout[-3000:]

    work = Path(tempfile.mkdtemp(prefix="csharp-api-eval-"))
    dll = work / "out" / "LibraryApi.dll"
    publish_ok = False
    if build_ok:
        rc, out = dotnet(["publish", str(app), "-c", "Release", "-o", str(work / "out"), *NO_SERVERS], repo, timeout=420)
        publish_ok = rc == 0 and dll.is_file()
        details["publish_output"] = out[-3000:]

    agent_tests_added, agent_tests_pass = (False, False)
    if build_ok:
        agent_tests_added, agent_tests_pass = run_agent_tests(repo, target, details)
    else:
        agent_tests_added = bool(test_projects(repo))

    arch = arch_checks(repo)

    # Hidden black-box contract tests against the published app.
    names = re.findall(r"^def (test_\w+)\(", CONTRACT.read_text(), re.M)
    hidden = {n: False for n in names}
    if publish_ok:
        res_file = work / "hidden.json"
        rc, hout = evalkit.sh([sys.executable, "-I", str(CONTRACT), "--dll", str(dll), "--out", str(res_file)],
                              work, timeout=600, env=DOTNET_ENV)
        res = json.loads(res_file.read_text()) if res_file.is_file() else {}
        for n in names:
            hidden[n] = bool(res.get(n, False))
        details["hidden_output"] = hout[-4000:]
    shutil.rmtree(work, ignore_errors=True)

    scored = evalkit.score_coding(
        build_passed=publish_ok, hidden_results=hidden, requirement_groups=REQUIREMENT_GROUPS,
        original_tests_passed=True, agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass, arch_checks=arch, unrelated=unrelated,
        fmt_ok=lint_ok and fmt_ok is not False, diff_added=added, diff_limit=1_000_000,
        rubric=TASK["rubric"])
    details["arch_checks"] = arch
    details["hidden_results"] = hidden
    checks = {"build_passed": build_ok, "tests_passed": True,  # no original suite in a greenfield repo
              "lint_passed": lint_ok, "format_passed": fmt_ok, "typecheck_passed": None}
    evalkit.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
