#!/usr/bin/env python3
"""Evaluator for fsharp-cli: the greenfield `tally` expense splitter in F# (.NET 8, offline restore)."""
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
import evalkit as ek  # noqa: E402

TASK = json.loads((HERE / "task.json").read_text())
HIDDEN_SCRIPT = HERE / "hidden" / "test_tally.py"
APP_PROJ = "src/Tally/Tally.fsproj"
APP_DIR = "src/Tally"
GROUPS = {
    "command_line": ["cli_"],
    "groups_members": ["group_"],
    "expenses": ["expense_"],
    "splitting": ["split_"],
    "currencies": ["fx_"],
    "balances": ["balance_"],
    "settle_up": ["settle_"],
    "persistence": ["persist_"],
}

HOME = Path.home()
DOTNET_HOME = HOME / ".dotnet"
SANDBOX_PATH = [str(HOME / ".dotnet"), "/home/linuxbrew/.linuxbrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
NUGET_CACHE = HOME / ".nuget" / "packages"
# Offline restore: only the local package cache and the SDK's bundled FSharp.Core feed; any
# attempt to reach the network goes to a dead proxy and fails fast.
LIBRARY_PACKS = sorted(DOTNET_HOME.glob("sdk/8.*/FSharp/library-packs"))
RESTORE_SOURCES = ";".join([str(NUGET_CACHE), *map(str, LIBRARY_PACKS)])
DOTNET_ENV = {
    "PATH": os.pathsep.join(SANDBOX_PATH + [os.environ.get("PATH", "")]),
    "DOTNET_ROOT": str(DOTNET_HOME),
    "NUGET_PACKAGES": str(NUGET_CACHE),
    "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
    "DOTNET_NOLOGO": "1",
    "DOTNET_SKIP_FIRST_TIME_EXPERIENCE": "1",
    "MSBUILDDISABLENODEREUSE": "1",
    "DOTNET_CLI_UI_LANGUAGE": "en",
    "UseSharedCompilation": "false",
    "HTTP_PROXY": "http://127.0.0.1:9",
    "HTTPS_PROXY": "http://127.0.0.1:9",
    "NO_PROXY": "",
}
OFFLINE = ["-p:NuGetAudit=false", f"-p:RestoreSources={RESTORE_SOURCES.replace(';', '%3B')}"]
NO_SERVERS = ["--disable-build-servers", "-nodeReuse:false"]
SKIP_DIRS = {"bin", "obj", ".git", ".vs", "out", "node_modules"}
WARNING_RE = re.compile(r":\s+warning\s+[A-Z]+\d+", re.I)
IO_RE = re.compile(r"\bFile\.|\bDirectory\.|\bConsole\.|\bstdout\b|\bstderr\b|\bStreamWriter\b|\bStreamReader\b"
                   r"|\be?printfn?\b")
FLOAT_RE = re.compile(r"\bfloat\b|\bfloat32\b|\bdouble\b|\bsingle\b|\bSystem\.Double\b|\bSystem\.Single\b")


def dotnet_bin() -> str:
    return shutil.which("dotnet", path=DOTNET_ENV["PATH"]) or "dotnet"


def dotnet(args, cwd, timeout=300):
    return ek.sh([dotnet_bin(), *args], cwd, timeout=timeout, env=DOTNET_ENV)


def walk(root: Path, suffix: str):
    if not root.is_dir():
        return
    for p in sorted(root.rglob(f"*{suffix}")):
        rel = p.relative_to(root)
        if p.is_file() and not any(part in SKIP_DIRS for part in rel.parts[:-1]):
            yield p


def clean_build_dirs(repo: Path):
    for p in list(repo.rglob("*")):
        if p.is_dir() and p.name in ("bin", "obj") and ".git" not in p.parts:
            shutil.rmtree(p, ignore_errors=True)


def strip_comments(text: str) -> str:
    text = re.sub(r"\(\*.*?\*\)", " ", text, flags=re.S)
    text = re.sub(r"//[^\n]*", "", text)
    text = re.sub(r'"""(.*?)"""', '""', text, flags=re.S)
    return re.sub(r'"(?:\\.|[^"\\\n])*"', '""', text)


def arch_checks(repo: Path) -> dict[str, bool]:
    srcs = {str(p.relative_to(repo)): strip_comments(p.read_text(errors="replace")) for p in walk(repo / APP_DIR, ".fs")}
    proj = repo / APP_PROJ
    fsproj = proj.read_text(errors="replace") if proj.is_file() else ""
    if not srcs:
        return {k: False for k in ("split_into_modules", "logic_free_of_io", "money_not_float",
                                   "mostly_immutable", "no_third_party_packages", "readme_updated")}
    lines = {k: len([l for l in v.splitlines() if l.strip()]) for k, v in srcs.items()}
    total = sum(lines.values()) or 1
    io_files = {k for k, v in srcs.items() if IO_RE.search(v)}
    packages = re.findall(r'<PackageReference\s+Include="([^"]+)"', fsproj)
    readme = (repo / "README.md").read_text(errors="replace") if (repo / "README.md").is_file() else ""
    return {
        # several modules, none holding most of the code
        "split_into_modules": len(srcs) >= 3 and max(lines.values()) <= 0.6 * total,
        # I/O confined to a few files; at least two modules (domain logic) do no I/O
        "logic_free_of_io": len(io_files) <= 2 and len(srcs) - len(io_files) >= 2,
        # money is never floating point
        "money_not_float": not any(FLOAT_RE.search(v) for v in srcs.values()),
        # idiomatic F#: little mutable state
        "mostly_immutable": sum(len(re.findall(r"\bmutable\b", v)) for v in srcs.values()) <= 3,
        "no_third_party_packages": bool(fsproj) and all(p == "FSharp.Core" for p in packages),
        "readme_updated": len(readme.strip().splitlines()) > 1 and "dotnet" in readme,
    }


def test_projects(repo: Path):
    return [p for p in walk(repo / "tests", ".fsproj")
            if re.search(r"<OutputType>\s*Exe", p.read_text(errors="replace"), re.I)]


def hidden_names():
    return re.findall(r"@test\s*\ndef\s+(\w+)", HIDDEN_SCRIPT.read_text())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    repo = ek.scratch_copy(a.workspace)
    files = ek.changed_files(repo, a.base)
    diff_added, diff_removed = ek.diff_size(repo, a.base)
    unrelated = ek.unrelated_changes(files, TASK["allowed_change_globs"])
    details = {"changed_files": files, "unrelated": unrelated, "diff": [diff_added, diff_removed]}
    clean_build_dirs(repo)

    work = Path(tempfile.mkdtemp(prefix="fsharp-cli-eval-"))
    dll = work / "out" / "tally.dll"
    app = repo / APP_PROJ
    build_ok = lint_ok = False
    warnings: list[str] = []
    if app.is_file():
        rc, out = dotnet(["publish", str(app), "-c", "Release", "-o", str(work / "out"), *OFFLINE, *NO_SERVERS],
                         repo, timeout=600)
        build_ok = rc == 0 and dll.is_file()
        warnings = sorted(set(l.strip() for l in out.splitlines() if WARNING_RE.search(l)))
        lint_ok = build_ok and not warnings
        details["build_output"] = out[-3000:] if not build_ok else ""
    else:
        details["build_output"] = f"missing {APP_PROJ}"

    # Agent's own test console project(s): must exit 0.
    projects = test_projects(repo)
    details["agent_test_projects"] = [str(p.relative_to(repo)) for p in projects]
    agent_tests_added = bool(projects)
    agent_tests_pass = False
    if build_ok and projects:
        agent_tests_pass = True
        logs = []
        for p in projects:
            rc, out = dotnet(["run", "--project", str(p), *OFFLINE], repo, timeout=600)
            logs.append(out[-1500:])
            agent_tests_pass = agent_tests_pass and rc == 0
        details["agent_test_output"] = "\n---\n".join(logs)[-4000:]

    names = hidden_names()
    hidden = {n: False for n in names}
    hidden_out = ""
    if build_ok:
        _, hidden_out = ek.sh([sys.executable, "-I", str(HIDDEN_SCRIPT), str(dll)], work, timeout=900,
                              env=DOTNET_ENV)
        for m in re.finditer(r"^(PASS|FAIL) (\w+)", hidden_out, flags=re.M):
            if m.group(2) in hidden:
                hidden[m.group(2)] = m.group(1) == "PASS"
    shutil.rmtree(work, ignore_errors=True)

    arch = arch_checks(repo)
    scored = ek.score_coding(
        build_passed=build_ok, hidden_results=hidden, requirement_groups=GROUPS,
        original_tests_passed=True, agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass, arch_checks=arch, unrelated=unrelated,
        fmt_ok=lint_ok, diff_added=diff_added, diff_limit=10 ** 9, rubric=TASK["rubric"])
    checks = {"build_passed": build_ok, "tests_passed": True,  # no original suite in a greenfield repo
              "lint_passed": lint_ok, "format_passed": None, "typecheck_passed": None}
    details.update({"agent_tests_added": agent_tests_added, "agent_tests_pass": agent_tests_pass,
                    "arch_checks": arch, "hidden": hidden, "warnings": warnings[:20],
                    "hidden_failures": [l for l in hidden_out.splitlines() if l.startswith("FAIL")][:30]})
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
