#!/usr/bin/env python3
"""Token Forge vs clean Claude Code benchmark runner.

    bench.py doctor [--no-api]
    bench.py env build
    bench.py list
    bench.py run --smoke
    bench.py run --task ID [--agent native|token-forge | --both] [--reps N]
    bench.py run --all [--reps N] [--subset-reps ID,ID --subset-n N]
    bench.py compare [--session DIR ...]
    bench.py report  [--session DIR ...]

Common run options: --max-tokens N  --warn-tokens N  --max-budget-usd X  --jobs N  --seed N
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import random
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import isolation  # noqa: E402
import telemetry  # noqa: E402

ROOT = isolation.ROOT
TASKS = ROOT / "tasks"
RUNS = ROOT / "runs"
GIT_ENV = {"GIT_AUTHOR_NAME": "Dev", "GIT_AUTHOR_EMAIL": "dev@example.com", "GIT_COMMITTER_NAME": "Dev",
           "GIT_COMMITTER_EMAIL": "dev@example.com", "GIT_AUTHOR_DATE": "2026-01-15T10:00:00Z",
           "GIT_COMMITTER_DATE": "2026-01-15T10:00:00Z"}

PROMPT_TEMPLATE = """You are working in this repository.

Complete the requested task.

Requirements:
- Understand the existing architecture before modifying it.
- Make the smallest correct change.
- Preserve existing behavior.
- Add or update tests where appropriate.
- Run relevant validation before finishing.
- Do not modify unrelated files.

Task:
{task}
"""

LOCK = threading.Lock()


def now():
    return dt.datetime.now(dt.timezone.utc)


def log(msg):
    with LOCK:
        print(f"[{now().strftime('%H:%M:%S')}] {msg}", flush=True)


def sh(cmd, cwd=None, env=None, timeout=600):
    p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout + p.stderr)


def load_task(tid):
    t = json.loads((TASKS / tid / "task.json").read_text())
    t["prompt"] = PROMPT_TEMPLATE.format(task=(TASKS / tid / "prompt.md").read_text().strip())
    t["prompt_sha256"] = hashlib.sha256(t["prompt"].encode()).hexdigest()
    return t


def all_tasks(include_smoke=False):
    ids = sorted(p.parent.name for p in TASKS.glob("*/task.json"))
    return [i for i in ids if include_smoke or i != "smoke"]


def claude_version(cfg):
    rc, out = sh([cfg["claude_bin"], "--version"])
    return out.strip().split()[0] if rc == 0 and out.strip() else None


# ------------------------------------------------------------------ doctor

def cmd_doctor(args):
    cfg = isolation.load_config()
    ok_all = True

    def check(name, ok, detail="", critical=True):
        nonlocal ok_all
        mark = "✓" if ok else ("FAIL" if critical else "warn")
        print(f"{mark:>4}  {name}{(' — ' + detail) if detail else ''}")
        if not ok and critical:
            ok_all = False
        return ok

    ver = claude_version(cfg)
    check("Claude Code installed", bool(ver), f"{cfg['claude_bin']} {ver or ''}")
    check("Auth token provided to the benchmark (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)",
          bool(isolation.auth_env()),
          f"env var, or `claude setup-token` saved to {isolation.TOKEN_FILE} (chmod 600); ~/.claude/.credentials.json is never read")
    for tool, cmd in [("Rust", ["cargo", "--version"]), ("Go", ["go", "version"]), ("Node", ["node", "--version"]),
                      ("Git", ["git", "--version"]), ("Python", ["python3", "--version"]), ("tsc", ["tsc", "--version"])]:
        try:
            rc, out = sh(cmd, env=isolation.process_env(cfg, {"shim": "/nonexistent", "home": os.environ["HOME"],
                                                                "config": "/nonexistent", "tmp": "/tmp"}))
        except FileNotFoundError:
            rc, out = 1, "not found"
        check(f"{tool} available", rc == 0, out.strip().splitlines()[0] if out.strip() else "")
    for env in isolation.ENVS:
        tpl = ROOT / "environments" / isolation.ENV_DIR[env] / "template"
        check(f"{env} environment template built", tpl.exists(), str(tpl))
    # isolation audit on a throwaway sandbox
    if all((ROOT / "environments" / isolation.ENV_DIR[e] / "template").exists() for e in isolation.ENVS):
        for env in isolation.ENVS:
            w = Path(cfg["work_root"]) / f"doctor-{secrets.token_hex(3)}"
            sb = isolation.make_sandbox(cfg, env, w)
            repo = w / "repo"; repo.mkdir()
            sh(["git", "init", "-q"], cwd=repo)
            args_ = claude_args(cfg, env, sb, str(uuid.uuid4()), 1.0)
            clean, man = isolation.preflight(cfg, env, sb, repo, args_, isolation.process_env(cfg, sb))
            label = "Native environment isolated (no plugins/skills/MCP/hooks/CLAUDE.md)" if env == "native" else \
                "Token Forge environment loads only tokenforge"
            check(label, clean, "; ".join(man["findings"]) or "")
            shutil.rmtree(w, ignore_errors=True)
        man = json.loads((ROOT / "environments" / "token-forge" / "manifest.json").read_text()) \
            if (ROOT / "environments" / "token-forge" / "manifest.json").exists() else {}
        check("Token Forge version recorded", bool(man.get("token_forge_version")), man.get("token_forge_version", ""))
    vanilla = ROOT / "environments" / "native-clean" / "vanilla_inventory.json"
    check("Vanilla built-in inventory captured (from smoke run)", vanilla.exists(), "run `bench.py run --smoke`", critical=False)
    # task packs
    for tid in all_tasks(include_smoke=True):
        d = TASKS / tid
        missing = [f for f in ("task.json", "prompt.md", "setup.sh", "evaluate.py") if not (d / f).exists()]
        check(f"task {tid} valid", not missing, f"missing {missing}" if missing else "")
    if not args.no_api and isolation.auth_env():
        w = Path(cfg["work_root"]) / f"doctor-api-{secrets.token_hex(3)}"
        sb = isolation.make_sandbox(cfg, "native", w)
        repo = w / "repo"; repo.mkdir()
        cmd = [cfg["claude_bin"], "-p", "Reply with the single word: ok", "--model", cfg["model"],
               "--output-format", "json", "--strict-mcp-config", "--tools", ""]
        try:
            p = subprocess.run(cmd, cwd=repo, env=isolation.process_env(cfg, sb), capture_output=True, text=True, timeout=180)
            res = json.loads(p.stdout) if p.stdout.strip().startswith("{") else {}
        except Exception as e:  # noqa: BLE001
            res = {"error": str(e)}
        models = list((res.get("modelUsage") or {}).keys())
        check(f"Model {cfg['model']} available and authenticated", cfg["model"] in "".join(models) and not res.get("is_error"),
              f"modelUsage={models} {str(res.get('result', res.get('error', '')))[:120]}")
        check("Token telemetry available (usage in result)", bool(res.get("usage")), json.dumps(res.get("usage", {}))[:160])
        shutil.rmtree(w, ignore_errors=True)
    print("\nPASS" if ok_all else "\nFAIL — do not run the benchmark until the failures above are fixed")
    return 0 if ok_all else 1


# ------------------------------------------------------------------ env

def cmd_env_build(args):
    cfg = isolation.load_config()
    info = isolation.build_templates(cfg)
    ver = claude_version(cfg)
    tf = info["token-forge"]
    for env in isolation.ENVS:
        man = {"environment": isolation.ENV_DIR[env], "built_at": now().isoformat(), "claude_code_version": ver,
               "model": cfg["model"]}
        if env == "token-forge":
            src = cfg["token_forge"]["plugin_source"]
            _, commit = sh(["git", "rev-parse", "HEAD"], cwd=src)
            _, dirty = sh(["git", "status", "--porcelain", "--", ".", ":(exclude)bench"], cwd=src)
            man |= {"plugin_git_commit": commit.strip() or None, "plugin_git_dirty": bool(dirty.strip())}
            man |= {"token_forge": True, "token_forge_version": tf["version"], "plugin_sha256": tf["plugin_sha256"],
                    "token_forge_lean": tf["lean"],
                    "tmap_sha256": tf["tmap_sha256"], "plugin_source": cfg["token_forge"]["plugin_source"],
                    "other_custom_components": []}
        else:
            man |= {"clean": True, "custom_skills": [], "plugins": [], "mcp_servers": [], "hooks": [],
                    "claude_md_files": [], "custom_integrations": []}
        (ROOT / "environments" / isolation.ENV_DIR[env] / "manifest.json").write_text(json.dumps(man, indent=2) + "\n")
    print(json.dumps(info, indent=2))


def cmd_list(args):
    for tid in all_tasks(include_smoke=True):
        t = json.loads((TASKS / tid / "task.json").read_text())
        print(f"{tid:22} {t.get('category', ''):13} {t.get('language', ''):6} {t.get('title', '')}")


# ------------------------------------------------------------------ run

def claude_args(cfg, env, sb, session_id, max_budget_usd):
    a = ["-p", "--model", cfg["model"], "--output-format", "stream-json", "--verbose", "--strict-mcp-config",
         "--session-id", session_id, *cfg["permission_args"]]
    if max_budget_usd:
        a += ["--max-budget-usd", str(max_budget_usd)]
    if env == "token-forge":
        a += ["--plugin-dir", str(sb["plugin"])]
    return a


def build_canonical(tid, dest: Path):
    env = {**os.environ, **GIT_ENV}
    rc, out = sh(["bash", str(TASKS / tid / "setup.sh"), str(dest)], env=env, timeout=600)
    if rc != 0:
        raise SystemExit(f"setup.sh failed for {tid}:\n{out}")
    _, head = sh(["git", "rev-parse", "HEAD"], cwd=dest)
    return head.strip()


def repo_state(repo):
    _, head = sh(["git", "rev-parse", "HEAD"], cwd=repo)
    _, st = sh(["git", "status", "--porcelain"], cwd=repo)
    _, diff = sh(["git", "diff", "HEAD"], cwd=repo)
    return head.strip(), st, diff


def install_history(task, sb, repo, env, opts):
    """Two-session tasks: put a real earlier session's transcript into this run's Claude Code history, at this
    run's repo path. With TFORGE_RECALL=inject (token-forge variant) also write the snapshots tokenforge's
    checkpoint hook would have saved, so session start can reload them the old way."""
    h = task.get("history")
    if not h:
        return None
    src = ROOT / "fixtures" / "history" / f"{h['from_task']}.jsonl"
    text = src.read_text()
    key = "".join(c if c.isalnum() else "-" for c in str(repo.resolve()))
    text = text.replace("__REPO__", str(repo)).replace("__SANDBOX__", str(repo.parent)).replace("__PROJECTKEY__", key)
    sid = json.loads(text.splitlines()[0]).get("sessionId") or "history"
    dest = sb["config"] / "projects" / key / f"{sid}.jsonl"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(text)
    snaps = False
    if env == "token-forge" and opts.tf_env_map.get("TFORGE_RECALL") == "inject":
        plugin = sb["plugin"]
        subprocess.run(["node", str(plugin / "hooks" / "checkpoint.mjs")], input=json.dumps({
            "transcript_path": str(dest), "cwd": str(repo), "session_id": sid, "hook_event_name": "Stop"}),
            text=True, capture_output=True, env={**os.environ, "TMPDIR": str(sb["tmp"])}, timeout=60)
        snaps = (repo / ".forge" / "snapshots").exists()
    return {"from_task": h["from_task"], "session_id": sid, "path": dest, "snapshots": snaps,
            "tokens": telemetry.quick_total(sb["config"])}


def run_one(cfg, session: Path, canon: dict, tid: str, env: str, rep: int, opts) -> dict:
    task = load_task(tid)
    label = env if env == "native" or not opts.variant else f"{env}+{opts.variant}"
    run_id = f"{tid}-{label}-r{rep}"
    out = session / tid / f"{label}-r{rep}"
    if out.exists():
        raise SystemExit(f"refusing to overwrite existing run directory {out}")
    out.mkdir(parents=True)
    work = Path(cfg["work_root"]) / secrets.token_hex(4)          # neutral path: the agent sees its cwd
    sb = isolation.make_sandbox(cfg, env, work)
    repo = work / task.get("repo_dirname", "repo")
    shutil.copytree(canon[tid]["path"], repo, symlinks=True)
    head, st, diff = repo_state(repo)
    pre_repo = {"head": head, "clean": st.strip() == "" and diff.strip() == "", "expected_head": canon[tid]["commit"]}
    history = install_history(task, sb, repo, env, opts)
    session_id = str(uuid.uuid4())
    max_budget = opts.max_budget_usd
    cargs = claude_args(cfg, env, sb, session_id, max_budget)
    penv = isolation.process_env(cfg, sb)
    if env == "token-forge":
        penv.update(opts.tf_env_map)
    # task.json "hide_tools"/"hide_python_modules": simulate a machine without them (e.g. no poppler on Windows).
    # Identical for both agents: stub commands that fail like a missing binary, first on PATH, and Python stubs.
    if task.get("hide_tools") or task.get("hide_python_modules"):
        hid = work / "hidden-tools"
        (hid / "py").mkdir(parents=True, exist_ok=True)
        for t in task.get("hide_tools", []):
            (hid / t).write_text(f"#!/bin/sh\necho \"{t}: command not found\" >&2\nexit 127\n")
            (hid / t).chmod(0o755)
        for m in task.get("hide_python_modules", []):
            (hid / "py" / m).mkdir(exist_ok=True)
            (hid / "py" / m / "__init__.py").write_text(f"raise ModuleNotFoundError(\"No module named '{m}'\")\n")
        penv["PATH"] = f"{hid}:{penv['PATH']}"
        penv["PYTHONPATH"] = str(hid / "py")
    clean, env_manifest = isolation.preflight(cfg, env, sb, repo, cargs, penv, history=history)
    (out / "environment_manifest.json").write_text(json.dumps(env_manifest, indent=2) + "\n")
    (out / "prompt.txt").write_text(task["prompt"])
    manifest = {
        "run_id": run_id, "task": tid, "category": task.get("category"), "agent": env, "repetition": rep,
        "model": cfg["model"], "claude_code_version": cfg["_claude_version"], "benchmark_version": cfg["benchmark_version"],
        "token_forge_version": cfg["_tf_version"] if env == "token-forge" else None,
        "token_forge_plugin_sha256": cfg["_tf_sha"] if env == "token-forge" else None,
        "repository_commit": head, "prompt_hash": task["prompt_sha256"], "session_id": session_id,
        "sandbox": str(work), "max_tokens": opts.max_tokens, "max_budget_usd": max_budget,
        "timeout_s": task.get("timeout_s", cfg["timeout_s"]),
        "variant": opts.variant if env == "token-forge" else None,
        "tf_env": opts.tf_env_map if env == "token-forge" else None,
        "history": {"from_task": history["from_task"], "session_id": history["session_id"], "inject_snapshots": history["snapshots"]} if history else None,
    }
    problems = []
    if not (pre_repo["clean"] and head == canon[tid]["commit"]):
        problems.append(f"repository not at canonical state: {pre_repo}")
    if not clean:
        problems += env_manifest["findings"]
    if problems:
        status = "baseline_contaminated" if env == "native" else "environment_invalid"
        log(f"{run_id}: {status.upper()} — NOT RUN: {problems}")
        manifest |= {"status": status, "problems": problems, "start_time": None, "end_time": None}
        (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        return manifest

    log(f"{run_id}: start (sandbox {work.name})")
    start = now()
    stream_f = (out / "stream.jsonl").open("w")
    err_f = (out / "stderr.txt").open("w")
    proc = subprocess.Popen([cfg["claude_bin"], *cargs], cwd=repo, env=penv, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=err_f, text=True, start_new_session=True)
    proc.stdin.write(task["prompt"]); proc.stdin.close()
    state = {"init": None, "result": None, "stream_tokens": 0, "seen": set()}

    def reader():
        for line in proc.stdout:
            stream_f.write(line); stream_f.flush()
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("type") == "system" and ev.get("subtype") == "init" and state["init"] is None:
                state["init"] = ev
            elif ev.get("type") == "assistant":
                m = ev.get("message") or {}
                if m.get("id") and m.get("usage") and m["id"] not in state["seen"]:
                    state["seen"].add(m["id"])
                    state["stream_tokens"] += sum(telemetry._usage_total(m["usage"]).values())
            elif ev.get("type") == "result":
                state["result"] = ev
    th = threading.Thread(target=reader, daemon=True); th.start()

    timeout = manifest["timeout_s"]
    status, warned, peak = None, False, 0
    while proc.poll() is None:
        time.sleep(5)
        elapsed = (now() - start).total_seconds()
        try:
            peak = max(peak, state["stream_tokens"], telemetry.quick_total(sb["config"]) - (history["tokens"] if history else 0))
        except Exception:  # noqa: BLE001  (transcript mid-write)
            pass
        if not warned and opts.warn_tokens and peak > opts.warn_tokens:
            warned = True; log(f"{run_id}: WARNING {peak:,} tokens > warn threshold {opts.warn_tokens:,}")
        if opts.max_tokens and peak > opts.max_tokens:
            status = "budget_exceeded"
        elif elapsed > timeout:
            status = "timeout"
        if status:
            log(f"{run_id}: stopping — {status} ({peak:,} tokens, {elapsed:.0f}s)")
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                proc.wait(15)
            except Exception:  # noqa: BLE001
                os.killpg(proc.pid, signal.SIGKILL)
            break
    proc.wait()
    th.join(10)
    leftovers = isolation.kill_sandbox_processes(work)
    if leftovers:
        log(f"{run_id}: killed {len(leftovers)} leftover process(es): {leftovers}")
    stream_f.close(); err_f.close()
    end = now()
    res = state["result"] or {}
    if status is None:
        if not res:
            status = "agent_error"
        elif res.get("subtype") == "success" and not res.get("is_error"):
            status = "completed"
        elif "budget" in str(res.get("subtype", "")):
            status = "budget_exceeded"
        else:
            status = "agent_error"

    # ---- preserve raw data (the pre-installed history session is not part of this run's tokens)
    if history:
        history["path"].unlink(missing_ok=True)
    shutil.copytree(sb["config"] / "projects", out / "transcripts") if (sb["config"] / "projects").exists() else None
    if state["init"]:
        (out / "init.json").write_text(json.dumps(state["init"], indent=2) + "\n")
    sh(["git", "add", "-A", "--intent-to-add", "."], cwd=repo)
    _, diff = sh(["git", "diff", head, "--", ".", ":(exclude).forge"], cwd=repo)
    _, gst = sh(["git", "status", "--porcelain"], cwd=repo)
    _, cur = sh(["git", "rev-parse", "HEAD"], cwd=repo)
    (out / "diff.patch").write_text(diff)
    (out / "git_status.txt").write_text(gst)
    if (repo / ".forge").exists():
        shutil.copytree(repo / ".forge", out / "forge_state", ignore_dangling_symlinks=True)

    # ---- telemetry
    tel = telemetry.parse(sb["config"], repo, session_id, task.get("relevant_files", []))
    (out / "telemetry.json").write_text(json.dumps(tel, indent=2) + "\n")
    vanilla_p = ROOT / "environments" / "native-clean" / "vanilla_inventory.json"
    vanilla = json.loads(vanilla_p.read_text())["skills"] if vanilla_p.exists() else None
    if env == "native" and state["init"] and not vanilla_p.exists() and not tel["hooks"]["count"] and \
            not [p for p in state["init"].get("plugins") or [] if not isolation.is_builtin_plugin(p)]:
        vanilla_p.write_text(json.dumps({"captured_from": run_id, "claude_code_version": cfg["_claude_version"],
                                         "skills": state["init"].get("skills") or [],
                                         "slash_commands": state["init"].get("slash_commands") or [],
                                         "tools": state["init"].get("tools") or [],
                                         "builtin_plugins": [p for p in state["init"].get("plugins") or [] if isolation.is_builtin_plugin(p)],
                                         "agents": state["init"].get("agents") or []}, indent=2) + "\n")
    post = isolation.verify_init(env, state["init"], tel["hooks"]["count"], vanilla)
    if post:
        log(f"{run_id}: POST-RUN ISOLATION PROBLEM: {post}")

    # ---- evaluation (on a scratch copy inside evaluate.py)
    ev_out = out / "eval.json"
    rc, ev_log = sh([sys.executable, str(TASKS / tid / "evaluate.py"), "--workspace", str(repo), "--base", head,
                     "--out", str(ev_out)], timeout=1200,
                    env={**os.environ, **{k: os.path.expanduser(v) for k, v in cfg["toolchain_env"].items()}})
    (out / "eval.log").write_text(ev_log)
    ev = json.loads(ev_out.read_text()) if ev_out.exists() else {"status": "eval_error", "quality_score": None, "checks": {}}

    tk = tel["tokens_exact"]["all"]
    tools = tel["tools"]
    ck = ev.get("checks", {})
    manifest |= {
        "status": status, "isolation_problems": post, "leftover_processes_killed": leftovers,
        "builtin_plugins": [p.get("name") for p in (state["init"] or {}).get("plugins") or [] if isolation.is_builtin_plugin(p)],
        "start_time": start.isoformat(), "end_time": end.isoformat(),
        "duration_seconds": round((end - start).total_seconds(), 1),
        "num_turns": res.get("num_turns"), "total_cost_usd_reported": res.get("total_cost_usd"),
        "input_tokens": tk["input_tokens_total"], "output_tokens": tk["output_tokens"], "total_tokens": tk["total_tokens"],
        "cached_input_tokens": tk["cached_input_tokens"], "uncached_input_tokens": tk["uncached_input_tokens"],
        "cache_creation_input_tokens": tk["cache_creation_input_tokens"], "input_equivalent_tokens": tk["input_equivalent_tokens"],
        "api_requests": tk["requests"], "first_request_context_tokens": tel["tokens_exact"]["first_request_context_tokens"],
        "result_event_usage": res.get("usage"), "result_event_model_usage": res.get("modelUsage"),
        "tool_calls": tools["total_tool_calls"], "files_read": tools["files_read"], "lines_read": tools["lines_read"],
        "bytes_read": tools["bytes_read"],
        "tests_passed": ck.get("tests_passed"), "build_passed": ck.get("build_passed"), "lint_passed": ck.get("lint_passed"),
        "format_passed": ck.get("format_passed"), "typecheck_passed": ck.get("typecheck_passed"),
        "hidden_tests_passed": ev.get("hidden_tests_passed"), "hidden_tests_total": ev.get("hidden_tests_total"),
        "task_status": ev.get("status"),
        "task_completed": status == "completed" and ev.get("status") == "completed",
        "quality_score": ev.get("quality_score"),
        "final_head": cur.strip(),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if not opts.keep_sandbox:
        shutil.rmtree(work, ignore_errors=True)
    log(f"{run_id}: {status}; {tk['total_tokens']:,} tokens; {tools['total_tool_calls']} tools; quality {ev.get('quality_score')}")
    return manifest


def cmd_run(args):
    cfg = isolation.load_config()
    cfg["_claude_version"] = claude_version(cfg)
    tfman = json.loads((ROOT / "environments" / "token-forge" / "manifest.json").read_text())
    cfg["_tf_version"] = tfman.get("token_forge_version")
    cfg["_tf_sha"] = tfman.get("plugin_sha256")
    if isolation.sha256_dir(ROOT / "environments" / "token-forge" / "template" / "plugin" / "tokenforge") != cfg["_tf_sha"]:
        raise SystemExit("token-forge template differs from its manifest; run `bench.py env build`")
    if tfman.get("claude_code_version") != cfg["_claude_version"]:
        raise SystemExit("Claude Code version changed since `env build`; rebuild environments")
    if not isolation.auth_env():
        raise SystemExit(f"no credential: set CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY or save `claude setup-token` output to {isolation.TOKEN_FILE}")
    for k, v in (("max_tokens", "max_tokens"), ("warn_tokens", "warn_tokens"), ("max_budget_usd", "max_budget_usd")):
        if getattr(args, k) is None:
            setattr(args, k, cfg[v])

    if args.smoke:
        tasks, reps = ["smoke"], 1
    elif args.all:
        tasks, reps = all_tasks(), args.reps
    else:
        tasks, reps = [args.task], args.reps
    agents = list(isolation.ENVS) if (args.both or args.all or args.smoke or not args.agent) else [args.agent]

    seed = args.seed if args.seed is not None else secrets.randbelow(10**6)
    rng = random.Random(seed)
    schedule = []
    for tid in tasks:
        n = reps
        if args.subset_reps and tid in args.subset_reps.split(","):
            n = max(reps, args.subset_n)
        for rep in range(1, n + 1):
            order = agents[:]
            rng.shuffle(order)
            schedule.append((tid, rep, order))
    rng.shuffle(schedule)

    ts = now().strftime("%Y-%m-%dT%H-%M-%S")
    session = RUNS / (f"{ts}-{secrets.token_hex(2)}" + ("-smoke" if args.smoke else ""))  # unique even for parallel invocations
    session.mkdir(parents=True)
    canon_root = Path(cfg["work_root"]) / f"canon-{secrets.token_hex(3)}"
    canon = {}
    for tid in tasks:
        dest = canon_root / tid / json.loads((TASKS / tid / "task.json").read_text()).get("repo_dirname", "repo")
        canon[tid] = {"path": str(dest), "commit": build_canonical(tid, dest)}
    flat = [(tid, env, rep) for tid, rep, order in schedule for env in order]
    meta = {"session": session.name, "seed": seed, "benchmark_version": cfg["benchmark_version"], "model": cfg["model"],
            "claude_code_version": cfg["_claude_version"], "token_forge_version": cfg["_tf_version"],
            "max_tokens": args.max_tokens, "warn_tokens": args.warn_tokens, "max_budget_usd": args.max_budget_usd,
            "jobs": args.jobs, "canonical_commits": {k: v["commit"] for k, v in canon.items()},
            "run_order": [f"{t}-{e}-r{r}" for t, e, r in flat], "started": now().isoformat()}
    (session / "session.json").write_text(json.dumps(meta, indent=2) + "\n")
    log(f"session {session.name}: {len(flat)} runs, seed {seed}, jobs {args.jobs}")

    from concurrent.futures import ThreadPoolExecutor
    results = []
    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        futs = [ex.submit(run_one, cfg, session, canon, t, e, r, args) for t, e, r in flat]
        for f in futs:
            try:
                results.append(f.result())
            except BaseException as e:  # noqa: BLE001 — record, never drop a run silently
                log(f"run crashed: {e!r}")
                results.append({"status": "runner_error", "error": repr(e)})
    meta["finished"] = now().isoformat()
    meta["statuses"] = [r.get("status") for r in results]
    (session / "session.json").write_text(json.dumps(meta, indent=2) + "\n")
    shutil.rmtree(canon_root, ignore_errors=True)
    if args.smoke:
        return smoke_check(session)
    import report
    report.build([session], ROOT)
    return 0


def smoke_check(session: Path):
    ok = True
    for env in isolation.ENVS:
        d = session / "smoke" / f"{env}-r1"
        m = json.loads((d / "manifest.json").read_text())
        tel = json.loads((d / "telemetry.json").read_text()) if (d / "telemetry.json").exists() else {}
        checks = {
            "launched": m.get("status") == "completed",
            "isolation verified post-run": not m.get("isolation_problems"),
            "telemetry collected": bool(m.get("total_tokens")),
            "transcripts saved": (d / "transcripts").exists(),
            "diff saved": (d / "diff.patch").exists(),
            "evaluated": m.get("quality_score") is not None,
        }
        if env == "native":
            checks["no hooks executed"] = tel.get("hooks", {}).get("count") == 0
        else:
            checks["tokenforge hooks executed"] = tel.get("hooks", {}).get("count", 0) > 0
        for k, v in checks.items():
            print(f"{'✓' if v else 'FAIL':>4}  {env}: {k}")
            ok &= v
    import report
    report.build([session], ROOT, out_name="smoke-report")
    print("\nSMOKE PASS" if ok else "\nSMOKE FAIL")
    return 0 if ok else 1


def cmd_compare(args):
    import report
    sessions = [Path(s) for s in args.session] if args.session else \
        [p for p in sorted(RUNS.iterdir()) if p.is_dir() and not p.name.endswith("-smoke")]
    report.build(sessions, ROOT)
    return 0


def main():
    ap = argparse.ArgumentParser(prog="bench")
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("doctor"); d.add_argument("--no-api", action="store_true")
    d.add_argument("--use-local-login", action="store_true")
    e = sub.add_parser("env"); e.add_argument("action", choices=["build"])
    sub.add_parser("list")
    r = sub.add_parser("run")
    g = r.add_mutually_exclusive_group(required=True)
    g.add_argument("--task"); g.add_argument("--all", action="store_true"); g.add_argument("--smoke", action="store_true")
    r.add_argument("--agent", choices=list(isolation.ENVS)); r.add_argument("--both", action="store_true")
    r.add_argument("--reps", type=int, default=1)
    r.add_argument("--subset-reps", help="comma-separated task ids that get --subset-n repetitions")
    r.add_argument("--subset-n", type=int, default=3)
    r.add_argument("--max-tokens", type=int); r.add_argument("--warn-tokens", type=int)
    r.add_argument("--max-budget-usd", type=float)
    r.add_argument("--jobs", type=int, default=1); r.add_argument("--seed", type=int)
    r.add_argument("--keep-sandbox", action="store_true")
    r.add_argument("--tf-env", action="append", default=[], metavar="KEY=VALUE",
                   help="extra environment for token-forge runs only (e.g. TFORGE_RECALL=inject); needs --variant")
    r.add_argument("--variant", help="label for token-forge runs with --tf-env (kept apart from the main comparison)")
    r.add_argument("--use-local-login", action="store_true",
                   help="authenticate with the local Claude Code login's current access token (read-only, never refreshed)")
    for name in ("compare", "report"):
        c = sub.add_parser(name); c.add_argument("--session", nargs="*")
    a = ap.parse_args()
    if a.cmd == "run":
        a.tf_env_map = dict(x.split("=", 1) for x in a.tf_env)
        if a.tf_env_map and not a.variant:
            ap.error("--tf-env needs --variant (variant runs are reported separately)")
    if getattr(a, "use_local_login", False):
        os.environ["BENCH_USE_LOCAL_LOGIN"] = "1"
    fn = {"doctor": cmd_doctor, "env": cmd_env_build, "list": cmd_list, "run": cmd_run,
          "compare": cmd_compare, "report": cmd_compare}[a.cmd]
    sys.exit(fn(a) or 0)


if __name__ == "__main__":
    main()
