#!/usr/bin/env python3
"""Compare benchmark arms task by task: the evidence in reports/{baseline,optimization,ablation}-results.json.

    python3 bench/scripts/optimization.py -a NAME=SOURCE[,SOURCE...][@AGENT] ... [-p NEW:BASE ...] -o OUT.json

SOURCE is a session directory (runs/<session>: all its runs) or a report JSON (the runs it lists); @AGENT keeps one
agent's runs. Runs that did not execute (environment or runner errors) and excluded tasks are left out and listed.
Each arm names the TokenForge version, plugin build hash and Claude Code version of its runs; an arm whose runs come
from more than one of them is refused unless --mixed-versions is given.
Per arm: per-run distributions, the cold first request versus the warm rest, cache behaviour, quality, pipeline
checks and a cost attribution. Per pair NEW:BASE: per-task medians over repetitions, the per-task change (geometric
mean with a 95% t-interval, pooled total, exact sign test) and every task whose cost or quality got worse.

Token counts are the API usage logged in the transcripts. list_cost_usd prices them at benchmark.config.json
"pricing" and is checked against Claude Code's total_cost_usd. The attribution is a model-based estimate.
"""
from __future__ import annotations

import argparse
import json
import math
import statistics as st
import sys
from collections import Counter, defaultdict
from pathlib import Path

BENCH = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BENCH / "runner"))
import report  # noqa: E402
import telemetry  # noqa: E402

CONFIG = json.loads((BENCH / "benchmark.config.json").read_text())
PARTS = ("initial", "thinking", "visible", "results", "rewrite")
METRICS = ["list_cost_usd", "total_cost_usd_reported", "total_tokens", "input_tokens", "input_no_cache_tokens",
           "cached_input_tokens", "cache_creation_input_tokens", "cache_creation_5m_input_tokens",
           "cache_creation_1h_input_tokens", "output_tokens", "thinking_tokens", "visible_output_tokens", "api_requests",
           "tool_calls", "duration_seconds", "peak_rss_mb", "cpu_seconds", "hook_duration_ms", "first_request_cost_usd",
           "rest_cost_usd", "first_request_context_tokens", "first_request_cached_input_tokens",
           "first_request_thinking_tokens", "cache_miss_rewrite_tokens", "quality_score", "failure",
           "objective_j_usd"] + [f"cost_{p}_usd" for p in PARTS]
ROW = ["list_cost_usd", "total_tokens", "output_tokens", "thinking_tokens", "first_request_thinking_tokens",
       "tool_calls", "duration_seconds", "objective_j_usd", "quality_score"]
T975 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776}
ATTRIBUTION = ("Each request's cost is split exactly over the tokens it carries: cache reads over the context it "
               "re-reads; cache writes and uncached input over the tokens new since the previous request of that "
               "transcript (that request's output, thinking included, then tool results, hook context and reminders; "
               "at a transcript's first request its initial context); output over thinking and visible text. "
               "Previously cached tokens sent again (a cache miss or expiry) are 'rewrite'. A model-based estimate: "
               "it assumes earlier output is re-sent in full and new input beyond it is tool results or reminders.")
DEFINITIONS = {
    "tokens": "API usage logged in the transcripts (provider-reported). input_tokens is all input: uncached "
              "(input_no_cache_tokens), cache writes (cache_creation_*) and cache reads (cached_input_tokens)",
    "list_cost_usd": "that usage priced at `pricing`, writes by their logged TTL (unsplit writes as 5-minute); computed",
    "total_cost_usd_reported": "Claude Code's own cost figure for the session (list prices), not a provider invoice",
    "first_request_*": "the first API request of the main session, the cold part of a run; rest_cost_usd is the warm rest",
    "peak_rss_mb, cpu_seconds": "wait4 rusage of the agent process: largest resident set in its process tree and "
                                "user+system CPU; local measurements, unavailable for runs recorded before them",
    "cost_<part>_usd": "attribution.method; the parts sum to list_cost_usd",
    "failure": "R_failure: 1 - quality_score/100; 1 for a run that stopped without a score",
    "objective_j_usd": "J = alpha*list_cost_usd + beta*duration_seconds + gamma*cpu_seconds + delta*failure, weights in "
                       "`objective` (assumptions); unavailable when a term with a nonzero weight is",
    "per task": "median over the task's executed repetitions",
    "geo_mean_change_percent": "exp(mean over tasks of log(new/base)) - 1, 95% t-interval; negative = NEW lower",
    "pooled_change_percent": "sum of NEW over the paired tasks / sum of BASE - 1",
    "sign_test_p": "exact two-sided binomial over tasks (lower vs higher), ties dropped",
}


def r6(x):
    return None if x is None else round(x, 6)


def sub(a, b):
    return None if a is None or b is None else a - b


def dist(xs):
    """n, mean, median, stdev, min, max and sum of the available values; missing ones are counted, never imputed."""
    have = [x for x in xs if x is not None]
    if not have:
        return {"n": 0, "unavailable": len(xs)}
    return {"n": len(have), "mean": r6(st.mean(have)), "median": r6(st.median(have)),
            "stdev": r6(st.stdev(have)) if len(have) > 1 else None, "min": min(have), "max": max(have),
            "sum": r6(sum(have)), "unavailable": len(xs) - len(have)}


def t975(df):
    """97.5% quantile of Student's t: tabled below 5 degrees of freedom, else Cornish-Fisher (A&S 26.7.5, error < 1e-3)."""
    if df < 5:
        return T975[df]
    z = st.NormalDist().inv_cdf(.975)
    g = ((z**3 + z) / 4, (5 * z**5 + 16 * z**3 + 3 * z) / 96, (3 * z**7 + 19 * z**5 + 17 * z**3 - 15 * z) / 384,
         (79 * z**9 + 776 * z**7 + 1482 * z**5 - 1920 * z**3 - 945 * z) / 92160)
    return z + sum(c / df ** (i + 1) for i, c in enumerate(g))


def interval(xs):
    if len(xs) < 2:
        return None
    m, s = st.mean(xs), st.stdev(xs)
    h = t975(len(xs) - 1) * s / math.sqrt(len(xs))
    return {"n": len(xs), "mean": r6(m), "median": r6(st.median(xs)), "stdev": r6(s), "ci95": [r6(m - h), r6(m + h)]}


def failure(r):
    q = r.get("quality_score")
    return 1 - q / 100 if q is not None else 1.0 if r.get("status") != "completed" else None


def objective(r, w):
    """J of one run in USD (DEFINITIONS); None when a term with a nonzero weight is unavailable."""
    terms = {"alpha_per_api_usd": r.get("list_cost_usd"), "beta_usd_per_second": r.get("duration_seconds"),
             "gamma_usd_per_cpu_second": r.get("cpu_seconds"), "delta_usd_per_failure": failure(r)}
    if not w or any(w.get(k) and v is None for k, v in terms.items()):
        return None
    return sum(w[k] * v for k, v in terms.items() if w.get(k))


def attribute(run_dir: Path, pricing: dict) -> dict | None:
    """Cost of one run split by where its tokens entered the context (ATTRIBUTION); None if a model is unpriced."""
    reqs = {}
    for f, e in telemetry.iter_entries(run_dir, "transcripts"):
        m = e.get("message") or {}
        key = e.get("requestId") or m.get("id")
        if e.get("type") != "assistant" or not key or not m.get("usage"):
            continue
        u = telemetry._usage_total(m["usage"])
        th = int((m["usage"].get("output_tokens_details") or {}).get("thinking_tokens") or 0)
        if key in reqs:   # one streamed response, several entries: keep the final output count, as telemetry does
            r = reqs[key]
            r["o"], r["th"] = max(r["o"], u["output_tokens"]), max(r["th"], th)
            continue
        reqs[key] = {"file": str(f), "ts": e.get("timestamp") or "", "model": m.get("model"), "i": u["input_tokens"],
                     "cw": u["cache_creation_input_tokens"], "cr": u["cache_read_input_tokens"],
                     "o": u["output_tokens"], "th": th, "w1": telemetry._cache_ttl(m["usage"])[1]}
    threads = defaultdict(list)
    for r in reqs.values():
        threads[r["file"]].append(r)
    cost, tokens, odd = Counter(), Counter(), Counter()
    for seq in threads.values():
        seq.sort(key=lambda r: r["ts"])
        ctx, prev = Counter(), None   # token mix of the context sent so far
        for r in seq:
            p = pricing["usd_per_mtok"].get(r["model"])
            if p is None:
                if any(r[k] for k in ("i", "cw", "cr", "o")):
                    return None
                continue
            pin, p5, p1, pr, po = (p[k] / 1e6 for k in ("input", "cache_write_5m", "cache_write_1h", "cache_read", "output"))
            size, old = r["i"] + r["cw"] + r["cr"], sum(ctx.values())
            if size < old:   # the context shrank (compaction, cleared tool results): keep its mix, scaled down
                ctx = Counter({k: v * size / old for k, v in ctx.items()})
                old = size
                odd["context_shrinks"] += 1
            grow, new = size - old, Counter()
            if prev is None:
                new["initial"] = grow
            else:
                out = {"thinking": prev["th"], "visible": prev["o"] - prev["th"]}
                if grow >= prev["o"]:
                    new.update(out)
                    new["results"] = grow - prev["o"]
                elif prev["o"]:   # grew less than the previous output: count that output scaled down
                    new.update({k: v * grow / prev["o"] for k, v in out.items()})
                    odd["short_growth"] += 1
            sent = r["i"] + r["cw"]
            ps = (r["i"] * pin + (r["cw"] - r["w1"]) * p5 + r["w1"] * p1) / sent if sent else 0.0
            read_old = min(r["cr"], old)
            unsent_old = old - read_old
            tail = min(unsent_old, prev["i"]) if prev else 0   # the previous request's uncached tail, sent again
            for k, v in ctx.items():
                cost[k] += v / old * (read_old * pr + tail * ps)
            cost["rewrite"] += (unsent_old - tail) * ps
            tokens["rewrite"] += unsent_old - tail
            f_read = (r["cr"] - read_old) / grow if grow else 0.0
            for k, v in new.items():
                cost[k] += v * (f_read * pr + (1 - f_read) * ps)
                if k in ("initial", "results"):
                    tokens[k] += v
            cost["thinking"] += r["th"] * po
            cost["visible"] += (r["o"] - r["th"]) * po
            tokens["thinking"] += r["th"]
            tokens["visible"] += r["o"] - r["th"]
            ctx.update(new)
            prev = r
    return {"cost_usd": {k: cost[k] for k in PARTS}, "tokens": {k: round(tokens[k]) for k in PARTS},
            "total_usd": sum(cost.values()), "threads": len(threads), **odd}


def load_arm(spec: str, pricing: dict, mixed: bool = False):
    name, _, rest = spec.partition("=")
    sources, _, agent = rest.partition("@")
    runs = []
    for src in sources.split(","):
        if Path(src).is_dir():
            runs += report.load_runs([Path(src)])
            continue
        rep = json.loads(Path(src).read_text())
        want = {(r["task"], r["agent"], r["session_id"]) for r in rep["runs"]}
        got = [r for r in report.load_runs([BENCH / "runs" / s for s in rep["sessions"]])
               if (r["task"], r["agent"], r.get("session_id")) in want]
        if len(got) != len(want):
            sys.exit(f"{src}: {len(want) - len(got)} of its {len(want)} runs are not under {BENCH / 'runs'}")
        runs += got
    runs = [r for r in runs if (not agent or r.get("agent") == agent) and r.get("task") not in CONFIG.get("excluded_tasks", {})]
    agents = sorted({str(r.get("agent")) for r in runs})
    if len(agents) != 1:
        sys.exit(f"arm {name}: runs of agents {agents}; keep one with @AGENT")
    done = [r for r in runs if r.get("status") in report.EXECUTED]
    # an arm is one build: runs of several TokenForge builds or Claude Code versions are refused unless --mixed-versions
    versions = report.check_versions(done, mixed, f"arm {name}")
    for r in done:
        r["input_no_cache_tokens"] = sub(r.get("uncached_input_tokens"), r.get("cache_creation_input_tokens"))
        r["visible_output_tokens"] = sub(r.get("output_tokens"), r.get("thinking_tokens"))
        r["rest_cost_usd"] = sub(r.get("list_cost_usd"), r.get("first_request_cost_usd"))
        r["failure"], r["objective_j_usd"] = failure(r), objective(r, CONFIG.get("objective"))
        r["_att"] = attribute(Path(r["_dir"]), pricing)
        for part in PARTS:
            r[f"cost_{part}_usd"] = r["_att"]["cost_usd"][part] if r["_att"] else None
    meta = {"sources": sources.split(","), "agent": agents[0], "versions": versions,
            "provenance": report.provenance(versions),
            "not_executed": [[r.get("run_id"), r.get("status"), r.get("_session")] for r in runs if r not in done]}
    return name, meta, done


def frac(a, b):
    return round(a / b, 4) if b else None


def summarize_arm(meta: dict, runs: list) -> dict:
    total = lambda k, rs=runs: sum(r.get(k) or 0 for r in rs)   # noqa: E731
    cache = [(r.get("_tel") or {}).get("cache") or {} for r in runs]
    att = [r["_att"] for r in runs if r["_att"]]
    cold = [r for r in runs if r.get("first_request_cached_input_tokens") == 0]
    priced = [r for r in runs if None not in (r.get("list_cost_usd"), r.get("total_cost_usd_reported"))]
    nested = lambda r: ((r.get("_tel") or {}).get("tokens_exact", {}).get("nested_sessions") or {}).get("list_cost_usd") or 0   # noqa: E731
    off = [r["run_id"] for r in priced if abs(r["list_cost_usd"] - nested(r) - r["total_cost_usd_reported"])   # as report.py
           > report.COST_TOLERANCE * max(r["total_cost_usd_reported"], 1e-9)]
    att_off = [r["run_id"] for r in runs if r["_att"] and r.get("list_cost_usd") is not None
               and abs(r["_att"]["total_usd"] - r["list_cost_usd"]) > 1e-5]
    att_cost = {p: sum(a["cost_usd"][p] for a in att) for p in PARTS}
    shown = lambda v: json.dumps(v, sort_keys=True) if isinstance(v, (dict, list)) else str(v)   # noqa: E731
    return meta | {
        "runs": len(runs), "tasks": len({r["task"] for r in runs}),
        "build": {k: sorted({shown(r.get(k)) for r in runs}) for k in
                  ("claude_code_version", "token_forge_version", "token_forge_plugin_sha256", "_lean", "variant", "tf_env")},
        "metrics": {k: dist([r.get(k) for r in runs]) for k in METRICS},
        "cold_vs_warm": {
            "first_request_share_of_cost": frac(total("first_request_cost_usd"), total("list_cost_usd")),
            "runs_whose_first_request_read_no_cache": len(cold),
            "list_cost_usd_cold_start_runs": dist([r.get("list_cost_usd") for r in cold]),
            "list_cost_usd_warm_start_runs": dist([r.get("list_cost_usd") for r in runs if r not in cold]),
        },
        "cache": {
            "read_share_of_input": frac(total("cached_input_tokens"), total("input_tokens")),
            "write_tokens_by_ttl": {"5m": total("cache_creation_5m_input_tokens"), "1h": total("cache_creation_1h_input_tokens"),
                                    "unsplit": total("cache_creation_input_tokens") - total("cache_creation_5m_input_tokens")
                                    - total("cache_creation_1h_input_tokens")},
            "miss_requests": sum(c.get("miss_requests") or 0 for c in cache),
            "miss_rewrite_tokens": sum(c.get("miss_rewrite_tokens") or 0 for c in cache),
            "idle_gaps_over_300s": sum(c.get("idle_gaps_over_300s") or 0 for c in cache),
            "idle_seconds_max": max((c["idle_seconds_max"] for c in cache if c.get("idle_seconds_max") is not None), default=None),
            "transitions": sum(c.get("transitions") or 0 for c in cache),
            "method": "telemetry.json cache heuristics (miss rule, idle gaps), summed over runs",
        },
        "attribution": {"method": ATTRIBUTION, "runs": len(att), "unavailable": len(runs) - len(att),
                        "cost_usd": {p: r6(v) for p, v in att_cost.items()},
                        "share": {p: frac(v, sum(att_cost.values())) for p, v in att_cost.items()},
                        "tokens": {p: sum(a["tokens"][p] for a in att) for p in PARTS},
                        "context_shrinks": sum(a.get("context_shrinks", 0) for a in att),
                        "short_growth": sum(a.get("short_growth", 0) for a in att)},
        "quality": {
            "statuses": dict(Counter(r.get("status") for r in runs)),
            "quality_score": dist([r.get("quality_score") for r in runs]),
            "tests_passed": f"{sum(r.get('tests_passed') is True for r in runs)}/{len(runs)}",
            "hidden_tests_passed": f"{total('hidden_tests_passed')}/{total('hidden_tests_total')}",
            "runs_below_full_quality": [[r["run_id"], r.get("status"), r.get("quality_score")] for r in runs
                                        if r.get("status") != "completed" or (r.get("quality_score") or 0) < 100],
        },
        "validation": {
            "list_cost_reconciled_with_claude_code": f"{len(priced) - len(off)}/{len(priced)}", "not_reconciled": off,
            "attribution_sums_to_list_cost": f"{len(att) - len(att_off)}/{len(att)}", "attribution_off": att_off,
            "unavailable_metric_values": {k: v for k in METRICS if (v := sum(r.get(k) is None for r in runs))},
        },
    }


def paired(pairs):
    """NEW versus BASE over (base, new) per-task values."""
    if not pairs:
        return {"n": 0}
    b_sum, n_sum = sum(b for b, _ in pairs), sum(n for _, n in pairs)
    lower, higher = sum(n < b for b, n in pairs), sum(n > b for b, n in pairs)
    res = {"n": len(pairs), "base_sum": r6(b_sum), "new_sum": r6(n_sum),
           "pooled_change_percent": r6((n_sum / b_sum - 1) * 100) if b_sum else None,
           "per_task_change_percent": dist([(n / b - 1) * 100 for b, n in pairs if b]),
           "difference": interval([n - b for b, n in pairs]),
           "lower": lower, "higher": higher, "equal": len(pairs) - lower - higher,
           "sign_test_p": report.sign_test(lower, higher)}
    lr = interval([math.log(n / b) for b, n in pairs]) if all(b > 0 and n > 0 for b, n in pairs) else None
    if lr:
        g = lambda x: r6((math.exp(x) - 1) * 100)   # noqa: E731
        res["geo_mean_change_percent"] = {"estimate": g(lr["mean"]), "ci95": [g(lr["ci95"][0]), g(lr["ci95"][1])],
                                          "log_ratio_stdev": lr["stdev"]}
    return res


def compare(new: list, base: list) -> dict:
    nb, bb = defaultdict(list), defaultdict(list)
    for runs, g in ((new, nb), (base, bb)):
        for r in runs:
            g[r["task"]].append(r)
    tasks = sorted(set(nb) & set(bb))
    med = {t: {side: {k: report.med(g[t], k) for k in METRICS} for side, g in (("base", bb), ("new", nb))} for t in tasks}
    change = lambda b, n: r6((n / b - 1) * 100) if b and n is not None else None   # noqa: E731
    rows = [{"task": t, "category": nb[t][0].get("category"), "runs": {"base": len(bb[t]), "new": len(nb[t])},
             "base": {k: med[t]["base"][k] for k in ROW}, "new": {k: med[t]["new"][k] for k in ROW},
             "change_percent": {k: change(med[t]["base"][k], med[t]["new"][k]) for k in ROW if k != "quality_score"}}
            for t in tasks]
    return {
        "tasks_paired": len(tasks), "only_in_base": sorted(set(bb) - set(nb)), "only_in_new": sorted(set(nb) - set(bb)),
        "metrics": {k: paired([(m["base"][k], m["new"][k]) for m in med.values()
                               if m["base"][k] is not None and m["new"][k] is not None]) for k in METRICS},
        "cost_increases": sorted(({"task": x["task"], "base": x["base"]["list_cost_usd"], "new": x["new"]["list_cost_usd"],
                                   "change_percent": x["change_percent"]["list_cost_usd"]} for x in rows
                                  if (x["change_percent"]["list_cost_usd"] or 0) > 0), key=lambda x: -x["change_percent"]),
        "quality_drops": [{"task": x["task"], "base": x["base"]["quality_score"], "new": x["new"]["quality_score"]}
                          for x in rows if None not in (x["base"]["quality_score"], x["new"]["quality_score"])
                          and x["new"]["quality_score"] < x["base"]["quality_score"]],
        "per_task": rows,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-a", "--arm", action="append", required=True, metavar="NAME=SOURCE[,SOURCE...][@AGENT]")
    ap.add_argument("-p", "--pair", action="append", default=[], metavar="NEW:BASE")
    ap.add_argument("-o", "--out", required=True, type=Path)
    ap.add_argument("--mixed-versions", action="store_true",
                    help="allow an arm to hold runs of different TokenForge builds or Claude Code versions")
    args = ap.parse_args()
    pricing = CONFIG["pricing"]
    arms, runs = {}, {}
    for spec in args.arm:
        name, meta, runs[name] = load_arm(spec, pricing, args.mixed_versions)
        arms[name] = summarize_arm(meta, runs[name])
    comparisons = {}
    for spec in args.pair:
        new, _, base = spec.partition(":")
        comparisons[f"{new} vs {base}"] = {"new": new, "base": base, "new_versions": arms[new]["provenance"],
                                            "base_versions": arms[base]["provenance"]} | compare(runs[new], runs[base])
    args.out.write_text(json.dumps({"generated_by": "bench/scripts/optimization.py", "args": sys.argv[1:],
                                    "pricing": pricing, "objective": CONFIG.get("objective"), "definitions": DEFINITIONS,
                                    "arms": arms,
                                    "comparisons": comparisons}, indent=2) + "\n")
    for name, a in arms.items():
        m = a["metrics"]["list_cost_usd"]
        print(f"{name} [{a['provenance']}]: {a['runs']} runs, {a['tasks']} tasks, list cost mean ${m.get('mean')} median ${m.get('median')}, "
              f"J mean ${a['metrics']['objective_j_usd'].get('mean')}, "
              f"reconciled {a['validation']['list_cost_reconciled_with_claude_code']}, not executed {len(a['not_executed'])}")
    for name, c in comparisons.items():
        m = c["metrics"]["list_cost_usd"]
        g = m.get("geo_mean_change_percent") or {}
        print(f"{name} [{c['new_versions']} vs {c['base_versions']}]: {c['tasks_paired']} tasks, list cost {g.get('estimate')}% (95% CI {g.get('ci95')}), pooled "
              f"{m.get('pooled_change_percent')}%, lower/higher {m.get('lower')}/{m.get('higher')} p={m.get('sign_test_p')}, "
              f"quality drops {len(c['quality_drops'])}")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
