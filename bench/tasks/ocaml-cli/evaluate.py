#!/usr/bin/env python3
"""Evaluator for ocaml-cli: the asm assembler / disassembler / stack VM built from scratch with dune."""
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
HIDDEN_SCRIPT = HERE / "hidden" / "test_asm.py"
GROUPS = {
    "encoding": ["asm_"],
    "assembler_errors": ["err_"],
    "execution": ["run_"],
    "traps": ["trap_"],
    "binary_loading": ["bin_"],
    "disassembler": ["dis_"],
    "command_line": ["cli_"],
}
TOOL_PATH = os.pathsep.join([
    "/home/linuxbrew/.linuxbrew/bin", str(Path.home() / ".cargo/bin"), str(Path.home() / ".local/bin"),
    "/usr/local/bin", "/usr/bin", "/bin"])
# Byte-level encoding/decoding primitives of the binary format.
CODEC = re.compile(r"\b(?:u?int(?:8|16|32|64)_(?:le|be|ne)|[gs]et_u?int8|add_u?int8|input_byte|output_byte"
                   r"|input_binary_int|output_binary_int)\b")
SKIP_DIRS = {"_build", "_opam", ".git"}


def strip_comments(text):
    # OCaml comments nest; strings inside are rare enough to ignore here.
    out, depth, i = [], 0, 0
    while i < len(text):
        if text.startswith("(*", i):
            depth += 1; i += 2
        elif depth and text.startswith("*)", i):
            depth -= 1; i += 2
        else:
            if not depth:
                out.append(text[i])
            i += 1
    return re.sub(r'"(?:\\.|[^"\\])*"', '""', "".join(out))


def project_files(repo, suffixes):
    res = {}
    for p in sorted(repo.rglob("*")):
        rel = p.relative_to(repo)
        if p.is_file() and p.suffix in suffixes and not (set(rel.parts[:-1]) & SKIP_DIRS):
            res[str(rel)] = p.read_text(errors="replace")
    return res


def is_test(rel):
    return any("test" in part.lower() for part in Path(rel).parts[:-1]) or "test" in Path(rel).stem.lower()


def arch_checks(repo):
    dunes = {k: re.sub(r";[^\n]*", "", v) for k, v in project_files(repo, {""}).items() if Path(k).name == "dune"}
    lib_dirs = {str(Path(k).parent) for k, v in dunes.items() if re.search(r"\(library\b", v)}
    exe_dirs = {str(Path(k).parent) for k, v in dunes.items() if re.search(r"\(executables?\b", v)}
    srcs = {k: v for k, v in project_files(repo, {".ml"}).items() if not is_test(k)}
    mlis = [k for k in project_files(repo, {".mli"}) if not is_test(k) and str(Path(k).parent) in lib_dirs]
    code = {k: strip_comments(v) for k, v in srcs.items()}
    sizes = {k: len([l for l in v.splitlines() if l.strip()]) for k, v in code.items()}
    total = sum(sizes.values()) or 1
    lib = [k for k in srcs if str(Path(k).parent) in lib_dirs]
    exe_lines = sum(sizes[k] for k in srcs if str(Path(k).parent) in exe_dirs - lib_dirs)
    codec = [k for k, v in code.items() if CODEC.search(v)]
    return {
        "library_split_into_modules": len(lib) >= 3 and max(sizes[k] for k in lib) <= 0.6 * total,
        "interfaces_present": len(mlis) >= 2,
        "thin_executable": bool(lib) and exe_lines <= 0.4 * total,
        "single_codec_module": len(codec) == 1,
        "no_obj_magic": bool(srcs) and not any(re.search(r"\bObj\.magic\b", v) for v in code.values()),
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

    home = Path(tempfile.mkdtemp(prefix="tfbench-dune-"))
    env = {"PATH": TOOL_PATH, "HOME": str(home), "XDG_CACHE_HOME": str(home / "cache"),
           "DUNE_CACHE": "disabled", "NO_COLOR": "1"}
    dune = shutil.which("dune", path=TOOL_PATH) or "dune"
    shutil.rmtree(repo / "_build", ignore_errors=True)
    binary = repo / "_build" / "default" / "bin" / "asm.exe"

    build_out, build_passed = "", False
    if (repo / "dune-project").is_file():
        rc, build_out = ek.sh([dune, "build", "--display", "short"], repo, timeout=600, env=env)
        build_passed = rc == 0 and binary.is_file()
    else:
        build_out = "no dune-project"

    dune_text = "\n".join(re.sub(r";[^\n]*", "", v) for k, v in project_files(repo, {""}).items()
                          if Path(k).name in ("dune", "dune-project"))
    # Turning warnings off (or switching profiles) would hide them from the dev-profile build.
    warnings_disabled = bool(re.search(r"(?<![\w-])-w(?![\w-])|\(profile\b", dune_text))
    warnings = re.findall(r"^(?:Warning|Alert|Error \(warning).*$", build_out, flags=re.M)
    lint_passed = build_passed and not warnings and not warnings_disabled

    # Agent tests: a dune test stanza run with `dune test`.
    agent_tests_added = bool(re.search(r"\(tests?\b", dune_text))
    agent_tests_pass = False
    test_out = ""
    if build_passed and agent_tests_added:
        rc, test_out = ek.sh([dune, "test", "--force"], repo, timeout=600, env=env)
        agent_tests_pass = rc == 0

    hidden, hidden_out = {}, ""
    if build_passed:
        _, hidden_out = ek.sh([sys.executable, "-I", str(HIDDEN_SCRIPT), str(binary)], repo,
                              timeout=600, env={"PATH": TOOL_PATH})
        for m in re.finditer(r"^(PASS|FAIL) (\w+)", hidden_out, flags=re.M):
            hidden[m.group(2)] = m.group(1) == "PASS"
    hidden = {n: hidden.get(n, False) for n in hidden_names()}

    arch = arch_checks(repo)

    scored = ek.score_coding(
        build_passed=build_passed, hidden_results=hidden, requirement_groups=GROUPS,
        original_tests_passed=True, agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass, arch_checks=arch, unrelated=unrelated,
        fmt_ok=lint_passed, diff_added=diff_added, diff_limit=10 ** 9, rubric=TASK["rubric"])
    checks = {"build_passed": build_passed, "tests_passed": True, "lint_passed": lint_passed,
              "format_passed": None, "typecheck_passed": None}
    details = {"changed_files": files, "unrelated": unrelated, "diff": [diff_added, diff_removed],
               "agent_tests_added": agent_tests_added, "agent_tests_pass": agent_tests_pass,
               "arch_checks": arch, "hidden": hidden, "warnings": warnings[:20],
               "warnings_disabled": warnings_disabled,
               "hidden_failures": [l for l in hidden_out.splitlines() if l.startswith("FAIL")][:30],
               "test_output": test_out[-2000:] if agent_tests_added and not agent_tests_pass else "",
               "build_output": build_out[-2000:] if not build_passed else ""}
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)
    shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    main()
