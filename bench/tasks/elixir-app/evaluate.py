#!/usr/bin/env python3
"""Evaluator for elixir-app: the jobq job queue (OTP application + escript) built from scratch."""
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
HIDDEN_SCRIPT = HERE / "hidden" / "test_jobq.py"
GROUPS = {
    "add": ["add_"],
    "take_order": ["take_"],
    "retries": ["retry_"],
    "leases": ["lease_"],
    "persistence": ["persist_"],
    "list_show": ["query_"],
    "stats": ["stats_"],
    "command_line": ["cli_"],
}
TOOL_PATH = os.pathsep.join([
    "/home/linuxbrew/.linuxbrew/bin", str(Path.home() / ".cargo/bin"), str(Path.home() / ".local/bin"),
    "/usr/local/bin", "/usr/bin", "/bin"])
FILE_WRITES = re.compile(r"\bFile\.(?:write|write!|rename|rename!|open|open!|stream!)\b|:file\.(?:write|rename|open)\b")
DEP_TUPLE = re.compile(r"\{\s*:\w+\s*,\s*(?:\"|~>|git:|github:|path:)")


def strip_comments(text):
    text = re.sub(r'"""[\s\S]*?"""', '""', text)
    text = re.sub(r'"(?:\\.|[^"\\\n])*"', '""', text)
    return re.sub(r"#[^\n]*", "", text)


def lib_sources(repo):
    """{relative path: text} of .ex files under lib/."""
    lib = repo / "lib"
    return {str(p.relative_to(repo)): p.read_text(errors="replace")
            for p in sorted(lib.rglob("*.ex"))} if lib.is_dir() else {}


def arch_checks(repo):
    srcs = lib_sources(repo)
    code = {k: strip_comments(v) for k, v in srcs.items()}
    joined = "\n".join(code.values())
    sizes = {k: len([l for l in v.splitlines() if l.strip()]) for k, v in srcs.items()}
    total = sum(sizes.values())
    mix = (repo / "mix.exs").read_text(errors="replace") if (repo / "mix.exs").is_file() else ""
    writers = [k for k, v in code.items() if FILE_WRITES.search(v)]
    return {
        # The queue state lives in a GenServer...
        "genserver_queue": bool(re.search(r"\buse\s+GenServer\b", joined)),
        # ...started under the application's supervision tree.
        "supervised_application": bool(re.search(r"\bmod:\s*\{", mix))
        and bool(re.search(r"\buse\s+Application\b", joined))
        and bool(re.search(r"\bSupervisor\.start_link\b|\buse\s+Supervisor\b", joined)),
        "modules_separated": len(srcs) >= 4 and total > 0 and max(sizes.values()) <= 0.5 * total,
        # Reading/writing the state file is confined to one persistence module.
        "single_persistence_module": len(writers) == 1,
        "no_dependencies": bool(mix) and not DEP_TUPLE.search(strip_comments(mix)),
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

    home = Path(tempfile.mkdtemp(prefix="tfbench-mix-"))
    env = {"PATH": TOOL_PATH, "MIX_HOME": str(home / "mix"), "HEX_HOME": str(home / "hex"),
           "HEX_OFFLINE": "1", "MIX_ENV": "dev", "NO_COLOR": "1"}
    mix = shutil.which("mix", path=TOOL_PATH) or "mix"
    for d in ("_build", "deps"):
        shutil.rmtree(repo / d, ignore_errors=True)
    binary = repo / "jobq"
    binary.unlink(missing_ok=True)

    build_out, build_passed, warnings_ok, fmt_ok = "", False, False, False
    if (repo / "mix.exs").is_file():
        rc, out = ek.sh([mix, "compile", "--warnings-as-errors"], repo, timeout=600, env=env)
        warnings_ok = rc == 0
        build_out = out
        rc, out = ek.sh([mix, "escript.build"], repo, timeout=600, env=env)
        build_out += out
        build_passed = rc == 0 and binary.is_file()
        rc, _ = ek.sh([mix, "format", "--check-formatted"], repo, timeout=300, env=env)
        fmt_ok = rc == 0
    else:
        build_out = "no mix.exs"

    # Agent tests: ExUnit files under test/.
    agent_tests_added = any(re.match(r"test/.*_test\.exs$", f) for f in files)
    agent_tests_pass = False
    test_out = ""
    if build_passed and agent_tests_added:
        rc, test_out = ek.sh([mix, "test"], repo, timeout=600, env={**env, "MIX_ENV": "test"})
        agent_tests_pass = rc == 0 and bool(re.search(r"\b[1-9]\d* (?:tests?|passed)\b", test_out))

    hidden, hidden_out = {}, ""
    if build_passed:
        _, hidden_out = ek.sh([sys.executable, "-I", str(HIDDEN_SCRIPT), str(binary)], repo,
                              timeout=900, env={"PATH": TOOL_PATH})
        for m in re.finditer(r"^(PASS|FAIL) (\w+)", hidden_out, flags=re.M):
            hidden[m.group(2)] = m.group(1) == "PASS"
    hidden = {n: hidden.get(n, False) for n in hidden_names()}

    arch = arch_checks(repo)

    scored = ek.score_coding(
        build_passed=build_passed, hidden_results=hidden, requirement_groups=GROUPS,
        original_tests_passed=True, agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass, arch_checks=arch, unrelated=unrelated,
        fmt_ok=fmt_ok and warnings_ok, diff_added=diff_added, diff_limit=10 ** 9, rubric=TASK["rubric"])
    checks = {"build_passed": build_passed, "tests_passed": True, "lint_passed": warnings_ok,
              "format_passed": fmt_ok, "typecheck_passed": None}
    details = {"changed_files": files, "unrelated": unrelated, "diff": [diff_added, diff_removed],
               "agent_tests_added": agent_tests_added, "agent_tests_pass": agent_tests_pass,
               "arch_checks": arch, "hidden": hidden,
               "hidden_failures": [l for l in hidden_out.splitlines() if l.startswith("FAIL")][:30],
               "test_output": test_out[-2000:] if agent_tests_added and not agent_tests_pass else "",
               "build_output": build_out[-2000:] if not (build_passed and warnings_ok) else ""}
    ek.write_result(a.out, TASK["id"], checks, scored, details)
    shutil.rmtree(repo.parent, ignore_errors=True)
    shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    main()
