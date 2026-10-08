#!/usr/bin/env python3
"""Evaluator for go-feature: scheduled notifications with quiet hours, idempotency and retries."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "runner"))
import evalkit  # noqa: E402

TASK = json.loads((HERE / "task.json").read_text())
HIDDEN = HERE / "hidden"
HIDDEN_PKG = "./internal/app/schedcheck/"
HIDDEN_PREFIX = "TestSchedHidden"

REQUIREMENT_GROUPS = {
    "notification_preferences": ["TestSchedHiddenPrefs"],
    "scheduling_api": ["TestSchedHiddenSchedule"],
    "idempotency_keys": ["TestSchedHiddenIdem"],
    "dispatcher": ["TestSchedHiddenDispatch"],
    "quiet_hours_in_user_timezone": ["TestSchedHiddenQuiet"],
    "bounded_retry_with_backoff": ["TestSchedHiddenRetry"],
}

GO_ENV = {"GOTOOLCHAIN": "local", "GOPROXY": "off", "CGO_ENABLED": "0"}
TEST_FUNC = re.compile(r"^func (Test\w+)\(", re.M)


def go(cmd, repo, timeout=300):
    return evalkit.sh(cmd, repo, timeout=timeout, env=GO_ENV)


def test_names(text: str) -> set[str]:
    return set(TEST_FUNC.findall(text))


def base_test_names(repo, base) -> set[str]:
    _, files = evalkit.sh(["git", "ls-tree", "-r", "--name-only", base], repo)
    names = set()
    for f in files.splitlines():
        if f.endswith("_test.go"):
            _, src = evalkit.sh(["git", "show", f"{base}:{f}"], repo)
            names |= test_names(src)
    return names


def go_files(repo, changed, *, tests=False, under=""):
    out = []
    for f in changed:
        if not f.endswith(".go") or not f.startswith(under):
            continue
        if f.endswith("_test.go") != tests:
            continue
        p = Path(repo) / f
        if p.is_file():
            out.append((f, p.read_text(errors="replace")))
    return out


def arch_checks(repo, changed) -> dict[str, bool]:
    handler_src = {p.name: p.read_text(errors="replace") for p in (Path(repo) / "internal/handlers").glob("*.go")
                   if not p.name.endswith("_test.go")}
    def route_lines(pattern):
        rx = re.compile(pattern)
        return [l for src in handler_src.values() for l in src.splitlines() if rx.search(l)]
    sched = route_lines(r'"POST\s+/v1/notifications"')
    dispatch = route_lines(r'"POST\s+/v1/admin/notifications/dispatch"')
    prefs = route_lines(r'"PUT\s+/v1/me/notification-preferences"')
    services_src = "\n".join(p.read_text(errors="replace") for p in (Path(repo) / "internal/services").rglob("*.go")
                             if not p.name.endswith("_test.go"))
    repos_src = "\n".join(p.read_text(errors="replace") for p in (Path(repo) / "internal/repositories").rglob("*.go")
                          if not p.name.endswith("_test.go"))
    changed_handlers = go_files(repo, changed, under="internal/handlers/")
    changed_prod = [(f, s) for f, s in go_files(repo, changed) if not f.startswith("internal/clock/")]
    app_src = "\n".join(p.read_text(errors="replace") for d in ("internal/app", "cmd/server")
                        for p in (Path(repo) / d).glob("*.go") if not p.name.endswith("_test.go"))
    authed = re.compile(r"\b(protected|staff|authn|Authenticate)\(")
    return {
        # all new routes registered in the existing router and behind the auth middleware
        "routes_registered_with_auth": bool(sched and dispatch and prefs) and all(authed.search(l) for l in sched + dispatch + prefs),
        # business logic in the service layer
        "service_layer_dispatch": bool(re.search(r"func \(\w+ \*\w+\) \w*(Dispatch|Deliver|Process|Due|Pending)\w*\(\w+ context\.Context", services_src)),
        # persistence behind a repository interface in the repositories package
        "repository_interface": bool(re.search(r"type \w*(Notification|Schedul)\w* interface", repos_src)),
        # handlers keep delegating to services
        "handlers_do_not_use_repositories": not any("internal/repositories" in s for s in handler_src.values()),
        # no parallel JSON/error writing helpers in the HTTP layer
        "reuses_json_helpers": not any(re.search(r"json\.(NewEncoder|NewDecoder|Marshal)\(|http\.Error\(", s)
                                       for _, s in changed_handlers),
        # time only from the injected clock (no wall-clock reads in new production code)
        "uses_injected_clock": not any(re.search(r"\btime\.(Now|Since|Until)\(", s) for _, s in changed_prod),
        # the server runs the dispatcher periodically
        "background_dispatch_wired": bool(re.search(r"\.\w*(Dispatch|Deliver|Process|Due|Pending)\w*\(", app_src))
                                     and bool(re.search(r"time\.(NewTicker|Tick|After|NewTimer)\(", app_src)),
    }


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

    rc, out = go(["go", "build", "./..."], repo)
    build_ok = rc == 0
    details["build_output"] = out[-3000:]

    rc_fmt, fmt_out = evalkit.sh(["gofmt", "-l", "."], repo)
    fmt_ok = rc_fmt == 0 and not fmt_out.strip()
    rc_vet, vet_out = go(["go", "vet", "./..."], repo)
    vet_ok = rc_vet == 0
    details["gofmt"] = fmt_out[-2000:]
    details["vet"] = vet_out[-3000:]

    # Visible suite (the agent's tree, before hidden tests are added).
    base_names = base_test_names(repo, a.base)
    visible = {}
    if build_ok:
        _, vout = go(["go", "test", "-json", "-count=1", "./..."], repo, timeout=600)
        visible = evalkit.go_test_json(vout)
    top = {k: v for k, v in visible.items() if "/" not in k}
    missing_orig = sorted(n for n in base_names if n not in top)
    failed_orig = sorted(n for n in base_names if n in top and not top[n])
    original_ok = build_ok and not missing_orig and not failed_orig
    details["original_tests_missing"] = missing_orig
    details["original_tests_failed"] = failed_orig

    changed_tests = go_files(repo, changed, tests=True)
    agent_test_names = set()
    for _, src in changed_tests:
        agent_test_names |= test_names(src)
    agent_tests_added = bool(changed_tests)
    agent_tests_pass = build_ok and agent_tests_added and all(top.get(n, False) for n in agent_test_names)
    details["agent_tests"] = sorted(agent_test_names)

    arch = arch_checks(repo, changed)

    # Hidden behaviour tests.
    evalkit.overlay(HIDDEN, repo)
    expected = set()
    for p in HIDDEN.rglob("*_test.go"):
        expected |= {n for n in test_names(p.read_text()) if n.startswith(HIDDEN_PREFIX)}
    hidden = {n: False for n in expected}
    if build_ok:
        _, hout = go(["go", "test", "-json", "-count=1", "-run", f"^{HIDDEN_PREFIX}", HIDDEN_PKG], repo, timeout=300)
        res = evalkit.go_test_json(hout)
        for n in expected:
            hidden[n] = res.get(n, False)
        if not any(res.get(n) is not None for n in expected):
            details["hidden_output"] = hout[-4000:]

    scored = evalkit.score_coding(
        build_passed=build_ok, hidden_results=hidden, requirement_groups=REQUIREMENT_GROUPS,
        original_tests_passed=original_ok, agent_tests_added=agent_tests_added,
        agent_tests_pass=agent_tests_pass, arch_checks=arch, unrelated=unrelated,
        fmt_ok=fmt_ok and vet_ok, diff_added=added, diff_limit=3 * TASK["reference_diff_lines"],
        rubric=TASK["rubric"])
    details["arch_checks"] = arch
    details["hidden_results"] = hidden
    checks = {"build_passed": build_ok, "tests_passed": original_ok, "lint_passed": vet_ok,
              "format_passed": fmt_ok, "typecheck_passed": None}
    evalkit.write_result(a.out, TASK["id"], checks, scored, details)


if __name__ == "__main__":
    main()
