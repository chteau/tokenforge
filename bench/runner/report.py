"""Aggregate run manifests into reports/benchmark-report.{md,json} and results/aggregated/.

Only measured values are used. Missing measurements stay null / "n/a". Negative savings are reported as negative.
"""
from __future__ import annotations

import json
import math
import statistics as st
from collections import defaultdict
from pathlib import Path

AGENTS = ("native", "token-forge")
LABEL = {"native": "Native", "token-forge": "Token Forge"}
EXECUTED = {"completed", "agent_error", "budget_exceeded", "timeout"}
METRICS = ["total_tokens", "input_tokens", "output_tokens", "cached_input_tokens", "uncached_input_tokens",
           "input_equivalent_tokens", "total_cost_usd_reported", "tool_calls", "duration_seconds", "quality_score"]


def load_runs(sessions):
    runs = []
    for s in sessions:
        for m in sorted(Path(s).glob("*/*/manifest.json")):
            r = json.loads(m.read_text())
            d = m.parent
            r["_dir"] = str(d)
            r["_session"] = Path(s).name
            if (d / "telemetry.json").exists():
                r["_tel"] = json.loads((d / "telemetry.json").read_text())
            if (d / "environment_manifest.json").exists():
                r["_lean"] = json.loads((d / "environment_manifest.json").read_text()).get("token_forge_lean")
            if (d / "eval.json").exists():
                r["_eval"] = json.loads((d / "eval.json").read_text())
            runs.append(r)
    return runs


def pct(a, b):
    """Savings of b relative to baseline a, in percent (negative = Token Forge used more)."""
    if a in (None, 0) or b is None:
        return None
    return round((1 - b / a) * 100, 2)


def dist(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    q = sorted(xs)

    def p(k):
        if len(q) == 1:
            return q[0]
        i = (len(q) - 1) * k
        lo, hi = math.floor(i), math.ceil(i)
        return q[lo] + (q[hi] - q[lo]) * (i - lo)
    return {"n": len(q), "mean": round(st.mean(q), 2), "median": round(st.median(q), 2), "min": q[0], "max": q[-1],
            "stdev": round(st.stdev(q), 2) if len(q) > 1 else None, "p10": round(p(.1), 2), "p25": round(p(.25), 2),
            "p75": round(p(.75), 2), "p90": round(p(.9), 2)}


def med(rs, key):
    xs = [r.get(key) for r in rs if r.get(key) is not None]
    return st.median(xs) if xs else None


def tool(r, key):
    return (r.get("_tel") or {}).get("tools", {}).get(key)


def sign_test(wins, losses):
    """Two-sided exact binomial sign test p-value (ties dropped)."""
    n = wins + losses
    if n == 0:
        return None
    k = min(wins, losses)
    p = sum(math.comb(n, i) for i in range(0, k + 1)) / 2 ** n
    return round(min(1.0, 2 * p), 4)


def fmt(x, d=0):
    if x is None:
        return "n/a"
    if isinstance(x, float) and d:
        return f"{x:,.{d}f}"
    if isinstance(x, (int, float)):
        return f"{x:,.0f}" if abs(x) >= 100 or d == 0 else f"{x:,.{d}f}"
    return str(x)


def build(sessions, root: Path, out_name="benchmark-report"):
    root = Path(root)
    runs = load_runs(sessions)
    # Only Token Forge runs of the plugin build under test (environments/token-forge/manifest.json) count;
    # runs of other builds are listed separately. Native runs must share the Claude Code version.
    tfman = root / "environments" / "token-forge" / "manifest.json"
    cur = json.loads(tfman.read_text()) if tfman.exists() else {}
    want_sha, want_cc = cur.get("plugin_sha256"), cur.get("claude_code_version")
    equiv = json.loads((root / "benchmark.config.json").read_text())["token_forge"].get("equivalent_builds", {})
    ok_shas = {want_sha, *equiv}
    want_lean = cur.get("token_forge_lean")
    other_build = [r for r in runs if r.get("agent") == "token-forge" and
                   (r.get("variant") or r.get("token_forge_plugin_sha256") not in ok_shas or (r.get("_lean") or False) != (want_lean or False))]
    other_cc = [r for r in runs if r.get("claude_code_version") != want_cc]
    runs = [r for r in runs if r not in other_build and r not in other_cc]
    executed = [r for r in runs if r.get("status") in EXECUTED]
    not_run = [r for r in runs if r.get("status") not in EXECUTED]
    by_task = defaultdict(lambda: defaultdict(list))
    for r in executed:
        by_task[r["task"]][r["agent"]].append(r)

    per_task = []
    for tid in sorted(by_task):
        a, b = by_task[tid]["native"], by_task[tid]["token-forge"]
        row = {"task": tid, "category": (a or b)[0].get("category"), "runs": {"native": len(a), "token-forge": len(b)}}
        for agent, rs in (("native", a), ("token-forge", b)):
            row[agent] = {k: med(rs, k) for k in METRICS + ["files_read", "lines_read", "bytes_read", "first_request_context_tokens", "api_requests"]}
            row[agent]["redundant_reads"] = st.median([tool(r, "redundant_reads") or 0 for r in rs]) if rs else None
            row[agent]["tool_result_bytes"] = med([{"x": tool(r, "tool_result_bytes")} for r in rs], "x")
            row[agent]["files_read_incl_bash"] = med([{"x": tool(r, "files_read_incl_bash_heuristic")} for r in rs], "x")
            row[agent]["context_precision_approx"] = med([{"x": tool(r, "context_precision_approx")} for r in rs], "x")
            row[agent]["subagent_calls"] = med([{"x": tool(r, "subagent_calls")} for r in rs], "x")
            row[agent]["completion_rate"] = round(sum(bool(r.get("task_completed")) for r in rs) / len(rs), 3) if rs else None
            row[agent]["statuses"] = [r.get("status") for r in rs]
            row[agent]["tests_passed"] = [r.get("tests_passed") for r in rs]
            q, t = row[agent]["quality_score"], row[agent]["total_tokens"]
            row[agent]["tokens_per_quality_point"] = round(t / q, 1) if q and t else None
            row[agent]["quality_per_million_tokens"] = round(q / t * 1e6, 2) if q is not None and t else None
            row[agent]["nested_session_tokens"] = med([{"x": ((r.get("_tel") or {}).get("tokens_exact", {}).get("nested_sessions") or {}).get("total_tokens")} for r in rs], "x")
        if a and b:
            na, tb = row["native"], row["token-forge"]
            row["diff"] = {
                "total_tokens_abs": (na["total_tokens"] - tb["total_tokens"]) if None not in (na["total_tokens"], tb["total_tokens"]) else None,
                "token_savings_percent": pct(na["total_tokens"], tb["total_tokens"]),
                "input_savings_percent": pct(na["input_tokens"], tb["input_tokens"]),
                "output_savings_percent": pct(na["output_tokens"], tb["output_tokens"]),
                "uncached_input_savings_percent": pct(na["uncached_input_tokens"], tb["uncached_input_tokens"]),
                "input_equivalent_savings_percent": pct(na["input_equivalent_tokens"], tb["input_equivalent_tokens"]),
                "cost_savings_percent": pct(na["total_cost_usd_reported"], tb["total_cost_usd_reported"]),
                "quality_diff": (tb["quality_score"] - na["quality_score"]) if None not in (na["quality_score"], tb["quality_score"]) else None,
                "tool_call_diff_percent": pct(na["tool_calls"], tb["tool_calls"]),
                "files_read_diff_percent": pct(na["files_read_incl_bash"], tb["files_read_incl_bash"]),
                "lines_read_diff_percent": pct(na["lines_read"], tb["lines_read"]),
                "first_request_overhead_tokens": (tb["first_request_context_tokens"] - na["first_request_context_tokens"])
                if None not in (na["first_request_context_tokens"], tb["first_request_context_tokens"]) else None,
            }
        per_task.append(row)

    paired = [r for r in per_task if "diff" in r]

    def col(key):
        return [r["diff"][key] for r in paired if r["diff"].get(key) is not None]
    agg = {
        "tasks_paired": len(paired),
        "runs_executed": len(executed), "runs_not_executed": len(not_run),
        "token_savings_percent": dist(col("token_savings_percent")),
        "input_savings_percent": dist(col("input_savings_percent")),
        "output_savings_percent": dist(col("output_savings_percent")),
        "uncached_input_savings_percent": dist(col("uncached_input_savings_percent")),
        "input_equivalent_savings_percent": dist(col("input_equivalent_savings_percent")),
        "cost_savings_percent": dist(col("cost_savings_percent")),
        "quality_diff": dist(col("quality_diff")),
        "tool_call_reduction_percent": dist(col("tool_call_diff_percent")),
        "files_read_reduction_percent": dist(col("files_read_diff_percent")),
        "first_request_overhead_tokens": dist(col("first_request_overhead_tokens")),
    }
    tot = {a: sum(r[a]["total_tokens"] or 0 for r in paired) for a in AGENTS}
    agg["pooled_token_savings_percent"] = pct(tot["native"], tot["token-forge"]) if paired else None
    wins = sum(1 for x in col("token_savings_percent") if x > 0)
    losses = sum(1 for x in col("token_savings_percent") if x < 0)
    agg["sign_test"] = {"tasks_tf_cheaper": wins, "tasks_tf_costlier": losses, "p_value_two_sided": sign_test(wins, losses)}
    per_agent = {}
    for a in AGENTS:
        rs = [r for r in executed if r["agent"] == a]
        per_agent[a] = {k: dist([r.get(k) for r in rs]) for k in METRICS}
        per_agent[a]["completion_rate"] = round(sum(bool(r.get("task_completed")) for r in rs) / len(rs), 3) if rs else None
        per_agent[a]["runs"] = len(rs)
    cats = defaultdict(list)
    for r in paired:
        cats[r["category"]].append(r)
    per_cat = {}
    for c, rs in sorted(cats.items()):
        s = [r["diff"]["token_savings_percent"] for r in rs if r["diff"]["token_savings_percent"] is not None]
        qd = [r["diff"]["quality_diff"] for r in rs if r["diff"]["quality_diff"] is not None]
        med_s = st.median(s) if s else None
        verdict = None
        if s:
            if all(x > 5 for x in s):
                verdict = "better (all tasks cheaper by >5%)"
            elif all(x < -5 for x in s):
                verdict = "worse (all tasks costlier by >5%)"
            elif abs(med_s) <= 5:
                verdict = "neutral (median within ±5%)"
            else:
                verdict = "mixed"
        per_cat[c] = {"tasks": [r["task"] for r in rs], "median_token_savings_percent": med_s,
                      "median_quality_diff": st.median(qd) if qd else None, "verdict": verdict}

    # validation
    validation = {
        "contaminated_or_invalid_runs": [(r.get("run_id"), r.get("status"), r.get("problems")) for r in not_run],
        "isolation_problems": [(r["run_id"], r["isolation_problems"]) for r in executed if r.get("isolation_problems")],
        "missing_telemetry": [r["run_id"] for r in executed if not r.get("total_tokens")],
        "repo_commit_mismatch": [],
        "prompt_hash_mismatch": [],
        "missing_evaluation": [r["run_id"] for r in executed if r.get("quality_score") is None],
        # the model that actually answered, from every API response in the transcripts (not just --model);
        # "<synthetic>" entries are local Claude Code notices with zero tokens, not model calls
        "api_models": dict(__import__("collections").Counter(
            k for r in executed for k, v in ((r.get("_tel") or {}).get("tokens_exact", {}).get("by_model") or {}).items()
            if v.get("total_tokens"))),
        "runs_with_other_models": [r["run_id"] for r in executed if any(
            k != r.get("model") and v.get("total_tokens")
            for k, v in ((r.get("_tel") or {}).get("tokens_exact", {}).get("by_model") or {}).items())],
    }
    for tid, ags in by_task.items():
        rs = ags["native"] + ags["token-forge"]
        if len({r["repository_commit"] for r in rs}) > 1:
            validation["repo_commit_mismatch"].append(tid)
        if len({r["prompt_hash"] for r in rs}) > 1:
            validation["prompt_hash_mismatch"].append(tid)

    meta = {}
    for s in sessions:
        p = Path(s) / "session.json"
        if p.exists():
            meta[Path(s).name] = json.loads(p.read_text())
    data = {"sessions": meta, "token_forge_build": {"version": cur.get("token_forge_version"), "plugin_sha256": want_sha,
            "plugin_git_commit": cur.get("plugin_git_commit"), "plugin_git_dirty": cur.get("plugin_git_dirty"), "lean": want_lean,
            "equivalent_builds": equiv},
            "excluded_runs_other_build": [f"{r['_session']}/{r.get('run_id')}" for r in other_build],
            "excluded_runs_other_claude_code": [f"{r['_session']}/{r.get('run_id')}" for r in other_cc],
            "aggregate": agg, "per_agent": per_agent, "per_category": per_cat, "per_task": per_task,
            "validation": validation,
            "runs": [{k: v for k, v in r.items() if not k.startswith("_")} | {"tools": (r.get("_tel") or {}).get("tools"),
                     "tokens_exact": (r.get("_tel") or {}).get("tokens_exact"), "estimated": (r.get("_tel") or {}).get("estimated"),
                     "hooks": (r.get("_tel") or {}).get("hooks"), "eval": r.get("_eval")} for r in runs]}
    (root / "reports").mkdir(exist_ok=True)
    (root / "results" / "aggregated").mkdir(parents=True, exist_ok=True)
    (root / "reports" / f"{out_name}.json").write_text(json.dumps(data, indent=2, default=str) + "\n")
    (root / "results" / "aggregated" / f"{out_name}.json").write_text(json.dumps({k: data[k] for k in ("aggregate", "per_agent", "per_category", "per_task")}, indent=2, default=str) + "\n")
    (root / "reports" / f"{out_name}.md").write_text(render_md(data))
    print(f"wrote reports/{out_name}.md and .json ({len(runs)} runs)")
    return data


def render_md(d):
    a = d["aggregate"]; pa = d["per_agent"]
    L = ["# Token Forge vs clean Claude Code — benchmark report", ""]
    s0 = next(iter(d["sessions"].values()), {})
    b = d["token_forge_build"]
    L += [f"Model `{s0.get('model')}`, Claude Code {s0.get('claude_code_version')}, benchmark {s0.get('benchmark_version')}. "
          f"Token Forge build under test: {b['version']} (plugin sha256 `{(b['plugin_sha256'] or '')[:12]}`, git {(b['plugin_git_commit'] or '')[:8]}{' + uncommitted changes' if b['plugin_git_dirty'] else ''}), lean: {b.get('lean') or 'off'}. "
          f"Sessions: {', '.join(d['sessions'])}.", ""]
    if d["excluded_runs_other_build"]:
        L += [f"Excluded: {len(d['excluded_runs_other_build'])} Token Forge runs of other plugin builds (listed in the JSON report).", ""]
    L += ["## Executive summary", ""]
    ts = a["token_savings_percent"]
    if ts:
        L += [f"Across {a['tasks_paired']} paired tasks ({a['runs_executed']} executed runs, {a['runs_not_executed']} not executed):", "",
              f"- Total-token savings per task: median **{ts['median']}%**, mean {ts['mean']}% (min {ts['min']}%, max {ts['max']}%). Pooled over all tasks: {a['pooled_token_savings_percent']}%.",
              f"- Input-token savings (median): {(a['input_savings_percent'] or {}).get('median')}%; output-token savings (median): {(a['output_savings_percent'] or {}).get('median')}%; uncached input (median): {(a['uncached_input_savings_percent'] or {}).get('median')}%.",
              f"- Price-weighted (input-equivalent) savings (median): {(a['input_equivalent_savings_percent'] or {}).get('median')}%; reported cost savings (median): {(a['cost_savings_percent'] or {}).get('median')}%.",
              f"- Task completion: Native {pa['native']['completion_rate']}, Token Forge {pa['token-forge']['completion_rate']}.",
              f"- Mean quality: Native {(pa['native']['quality_score'] or {}).get('mean')}, Token Forge {(pa['token-forge']['quality_score'] or {}).get('mean')}; median per-task quality difference (TF − native): {(a['quality_diff'] or {}).get('median')}.",
              f"- Tasks where Token Forge was cheaper / costlier: {a['sign_test']['tasks_tf_cheaper']} / {a['sign_test']['tasks_tf_costlier']} (sign test p = {a['sign_test']['p_value_two_sided']}).",
              f"- Fixed context added by Token Forge on the first request (median, measured): {fmt((a['first_request_overhead_tokens'] or {}).get('median'))} tokens.", ""]
    else:
        L += ["No paired measurements yet.", ""]
    L += ["Positive savings mean Token Forge used fewer tokens; negative means it used more. "
          "`total tokens` = input + cache writes + cache reads + output, summed over the main session, subagents and nested `claude -p` sessions.", ""]
    L += ["## Per-task comparison (median over repetitions)", "",
          "| Task | Agent | Runs | Total tokens | Input | Output | Uncached in | Cost $ | Tool calls | Files read | Tests | Quality | Status |",
          "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|"]
    for r in d["per_task"]:
        for ag in AGENTS:
            x = r[ag]
            tests = ",".join("PASS" if t else ("FAIL" if t is False else "n/a") for t in x["tests_passed"])
            L.append(f"| {r['task']} | {LABEL[ag]} | {r['runs'][ag]} | {fmt(x['total_tokens'])} | {fmt(x['input_tokens'])} | {fmt(x['output_tokens'])} | "
                     f"{fmt(x['uncached_input_tokens'])} | {fmt(x['total_cost_usd_reported'], 2)} | {fmt(x['tool_calls'])} | {fmt(x['files_read_incl_bash'])} | {tests} | "
                     f"{fmt(x['quality_score'], 1)} | {','.join(map(str, x['statuses']))} |")
    L += ["", "| Task | Token diff | Savings % | Input % | Output % | Uncached % | Cost % | Quality Δ | Tool calls % | Files read % | Lines read % |",
          "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for r in d["per_task"]:
        if "diff" not in r:
            continue
        x = r["diff"]
        L.append(f"| {r['task']} | {fmt(x['total_tokens_abs'])} | {fmt(x['token_savings_percent'], 1)} | {fmt(x['input_savings_percent'], 1)} | "
                 f"{fmt(x['output_savings_percent'], 1)} | {fmt(x['uncached_input_savings_percent'], 1)} | {fmt(x['cost_savings_percent'], 1)} | "
                 f"{fmt(x['quality_diff'], 1)} | {fmt(x['tool_call_diff_percent'], 1)} | {fmt(x['files_read_diff_percent'], 1)} | {fmt(x['lines_read_diff_percent'], 1)} |")
    L += ["", "## Quality-adjusted efficiency", "", "| Task | Native tokens/quality pt | TF tokens/quality pt | Native quality/Mtok | TF quality/Mtok |", "|---|---:|---:|---:|---:|"]
    for r in d["per_task"]:
        L.append(f"| {r['task']} | {fmt(r['native']['tokens_per_quality_point'])} | {fmt(r['token-forge']['tokens_per_quality_point'])} | "
                 f"{fmt(r['native']['quality_per_million_tokens'], 2)} | {fmt(r['token-forge']['quality_per_million_tokens'], 2)} |")
    L += ["", "## Distribution statistics (all executed runs)", ""]
    for ag in AGENTS:
        L += [f"**{LABEL[ag]}** ({pa[ag]['runs']} runs)", "", "| Metric | mean | median | min | max | stdev |", "|---|---:|---:|---:|---:|---:|"]
        for k in METRICS:
            x = pa[ag][k]
            if x:
                L.append(f"| {k} | {fmt(x['mean'], 2)} | {fmt(x['median'], 2)} | {fmt(x['min'], 2)} | {fmt(x['max'], 2)} | {fmt(x['stdev'], 2)} |")
        L.append("")
    if ts:
        L += ["Per-task token savings %: " + ", ".join(f"{k} {ts[k]}" for k in ("mean", "median", "p10", "p25", "p75", "p90")), ""]
    L += ["## Per-category results", "", "| Category | Tasks | Median savings % | Median quality Δ | Verdict |", "|---|---|---:|---:|---|"]
    for c, x in d["per_category"].items():
        L.append(f"| {c} | {', '.join(x['tasks'])} | {fmt(x['median_token_savings_percent'], 1)} | {fmt(x['median_quality_diff'], 1)} | {x['verdict']} |")
    L += ["", "## Why: tool and context traces (medians)", "",
          "| Task | Agent | API requests | First-request context | Lines read | Tool-result bytes | Redundant reads | Context precision≈ | Subagents | Nested-session tokens |",
          "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for r in d["per_task"]:
        for ag in AGENTS:
            x = r[ag]
            L.append(f"| {r['task']} | {LABEL[ag]} | {fmt(x['api_requests'])} | {fmt(x['first_request_context_tokens'])} | {fmt(x['lines_read'])} | "
                     f"{fmt(x['tool_result_bytes'])} | {fmt(x['redundant_reads'])} | {fmt(x['context_precision_approx'], 2)} | {fmt(x['subagent_calls'])} | {fmt(x['nested_session_tokens'])} |")
    L += ["", "Context precision is approximate: the share of files read that match the task's `relevant_files` globs. "
          "Files read via `cat`/`sed`/`head` in Bash are detected heuristically.", ""]
    v = d["validation"]
    L += ["## Validation", ""]
    for k, x in v.items():
        L.append(f"- {k.replace('_', ' ')}: {'none' if not x else x}")
    L += ["", "## Statistical conclusion", "", "_Filled in from the numbers above after the full run; see `ANALYSIS` section if present._", ""]
    return "\n".join(L) + "\n"
