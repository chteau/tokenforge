"""Token and tool telemetry from Claude Code session transcripts.

Source of truth: every *.jsonl transcript under the run's isolated CLAUDE_CONFIG_DIR/projects/.
That includes the main session, its subagents (sidechains) and any nested `claude -p` sessions
(the PATH shim keeps those on disk). API requests are deduplicated by requestId, because a
transcript writes one entry per content block, each repeating the request's usage.

Everything labelled "exact" comes straight from API usage fields. Anything derived from text
length is reported under "estimated" and never mixed with exact numbers. Dollar figures apply the
list prices in benchmark.config.json "pricing" (dated assumptions, not provider data) to the exact
counts; a model without a configured price makes them null.
"""
from __future__ import annotations

import json
import re
import shlex
from collections import Counter, defaultdict
from datetime import datetime
from fnmatch import fnmatch
from pathlib import Path

VIEW_CMDS = {"cat", "head", "tail", "sed", "nl", "less", "more", "bat", "awk"}
SEARCH_CMDS = {"grep", "rg", "ag", "find", "fd", "git grep", "ack"}
SEARCH_TOOLS = {"Grep", "Glob", "ToolSearch", "LSP"}
MISS_TOLERANCE = 200   # tokens a request may read below the previous request's cached prefix without counting as a miss
TTL_5M_S = 300


def _usage_total(u: dict) -> dict:
    i = int(u.get("input_tokens") or 0)
    cw = int(u.get("cache_creation_input_tokens") or 0)
    cr = int(u.get("cache_read_input_tokens") or 0)
    o = int(u.get("output_tokens") or 0)
    return {"input_tokens": i, "cache_creation_input_tokens": cw, "cache_read_input_tokens": cr, "output_tokens": o}


def _cache_ttl(u: dict) -> tuple[int, int]:
    """(5-minute, 1-hour) cache-write tokens from usage.cache_creation; writes it does not split are unknown."""
    cc = u.get("cache_creation") or {}
    return int(cc.get("ephemeral_5m_input_tokens") or 0), int(cc.get("ephemeral_1h_input_tokens") or 0)


def _ctx(u: dict) -> int:
    return u["input_tokens"] + u["cache_creation_input_tokens"] + u["cache_read_input_tokens"]


def _ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _cost(r: dict, pricing: dict) -> float | None:
    """USD at the configured list prices. Writes without a TTL split are priced as 5-minute writes (the API default)."""
    u = r["usage"]
    p = pricing["usd_per_mtok"].get(r["model"])
    if p is None:
        return None if any(u.values()) else 0.0
    w5 = u["cache_creation_input_tokens"] - r["w1"]
    return (u["input_tokens"] * p["input"] + w5 * p["cache_write_5m"] + r["w1"] * p["cache_write_1h"]
            + u["cache_read_input_tokens"] * p["cache_read"] + u["output_tokens"] * p["output"]) / 1e6


def _cache_stats(reqs) -> dict:
    """Consecutive requests of one conversation thread (transcript file). A miss: the next request reads more than
    MISS_TOLERANCE tokens less from the cache than the previous one had cached (read + written) although its context
    did not shrink (compaction and cleared tool results shrink it); the shortfall is written again. Idle time runs
    from one request's first transcript entry to the next one's: how long the cached prefix waited for its next read."""
    threads = defaultdict(list)
    for r in reqs:
        threads[(r["file"], r["sidechain"])].append(r)
    misses = rewrite = 0
    idle = []
    for rs in threads.values():
        rs.sort(key=lambda r: r["ts"])
        for a, b in zip(rs, rs[1:]):
            ua, ub = a["usage"], b["usage"]
            cached = ua["cache_read_input_tokens"] + ua["cache_creation_input_tokens"]
            if ub["cache_read_input_tokens"] + MISS_TOLERANCE < cached and _ctx(ub) >= _ctx(ua):
                misses += 1
                rewrite += cached - ub["cache_read_input_tokens"]
            if a["ts"] and b["ts"]:
                idle.append((_ts(b["ts"]) - _ts(a["ts"])).total_seconds())
    return {"miss_requests": misses, "miss_rewrite_tokens": rewrite, "idle_seconds_max": round(max(idle), 1) if idle else None,
            f"idle_gaps_over_{TTL_5M_S}s": sum(x > TTL_5M_S for x in idle), "transitions": len(idle),
            "method": "derived from exact usage of consecutive requests per transcript; miss rule and idle times are heuristics"}


def summary(tel: dict) -> dict:
    """Run-level fields for the manifest; the report derives them the same way for runs recorded before they existed."""
    tx = tel["tokens_exact"]
    a, f, c = tx["all"], tx.get("first_request") or {}, tel.get("cache") or {}
    return {"list_cost_usd": a.get("list_cost_usd"), "price_weighted_tokens": a.get("price_weighted_tokens"),
            "cache_creation_5m_input_tokens": a.get("cache_creation_5m_input_tokens"),
            "cache_creation_1h_input_tokens": a.get("cache_creation_1h_input_tokens"),
            "thinking_tokens": a.get("thinking_tokens"),
            "first_request_cost_usd": f.get("list_cost_usd"), "first_request_cached_input_tokens": f.get("cached_input_tokens"),
            "first_request_thinking_tokens": f.get("thinking_tokens"),
            "cache_miss_rewrite_tokens": c.get("miss_rewrite_tokens"), "cache_idle_seconds_max": c.get("idle_seconds_max"),
            "hook_duration_ms": (tel.get("hooks") or {}).get("duration_ms_total")}


def iter_entries(config_dir: Path, sub="projects"):
    """Transcripts under CLAUDE_CONFIG_DIR/projects, or under a saved copy (sub="transcripts" of a run directory)."""
    for f in sorted(Path(config_dir, sub).rglob("*.jsonl")):
        with f.open(errors="replace") as fh:
            for line in fh:
                try:
                    yield f, json.loads(line)
                except ValueError:
                    continue


def quick_total(config_dir: Path) -> int:
    """Cheap running total (all token types) for the budget guard."""
    seen, total = set(), 0
    for _, d in iter_entries(config_dir):
        if d.get("type") != "assistant":
            continue
        m = d.get("message") or {}
        key = d.get("requestId") or m.get("id")
        if not key or key in seen or not m.get("usage"):
            continue
        seen.add(key)
        total += sum(_usage_total(m["usage"]).values())
    return total


def _result_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
    return ""


def _rel(path: str, workspace: str) -> str | None:
    if not path:
        return None
    p = path
    if p.startswith(workspace.rstrip("/") + "/"):
        p = p[len(workspace.rstrip("/")) + 1:]
    elif p.startswith("/"):
        return None  # outside the repo
    return p.lstrip("./") or None


def _bash_targets(cmd: str):
    """Heuristic: (kind, [paths]) for file-viewing / searching shell commands."""
    out = []
    cmd = cmd.split("<<", 1)[0]  # drop heredoc bodies
    for seg in re.split(r"\|\||&&|;|\||\n", cmd):
        if re.search(r"(^|\s)\d?>>?\s*\S", seg) and not re.search(r"2>&1|>\s*/dev/null", seg):
            continue  # output redirection: a write, not a read
        try:
            toks = shlex.split(seg)
        except ValueError:
            toks = seg.split()
        while toks and "=" in toks[0] and not toks[0].startswith("-"):
            toks = toks[1:]  # env assignments
        if not toks:
            continue
        exe = Path(toks[0]).name
        if exe in VIEW_CMDS:
            paths = [t for t in toks[1:] if not t.startswith("-") and ("/" in t or "." in t) and not re.match(r"^\d+(,\d+)?p$", t) and "{" not in t]
            out.append(("view", paths))
        elif exe in SEARCH_CMDS or (exe == "git" and len(toks) > 1 and toks[1] == "grep"):
            out.append(("search", []))
    return out


def parse(config_dir, workspace, main_session_id=None, relevant_globs=(), pricing=None, sub="projects"):
    config_dir = Path(config_dir)
    workspace = str(workspace)
    requests = {}            # key -> {usage, model, session, sidechain, ts}
    tool_uses = {}           # id -> {name, input, session, sidechain, ts, order}
    tool_results = {}        # tool_use_id -> text
    read_meta = {}           # tool_use_id -> toolUseResult file info
    hooks = []               # hook attachments
    skill_listing_chars = 0
    stop_hook_ms = 0         # Stop hooks report their duration in a system entry, not in an attachment
    sessions = set()
    order = 0
    for f, d in iter_entries(config_dir, sub):
        sid = d.get("sessionId") or d.get("session_id")
        if sid:
            sessions.add(sid)
        side = bool(d.get("isSidechain")) or "/subagents/" in str(f)
        t = d.get("type")
        if t == "assistant":
            m = d.get("message") or {}
            key = d.get("requestId") or m.get("id")
            if key and m.get("usage"):
                u = _usage_total(m["usage"])
                thinking = int((m["usage"].get("output_tokens_details") or {}).get("thinking_tokens") or 0)
                if key not in requests:
                    w5, w1 = _cache_ttl(m["usage"])
                    requests[key] = {"usage": u, "model": m.get("model"), "session": sid, "sidechain": side,
                                     "ts": d.get("timestamp", ""), "file": str(f), "w5": w5, "w1": w1, "thinking": thinking}
                else:
                    # the entries of one streamed response can log partial output counts (seen in subagent
                    # transcripts); the input and cache counts are the same on all of them
                    r = requests[key]
                    r["usage"]["output_tokens"] = max(r["usage"]["output_tokens"], u["output_tokens"])
                    r["thinking"] = max(r["thinking"], thinking)
            for c in m.get("content") or []:
                if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("id") not in tool_uses:
                    order += 1
                    tool_uses[c["id"]] = {"name": c.get("name"), "input": c.get("input") or {}, "session": sid,
                                          "sidechain": side, "ts": d.get("timestamp", ""), "order": order}
        elif t == "user":
            m = d.get("message") or {}
            content = m.get("content")
            if isinstance(content, list):
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "tool_result":
                        tool_results[c.get("tool_use_id")] = _result_text(c.get("content"))
                        if isinstance(d.get("toolUseResult"), dict) and "file" in d["toolUseResult"]:
                            read_meta[c.get("tool_use_id")] = d["toolUseResult"]["file"]
        elif t == "attachment":
            a = d.get("attachment") or {}
            if a.get("type", "").startswith("hook"):
                ctx, decision = "", None
                try:
                    hso = json.loads(a.get("stdout") or "{}").get("hookSpecificOutput") or {}
                    ctx = str(hso.get("additionalContext") or "")
                    if hso.get("updatedInput"):
                        decision = "rewrite"
                    elif hso.get("permissionDecision") in ("deny", "block"):
                        decision = "deny"
                except (ValueError, AttributeError):
                    pass
                hooks.append({"type": a.get("type"), "event": a.get("hookEvent"), "name": a.get("hookName"),
                              "content_chars": len(ctx) + len(str(a.get("content") or "")),
                              "stdout_chars": len(str(a.get("stdout") or "")), "decision": decision,
                              "ms": int(float(a.get("durationMs") or 0))})
            elif a.get("type") == "skill_listing":
                skill_listing_chars = max(skill_listing_chars, len(str(a.get("content") or "")))
        elif t == "system" and d.get("subtype") == "stop_hook_summary":
            stop_hook_ms += sum(int(h.get("durationMs") or 0) for h in d.get("hookInfos") or [])

    # ---- tokens (exact) ----
    def agg(reqs):
        tot = Counter()
        for r in reqs:
            tot.update(r["usage"])
        i, cw, cr, o = (tot["input_tokens"], tot["cache_creation_input_tokens"], tot["cache_read_input_tokens"], tot["output_tokens"])
        w5, w1 = sum(r["w5"] for r in reqs), sum(r["w1"] for r in reqs)
        costs = [_cost(r, pricing) for r in reqs] if pricing else [None]
        cost = None if None in costs else sum(costs)
        ref = pricing["usd_per_mtok"][pricing["reference_model"]]["input"] if pricing else None
        return {"requests": len(reqs), "input_tokens_total": i + cw + cr, "uncached_input_tokens": i + cw,
                "input_tokens_no_cache": i, "cache_creation_input_tokens": cw, "cached_input_tokens": cr,
                "output_tokens": o, "total_tokens": i + cw + cr + o,
                "thinking_tokens": sum(r["thinking"] for r in reqs),
                # legacy fixed weights (cache write 1.25x whatever its TTL, cache read 0.1x, output 5x), kept for old reports
                "input_equivalent_tokens": round(i + 1.25 * cw + 0.1 * cr + 5 * o),
                "cache_creation_5m_input_tokens": w5, "cache_creation_1h_input_tokens": w1,
                "cache_creation_ttl_unknown_input_tokens": cw - w5 - w1,
                "list_cost_usd": round(cost, 6) if cost is not None else None,
                # list cost in reference-model input tokens: TTL-aware price weights of the model that answered
                "price_weighted_tokens": round(cost / ref * 1e6) if cost is not None else None}

    reqs = list(requests.values())
    main = [r for r in reqs if r["session"] == main_session_id and not r["sidechain"]] if main_session_id else []
    side = [r for r in reqs if r["sidechain"]]
    nested = [r for r in reqs if main_session_id and r["session"] != main_session_id and not r["sidechain"]]
    by_model = defaultdict(list)
    for r in reqs:
        by_model[r["model"] or "unknown"].append(r)
    first = sorted(main or reqs, key=lambda r: r["ts"])[:1]
    first_ctx = _ctx(first[0]["usage"]) if first else None

    # ---- tools ----
    names = Counter(u["name"] for u in tool_uses.values())
    bash_view = bash_search = 0
    files_read_exact, files_read_heur = set(), set()
    lines_read = bytes_read = 0
    result_bytes = sum(len(t.encode()) for t in tool_results.values())
    reads_by_file = defaultdict(list)   # path -> [(order, lo, hi)]
    writes_by_file = defaultdict(list)  # path -> [order]
    tkit_cmds = 0
    for tid, u in sorted(tool_uses.items(), key=lambda kv: kv[1]["order"]):
        name, inp = u["name"], u["input"]
        res = tool_results.get(tid, "")
        if name == "Read":
            p = _rel(inp.get("file_path", ""), workspace)
            meta = read_meta.get(tid) or {}
            n = int(meta.get("numLines") or 0) or res.count("\n")
            lines_read += n
            bytes_read += len(res.encode())
            if p:
                files_read_exact.add(p); files_read_heur.add(p)
                lo = int(inp.get("offset") or meta.get("startLine") or 1)
                hi = lo + (int(inp.get("limit")) if inp.get("limit") else max(n, 1))
                reads_by_file[p].append((u["order"], lo, hi))
        elif name in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
            p = _rel(inp.get("file_path", ""), workspace)
            if p:
                writes_by_file[p].append(u["order"])
        elif name == "Bash":
            cmd = str(inp.get("command", ""))
            if re.search(r"\b(tkit|tmap|tforge)\b", cmd):
                tkit_cmds += 1
            targets = _bash_targets(cmd)
            views = [ps for k, ps in targets if k == "view" and ps]
            if views:
                bash_view += 1
                lines_read += res.count("\n")
                bytes_read += len(res.encode())
                for pth in (x for ps in views for x in ps):
                    rp = _rel(pth, workspace)
                    if rp:
                        files_read_heur.add(rp)
                        reads_by_file[rp].append((u["order"], 1, 10**9))
            if any(k == "search" for k, _ in targets):
                bash_search += 1

    redundant = 0
    for p, rs in reads_by_file.items():
        for k, (o2, lo2, hi2) in enumerate(rs):
            for o1, lo1, hi1 in rs[:k]:
                edited_between = any(o1 < w < o2 for w in writes_by_file.get(p, []))
                if not edited_between and lo2 < hi1 and lo1 < hi2:
                    redundant += 1
                    break

    def relevant(p):
        return any(fnmatch(p, g) for g in relevant_globs)
    rel_read = sorted(p for p in files_read_heur if relevant(p))
    total_calls = sum(names.values())
    tools = {
        "total_tool_calls": total_calls,
        "by_name": dict(names),
        "file_reads": names.get("Read", 0),
        "searches": sum(names.get(n, 0) for n in SEARCH_TOOLS),
        "bash_search_commands": bash_search,
        "bash_view_commands": bash_view,
        "shell_commands": names.get("Bash", 0),
        "edits": names.get("Edit", 0) + names.get("MultiEdit", 0),
        "writes": names.get("Write", 0),
        "subagent_calls": names.get("Agent", 0) + names.get("Task", 0),
        "skill_calls": names.get("Skill", 0),
        "other_tool_calls": total_calls - sum(names.get(n, 0) for n in
                                              ("Read", "Bash", "Edit", "MultiEdit", "Write", "Agent", "Task", "Skill", *SEARCH_TOOLS)),
        "tokenforge_cli_commands": tkit_cmds,
        "files_read": len(files_read_exact),
        "files_read_incl_bash_heuristic": len(files_read_heur),
        "lines_read": lines_read,
        "bytes_read": bytes_read,
        "tool_result_bytes": result_bytes,
        "redundant_reads": redundant,
        "relevant_files_read": len(rel_read),
        "irrelevant_files_read": len(files_read_heur) - len(rel_read),
        "context_precision_approx": round(len(rel_read) / len(files_read_heur), 3) if files_read_heur else None,
        "files_read_list": sorted(files_read_heur),
    }
    hook_events = Counter(h["event"] for h in hooks)
    injected = sum(h["content_chars"] for h in hooks if h["event"] in ("SessionStart", "UserPromptSubmit", "SubagentStart"))
    tokens = {"all": agg(reqs), "main": agg(main) if main_session_id else None, "subagents": agg(side),
              "nested_sessions": agg(nested), "by_model": {k: agg(v) for k, v in by_model.items()},
              "first_request_context_tokens": first_ctx,
              # cold start: what the run paid before its own cache existed (its prefix may be cached by earlier runs)
              "first_request": agg(first) if first else None}
    hook_ms = Counter()
    for h in hooks:
        hook_ms[h["event"]] += h["ms"]
    if stop_hook_ms:
        hook_ms["Stop"] += stop_hook_ms
    estimated = {"tool_result_tokens_est": round(result_bytes / 4),
                 "hook_injected_context_tokens_est": round(injected / 4),
                 "skill_listing_tokens_est": round(skill_listing_chars / 4),
                 "method": "UTF-8 bytes / 4; NOT exact"}
    return {"tokens_exact": tokens, "tools": tools, "cache": _cache_stats(reqs),
            "hooks": {"count": len(hooks), "by_event": dict(hook_events), "injected_context_chars": injected,
                      "tool_rewrites": sum(h["decision"] == "rewrite" for h in hooks),
                      "tool_denials": sum(h["decision"] == "deny" for h in hooks),
                      "duration_ms_total": sum(hook_ms.values()), "duration_ms_by_event": dict(hook_ms)},
            "estimated": estimated, "sessions": sorted(sessions)}
