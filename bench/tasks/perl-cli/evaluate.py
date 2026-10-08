#!/usr/bin/env python3
"""Evaluator for perl-cli: the greenfield `cfgmerge` INI/.env linter and merger (Perl 5, core modules only)."""
from __future__ import annotations

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
HIDDEN_SCRIPT = HERE / "hidden" / "test_cfgmerge.py"
GROUPS = {
    "command_line": ["cli_"],
    "lint": ["lint_"],
    "value_parsing": ["parse_"],
    "merging": ["merge_"],
    "references": ["interp_"],
    "schema": ["schema_"],
    "explain": ["explain_"],
    "diff_and_get": ["diff_", "get_"],
}
SANDBOX_PATH = os.pathsep.join(["/usr/bin", "/bin", "/home/linuxbrew/.linuxbrew/bin", "/usr/local/bin"])
# The task targets the system Perl; brew's newer perl may shadow it on PATH.
PERL = "/usr/bin/perl" if os.access("/usr/bin/perl", os.X_OK) else (shutil.which("perl", path=SANDBOX_PATH) or "perl")
PROVE = str(Path(PERL).with_name("prove")) if Path(PERL).with_name("prove").is_file() else (
    shutil.which("prove", path=SANDBOX_PATH) or "prove")
ENV = {"PATH": f"{Path(PERL).parent}{os.pathsep}{SANDBOX_PATH}", "PERL5LIB": "", "PERL5OPT": "",
       "LC_ALL": "C.UTF-8", "HARNESS_OPTIONS": ""}
STRICT_RE = re.compile(r"^\s*use\s+strict\b", re.M)
WARN_RE = re.compile(r"^\s*use\s+warnings\b", re.M)
MODERN_RE = re.compile(r"^\s*use\s+v?5\.?(?:0?3[6-9]|0?[4-9]\d)\b", re.M)  # use v5.36+ implies both
USE_RE = re.compile(r"^\s*(?:use|require)\s+([A-Z][\w:]*)", re.M)


def strip_pod_comments(text: str) -> str:
    text = re.sub(r"^=[a-zA-Z].*?(?:^=cut\b.*?$|\Z)", "", text, flags=re.S | re.M)
    text = re.sub(r"^__(?:END|DATA)__\b.*", "", text, flags=re.S | re.M)
    return "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))


def perl_files(repo: Path) -> dict[str, str]:
    """Program script + modules under lib/ (not tests)."""
    out = {}
    script = repo / "bin" / "cfgmerge"
    if script.is_file():
        out["bin/cfgmerge"] = script.read_text(errors="replace")
    lib = repo / "lib"
    if lib.is_dir():
        for p in sorted(lib.rglob("*.pm")):
            out[str(p.relative_to(repo))] = p.read_text(errors="replace")
    return out


def core_modules(names: set[str]) -> dict[str, bool]:
    if not names:
        return {}
    code = ("use Module::CoreList; for (@ARGV) { print $_, ' ', "
            "(Module::CoreList::is_core($_, undef, $]) ? 1 : 0), \"\\n\" }")
    _, out = ek.sh([PERL, "-e", code, *sorted(names)], HERE, timeout=60, env=ENV)
    res = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] in "01":
            res[parts[0]] = parts[1] == "1"
    return {n: res.get(n, False) for n in names}


def arch_checks(repo: Path) -> dict[str, bool]:
    files = perl_files(repo)
    modules = {k: v for k, v in files.items() if k.endswith(".pm")}
    if not modules or "bin/cfgmerge" not in files:
        return {k: False for k in ("split_into_modules", "thin_script", "strict_and_warnings",
                                   "core_modules_only", "readme_updated")}
    code = {k: strip_pod_comments(v) for k, v in files.items()}
    lines = {k: len([l for l in v.splitlines() if l.strip()]) for k, v in code.items()}
    total = sum(lines.values()) or 1
    own = {k[len("lib/"):-len(".pm")].replace("/", "::") for k in modules}
    used = {m for v in code.values() for m in USE_RE.findall(v)} - own
    core = core_modules(used)
    readme = (repo / "README.md").read_text(errors="replace") if (repo / "README.md").is_file() else ""
    return {
        # logic split across several modules, none holding most of the code
        "split_into_modules": len(modules) >= 3 and max(lines[k] for k in modules) <= 0.6 * total,
        # the script only wires modules together
        "thin_script": lines["bin/cfgmerge"] <= 30,
        "strict_and_warnings": all((STRICT_RE.search(v) and WARN_RE.search(v)) or MODERN_RE.search(v)
                                   for v in code.values()),
        # nothing from CPAN
        "core_modules_only": all(core.values()),
        "readme_updated": len(readme.strip().splitlines()) > 1 and "cfgmerge" in readme.split("\n", 1)[-1],
    }


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
    details = {"changed_files": files, "unrelated": unrelated, "diff": [diff_added, diff_removed],
               "perl": PERL, "prove": PROVE}

    # "Build": every program file must compile; `perl -wc` must print nothing but "syntax OK".
    script = repo / "bin" / "cfgmerge"
    build_ok = lint_ok = False
    compile_log = []
    if script.is_file():
        build_ok = lint_ok = True
        for rel in perl_files(repo):
            rc, out = ek.sh([PERL, "-Ilib", "-wc", rel], repo, timeout=60, env=ENV)
            noise = [l for l in out.splitlines() if l.strip() and not l.endswith("syntax OK")]
            build_ok = build_ok and rc == 0
            lint_ok = lint_ok and rc == 0 and not noise
            if rc != 0 or noise:
                compile_log.append(out[-800:])
    else:
        compile_log.append("missing bin/cfgmerge")
    details["compile_output"] = "\n".join(compile_log)[-3000:]

    # Agent's Test::More suite.
    test_files = sorted((repo / "t").glob("*.t")) if (repo / "t").is_dir() else []
    agent_tests_added = bool(test_files)
    agent_tests_pass = False
    if build_ok and test_files:
        rc, out = ek.sh([PROVE, "-l", "t"], repo, timeout=300, env=ENV)
        agent_tests_pass = rc == 0
        details["agent_test_output"] = out[-3000:]

    names = hidden_names()
    hidden = {n: False for n in names}
    hidden_out = ""
    if build_ok:
        _, hidden_out = ek.sh([sys.executable, "-I", str(HIDDEN_SCRIPT), PERL, str(script)], repo,
                              timeout=600, env=ENV)
        for m in re.finditer(r"^(PASS|FAIL) (\w+)", hidden_out, flags=re.M):
            if m.group(2) in hidden:
                hidden[m.group(2)] = m.group(1) == "PASS"

    arch = arch_checks(repo)
    scored = ek.score_coding(
        build_passed=build_ok, hidden_results=hidden, requirement_groups=GROUPS,
        original_tests_passed=True, agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass, arch_checks=arch, unrelated=unrelated,
        fmt_ok=lint_ok, diff_added=diff_added, diff_limit=10 ** 9, rubric=TASK["rubric"])
    checks = {"build_passed": build_ok, "tests_passed": True,  # no original suite in a greenfield repo
              "lint_passed": lint_ok, "format_passed": None, "typecheck_passed": None}
    details.update({"agent_tests_added": agent_tests_added, "agent_tests_pass": agent_tests_pass,
                    "arch_checks": arch, "hidden": hidden,
                    "hidden_failures": [l for l in hidden_out.splitlines() if l.startswith("FAIL")][:30]})
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
