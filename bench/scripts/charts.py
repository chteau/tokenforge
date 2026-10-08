#!/usr/bin/env python3
"""Render the README charts (docs/img/*.svg) from raw benchmark runs.

    python3 bench/scripts/charts.py

Selection, so anyone can check it: native = median of every completed native run per task; tokenforge = the
most recent completed run per task for each lean level, read from that run's environment_manifest.json.
Colors follow the entity in every chart: slot 1 (blue) clean Claude Code, slot 2 (orange) tokenforge balanced,
slot 3 (aqua) tokenforge ultra; dataviz reference palette, validated for light and dark surfaces (aqua is under
3:1 on light, so every bar carries a visible value label).
SVGs carry their own light/dark styles (prefers-color-scheme), so they follow the reader's GitHub theme.
"""
from __future__ import annotations

import json
import statistics as st
from pathlib import Path

BENCH = Path(__file__).resolve().parents[1]
OUT = BENCH.parent / "docs" / "img"
LABEL = {"cross-module-debug": "Cross-module debug (TS)", "rust-cli": "Rust CLI feature", "pr-review": "PR review (Go)",
         "architecture": "Architecture tracing (TS)", "rust-debug": "Rust debugging", "banking-transfers": "Scheduled transfers (TS)",
         "go-api": "Go REST endpoint", "go-feature": "Go scheduled notifications", "banking-web": "TS filters + CSV export",
         "refactor": "Rust refactor",
         "rust-tui": "Rust TUI (ratatui)", "vite-landing": "Vite front page", "go-mock-api": "Go mock REST API",
         "python-cli": "Python CLI", "ts-lib": "TypeScript library", "node-ssg": "Node static site gen",
         "luau-inventory": "Luau inventory (Roblox)", "cpp-cli": "C++ key-value store", "csharp-api": "C# loans API",
         "java-http": "Java URL shortener", "php-api": "PHP ticketing API", "swift-cli": "Swift cron tool",
         "dart-cli": "Dart habit tracker", "bash-tool": "Bash backup rotation", "c-cli": "C CSV query tool",
         "kotlin-cli": "Kotlin Markdown converter", "ruby-cli": "Ruby log analyzer"}
GREENFIELD = ["rust-tui", "vite-landing", "go-mock-api", "python-cli", "ts-lib", "node-ssg", "luau-inventory", "cpp-cli", "csharp-api",
              "java-http", "php-api", "swift-cli", "dart-cli", "bash-tool", "c-cli", "kotlin-cli"]
EXISTING = ["cross-module-debug", "rust-cli", "pr-review", "architecture", "rust-debug", "banking-transfers", "go-api", "go-feature", "banking-web", "refactor"]
BUILD = json.loads((BENCH / "environments" / "token-forge" / "manifest.json").read_text()).get("plugin_sha256")
# builds the config declares equivalent for the default comparison (same model context) count as the build under test
BUILDS = {BUILD, *json.loads((BENCH / "benchmark.config.json").read_text())["token_forge"].get("equivalent_builds", {})}
# Measured fixed context per request: first-request context of a one-word prompt in a git repo, settings written
# by `tforge lean <level>` (Claude Code 2.1.293, Opus 5.5).
FLOOR = [("off (Claude Code)", 16929), ("lean on", 11933), ("balanced (default)", 9738), ("lean max", 5755), ("lean ultra", 4401)]

STYLE = """<style>
  .bg{fill:#fcfcfb} .t1{fill:#0b0b0b} .t2{fill:#52514e} .mu{fill:#898781} .grid{stroke:#e1e0d9} .base{stroke:#c3c2b7}
  .s1{fill:#2a78d6} .s2{fill:#eb6834} .s3{fill:#1baf7a} .o{fill:#eb6834} .l1{stroke:#2a78d6} .l2{stroke:#eb6834} .a1{fill:#2a78d6;fill-opacity:.12} .a2{fill:#eb6834;fill-opacity:.16}
  @media (prefers-color-scheme: dark){
    .bg{fill:#1a1a19} .t1{fill:#ffffff} .t2{fill:#c3c2b7} .grid{stroke:#2c2c2a} .base{stroke:#383835}
    .s1{fill:#3987e5} .s2{fill:#d95926} .s3{fill:#199e70} .o{fill:#f08a5d} .l1{stroke:#3987e5} .l2{stroke:#d95926} .a1{fill:#3987e5} .a2{fill:#d95926}
  }
  text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
</style>"""


def runs():
    out = []
    for m in BENCH.glob("runs/*/*/*/manifest.json"):
        r = json.loads(m.read_text())
        if r.get("status") != "completed" or not r.get("total_tokens"):
            continue
        env = m.parent / "environment_manifest.json"
        r["lean"] = (json.loads(env.read_text()).get("token_forge_lean") if env.exists() else None) or "off"
        r["dir"] = m.parent
        out.append(r)
    return out


def bar_path(x, y, w, h, r=4):
    """Horizontal bar with rounded data end (right), square at the baseline (left)."""
    r = min(r, h / 2, w)
    return f"M{x},{y}h{w - r}a{r},{r} 0 0 1 {r},{r}v{h - 2 * r}a{r},{r} 0 0 1 {-r},{r}h{-(w - r)}z"


def fmt_k(n):
    return f"{n / 1e6:.2f}M" if n >= 1e6 else f"{n / 1e3:.0f}k"


def savings_chart(rs, levels):
    nat = {}
    for r in rs:
        if r["agent"] == "native":
            nat.setdefault(r["task"], []).append(r["total_tokens"])
    tf = {}
    for r in sorted(rs, key=lambda r: r.get("start_time") or ""):
        if r["agent"] == "token-forge" and r["lean"] in levels:
            tf[(r["task"], r["lean"])] = r
    tasks = [t for t in LABEL if t in nat and all((t, l) in tf for l in levels)]
    sav = {(t, l): 100 * (1 - tf[(t, l)]["total_tokens"] / st.median(nat[t])) for t in tasks for l in levels}
    tasks.sort(key=lambda t: -sav[(t, levels[0])])
    W, left, right, top = 760, 230, 70, 92
    bh, gap, group = 12, 2, 40
    H = top + group * len(tasks) + 56
    span = W - left - right
    x = lambda v: left + span * v / 80
    g = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" role="img" aria-label="Token savings per task versus clean Claude Code">', STYLE,
         f'<rect class="bg" width="{W}" height="{H}" rx="6"/>',
         '<text class="t1" x="24" y="34" font-size="17" font-weight="600">Fewer tokens than clean Claude Code, per task</text>',
         '<text class="t2" x="24" y="56" font-size="12.5">Total tokens saved (input, cache and output). Same task, repo and model (Opus 5.5); quality scored by hidden tests.</text>']
    lx = left
    cls = {"balanced": "s2", "ultra": "s3", "max": "s2", "on": "s2"}
    for l in levels:
        name = f"tokenforge, lean {l}{' (default)' if l == 'balanced' else ''}"
        g.append(f'<rect class="{cls[l]}" x="{lx}" y="68" width="12" height="12" rx="2"/><text class="t2" x="{lx + 18}" y="78.5" font-size="12.5">{name}</text>')
        lx += 30 + 7 * len(name)
    for v in range(0, 81, 20):
        g.append(f'<line class="grid" x1="{x(v):.1f}" y1="{top - 6}" x2="{x(v):.1f}" y2="{H - 44}" stroke-width="1"/>'
                 f'<text class="mu" x="{x(v):.1f}" y="{H - 28}" font-size="11.5" text-anchor="middle">{v}%</text>')
    for i, t in enumerate(tasks):
        y0 = top + i * group
        g.append(f'<text class="t1" x="{left - 12}" y="{y0 + bh + 5}" font-size="13" text-anchor="end">{LABEL[t]}</text>')
        for j, l in enumerate(levels):
            y = y0 + j * (bh + gap)
            v = max(0.0, sav[(t, l)])
            g.append(f'<path class="{cls[l]}" d="{bar_path(left, y, max(x(v) - left, 1), bh)}"><title>{LABEL[t]}, lean {l}: {sav[(t, l)]:.0f}% fewer tokens '
                     f'({fmt_k(tf[(t, l)]["total_tokens"])} vs {fmt_k(st.median(nat[t]))})</title></path>'
                     f'<text class="t2" x="{x(v) + 6:.1f}" y="{y + bh - 2}" font-size="11.5">{sav[(t, l)]:.0f}%</text>')
    g.append(f'<line class="base" x1="{left}" y1="{top - 6}" x2="{left}" y2="{H - 44}" stroke-width="1"/>')
    meds = " · ".join(f"lean {l}: median {st.median([sav[(t, l)] for t in tasks]):.0f}%" for l in levels)
    g.append(f'<text class="mu" x="24" y="{H - 10}" font-size="11.5">{meds}. One tokenforge run per task vs median of 1–3 native runs; single runs vary ~±20%.</text>')
    g.append("</svg>")
    return "\n".join(g), tasks, sav


def floor_chart():
    W, left, right, top = 760, 170, 80, 74
    bh, row = 18, 34
    H = top + row * len(FLOOR) + 40
    span = W - left - right
    mx = 18000
    x = lambda v: left + span * v / mx
    g = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" role="img" aria-label="Fixed context per request by lean level">', STYLE,
         f'<rect class="bg" width="{W}" height="{H}" rx="6"/>',
         '<text class="t1" x="24" y="34" font-size="17" font-weight="600">Fixed context re-sent with every request</text>',
         '<text class="t2" x="24" y="56" font-size="12.5">Tool and skill definitions Claude Code sends on every call, by tokenforge lean level (measured, tokens).</text>']
    for v in range(0, mx + 1, 4000):
        g.append(f'<line class="grid" x1="{x(v):.1f}" y1="{top - 8}" x2="{x(v):.1f}" y2="{H - 30}" stroke-width="1"/>'
                 f'<text class="mu" x="{x(v):.1f}" y="{H - 14}" font-size="11.5" text-anchor="middle">{v // 1000}k</text>')
    for i, (name, v) in enumerate(FLOOR):
        y = top + i * row
        cls = "s1" if i == 0 else ("s3" if "ultra" in name else "s2")
        g.append(f'<text class="t1" x="{left - 12}" y="{y + bh - 4}" font-size="13" text-anchor="end">{name}</text>'
                 f'<path class="{cls}" d="{bar_path(left, y, x(v) - left, bh)}"><title>{name}: {v:,} tokens per request</title></path>'
                 f'<text class="t2" x="{x(v) + 6:.1f}" y="{y + bh - 4}" font-size="12">{v / 1000:.1f}k{"" if i == 0 else f"  (−{100 * (1 - v / FLOOR[0][1]):.0f}%)"}</text>')
    g.append(f'<line class="base" x1="{left}" y1="{top - 8}" x2="{left}" y2="{H - 30}" stroke-width="1"/>')
    g.append("</svg>")
    return "\n".join(g)


def context_points(run):
    """Context size of each main-thread API request, in order."""
    seen, pts = set(), []
    for f in sorted((run["dir"] / "transcripts").rglob("*.jsonl")):
        if "/subagents/" in str(f):
            continue
        for line in f.open():
            d = json.loads(line)
            if d.get("type") != "assistant":
                continue
            m = d.get("message") or {}
            k = d.get("requestId") or m.get("id")
            u = m.get("usage")
            if not k or k in seen or not u:
                continue
            seen.add(k)
            pts.append(u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0) + u.get("cache_read_input_tokens", 0))
    return pts


def curve_chart(rs, task, level):
    nat = sorted((r for r in rs if r["agent"] == "native" and r["task"] == task), key=lambda r: r["total_tokens"])
    nat = nat[len(nat) // 2]  # the median native run
    tf = sorted((r for r in rs if r["agent"] == "token-forge" and r["task"] == task and r["lean"] == level), key=lambda r: r.get("start_time") or "")[-1]
    series = [("clean Claude Code", context_points(nat), nat["total_tokens"]), (f"tokenforge, lean {level}", context_points(tf), tf["total_tokens"])]
    W, left, right, top, bottom = 760, 64, 150, 76, 48
    H = 360
    pw, ph = W - left - right, H - top - bottom
    n = max(len(s[1]) for s in series)
    ymax = 100000 * (int(max(max(s[1]) for s in series) / 100000) + 1)
    X = lambda i: left + pw * i / max(n - 1, 1)
    Y = lambda v: top + ph * (1 - v / ymax)
    g = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" role="img" aria-label="Context re-read per request">', STYLE,
         f'<rect class="bg" width="{W}" height="{H}" rx="6"/>',
         f'<text class="t1" x="24" y="34" font-size="17" font-weight="600">Every request re-reads the whole context</text>',
         f'<text class="t2" x="24" y="56" font-size="12.5">{LABEL[task]}: context size of each API request. The area under a line is what the session costs.</text>']
    for v in range(0, ymax + 1, ymax // 4):
        g.append(f'<line class="grid" x1="{left}" y1="{Y(v):.1f}" x2="{left + pw}" y2="{Y(v):.1f}" stroke-width="1"/>'
                 f'<text class="mu" x="{left - 8}" y="{Y(v) + 4:.1f}" font-size="11.5" text-anchor="end">{v // 1000}k</text>')
    for i in range(0, n, 5 if n > 12 else 2):
        g.append(f'<text class="mu" x="{X(i):.1f}" y="{top + ph + 18}" font-size="11.5" text-anchor="middle">{i + 1}</text>')
    g.append(f'<text class="mu" x="{left + pw / 2}" y="{H - 10}" font-size="11.5" text-anchor="middle">API request #</text>')
    for k, (name, pts, total) in enumerate(series, start=1):
        line = " ".join(f"{X(i):.1f},{Y(v):.1f}" for i, v in enumerate(pts))
        area = f"{X(0):.1f},{Y(0):.1f} {line} {X(len(pts) - 1):.1f},{Y(0):.1f}"
        g.append(f'<polygon class="a{k}" points="{area}" opacity=".18"/>'
                 f'<polyline class="l{k}" points="{line}" fill="none" stroke-width="2" stroke-linejoin="round"><title>{name}: {len(pts)} requests, {fmt_k(total)} tokens</title></polyline>')
        lx, ly = X(len(pts) - 1), Y(pts[-1])
        g.append(f'<circle class="s{k}" cx="{lx:.1f}" cy="{ly:.1f}" r="4" stroke-width="2" style="stroke:var(--bg,#fcfcfb)"/>'
                 f'<text class="t1" x="{lx + 10:.1f}" y="{ly - 4:.1f}" font-size="12.5" font-weight="600">{name}</text>'
                 f'<text class="t2" x="{lx + 10:.1f}" y="{ly + 12:.1f}" font-size="11.5">{fmt_k(total)} total, {len(pts)} requests</text>')
    g.append(f'<line class="base" x1="{left}" y1="{Y(0):.1f}" x2="{left + pw}" y2="{Y(0):.1f}" stroke-width="1"/>')
    g.append("</svg>")
    return "\n".join(g)


def hero_chart(rs):
    """Headline chart: per task, clean Claude Code vs tokenforge default and ultra, log token scale, direct labels."""
    import math
    nat = {}
    for r in rs:
        if r["agent"] == "native":
            nat.setdefault(r["task"], []).append(r["total_tokens"])
    tf = {}
    for r in sorted(rs, key=lambda r: r.get("start_time") or ""):
        if r["agent"] == "token-forge" and not r.get("variant") and r["lean"] in ("balanced", "ultra"):
            tf[(r["task"], r["lean"])] = r["total_tokens"]
    tasks = sorted((t for t in LABEL if t in nat and (t, "balanced") in tf and (t, "ultra") in tf), key=lambda t: st.median(nat[t]))
    W, H, left, right, top, bottom = 1120, 700, 96, 150, 150, 92
    pw, ph = W - left - right, H - top - bottom
    lo, hi = math.log10(50_000), math.log10(4_000_000)
    Y = lambda v: top + ph * (1 - (math.log10(v) - lo) / (hi - lo))
    X = lambda i: left + pw * (i + 0.5) / len(tasks)
    pct = lambda a, b: 100 * (1 - b / a)
    meds = {l: st.median([pct(st.median(nat[t]), tf[(t, l)]) for t in tasks]) for l in ("balanced", "ultra")}
    g = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" role="img" aria-label="Total tokens per task: clean Claude Code versus tokenforge">', STYLE,
         '<style>.hd{font-size:30px;font-weight:700;letter-spacing:-.4px} .big{font-size:21px;font-weight:700} .dash{stroke-dasharray:5 5}'
         ' .ring{fill:none;stroke-width:2} .l3{stroke:#1baf7a} @media (prefers-color-scheme: dark){.l3{stroke:#199e70}}</style>',
         f'<rect class="bg" width="{W}" height="{H}" rx="10"/>',
         '<text class="t1 hd" x="40" y="58">Same tasks, far fewer tokens</text>',
         f'<text class="t2" x="40" y="88" font-size="15">total tokens per task (log scale) · clean Claude Code → tokenforge · Opus 5.5 · quality scored by hidden tests · default median −{meds["balanced"]:.0f}%, ultra −{meds["ultra"]:.0f}%</text>']
    for v, lab in [(50_000, "50k"), (100_000, "100k"), (200_000, "200k"), (500_000, "500k"), (1_000_000, "1M"), (2_000_000, "2M"), (4_000_000, "4M")]:
        g.append(f'<line class="grid" x1="{left}" y1="{Y(v):.1f}" x2="{left + pw}" y2="{Y(v):.1f}" stroke-width="1"/>'
                 f'<text class="mu" x="{left - 14}" y="{Y(v) + 5:.1f}" font-size="14" text-anchor="end">{lab}</text>')
    g.append(f'<text class="mu" x="22" y="{top + ph / 2:.0f}" font-size="13" transform="rotate(-90 22 {top + ph / 2:.0f})" text-anchor="middle">total tokens (log scale)</text>')
    # legend, inside the plot, top left
    for k, (cls, name) in enumerate([("s1", "clean Claude Code (median of 1–3 runs)"), ("s2", "tokenforge, default (balanced)"), ("s3", "tokenforge, lean ultra")]):
        y = top + 4 + 26 * k
        g.append(f'<circle class="{cls}" cx="{left + 22}" cy="{y}" r="6"/><text class="t1" x="{left + 36}" y="{y + 5}" font-size="15">{name}</text>')
    for i, t in enumerate(tasks):
        x, n, d, u = X(i), st.median(nat[t]), tf[(t, "balanced")], tf[(t, "ultra")]
        yn, yd, yu = Y(n), Y(d), Y(u)
        g.append(f'<line class="l2 dash" x1="{x:.1f}" y1="{yn:.1f}" x2="{x:.1f}" y2="{max(yd, yu):.1f}" stroke-width="1.6"/>')
        # clean Claude Code: label above
        g.append(f'<circle class="s1" cx="{x:.1f}" cy="{yn:.1f}" r="7"><title>{LABEL[t]}: clean Claude Code {fmt_k(n)}</title></circle>'
                 f'<text class="t1" x="{x:.1f}" y="{yn - 30:.1f}" font-size="15" font-weight="600" text-anchor="middle">{LABEL[t]}</text>'
                 f'<text class="mu" x="{x:.1f}" y="{yn - 13:.1f}" font-size="13" text-anchor="middle">{fmt_k(n)} tokens</text>')
        # tokenforge default: ringed point with the big number
        g.append(f'<circle class="s2" cx="{x:.1f}" cy="{yd:.1f}" r="7"><title>{LABEL[t]}: tokenforge default {fmt_k(d)} ({pct(n, d):.0f}% fewer)</title></circle>'
                 f'<circle class="ring l2" cx="{x:.1f}" cy="{yd:.1f}" r="11"/>'
                 f'<text class="big o" x="{x + 18:.1f}" y="{yd + 2:.1f}">−{pct(n, d):.0f}%</text>'
                 f'<text class="mu" x="{x + 18:.1f}" y="{yd + 19:.1f}" font-size="13">{fmt_k(d)} default</text>')
        # ultra: smaller point, label only if it doesn't collide with the default label
        g.append(f'<circle class="s3" cx="{x:.1f}" cy="{yu:.1f}" r="5"><title>{LABEL[t]}: tokenforge ultra {fmt_k(u)} ({pct(n, u):.0f}% fewer)</title></circle>')
        if abs(yu - yd) > 30:
            g.append(f'<text class="t2" x="{x + 14:.1f}" y="{yu + 5:.1f}" font-size="13">ultra −{pct(n, u):.0f}%</text>')
        else:
            g.append(f'<text class="t2" x="{x + 18:.1f}" y="{yd + 36:.1f}" font-size="13">ultra −{pct(n, u):.0f}%</text>')
    g.append(f'<text class="mu" x="40" y="{H - 26}" font-size="13">One tokenforge run per task against the median of 1–3 clean runs; single runs vary about ±20%. Raw data: bench/reports/. Regenerate: python3 bench/scripts/charts.py</text>')
    g.append("</svg>")
    return "\n".join(g)


def final_chart(rs, tasks, title, subtitle):
    """Clean Claude Code (median) vs tokenforge default of the build under test (median), log scale, direct labels."""
    import math
    nat, tf = {}, {}
    for r in rs:
        if r["agent"] == "native":
            nat.setdefault(r["task"], []).append(r["total_tokens"])
        elif (r["agent"] == "token-forge" and not r.get("variant") and r["lean"] == "balanced"
              and r.get("token_forge_plugin_sha256") in BUILDS):
            tf.setdefault(r["task"], []).append(r["total_tokens"])
    tasks = sorted((t for t in tasks if t in nat and t in tf), key=lambda t: st.median(nat[t]))
    if not tasks:
        return None, {}
    if len(tasks) > 12:
        return final_rows(tasks, nat, tf, title, subtitle)
    W, H, left, right, top, bottom = 1240, 760, 96, 110, 150, 170
    pw, ph = W - left - right, H - top - bottom
    vals = [v for t in tasks for v in (st.median(nat[t]), st.median(tf[t]))]
    lo = math.log10(min(vals) * 0.6); hi = math.log10(max(vals) * 1.6)
    Y = lambda v: top + ph * (1 - (math.log10(v) - lo) / (hi - lo))
    X = lambda i: left + pw * (i + 0.5) / len(tasks)
    sav = {t: 100 * (1 - st.median(tf[t]) / st.median(nat[t])) for t in tasks}
    g = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" role="img" aria-label="{title}">', STYLE,
         '<style>.hd{font-size:30px;font-weight:700;letter-spacing:-.4px} .big{font-size:21px;font-weight:700} .dash{stroke-dasharray:5 5} .ring{fill:none;stroke-width:2}</style>',
         f'<rect class="bg" width="{W}" height="{H}" rx="10"/>',
         f'<text class="t1 hd" x="40" y="58">{title}</text>',
         f'<text class="t2" x="40" y="88" font-size="15">{subtitle} · median −{st.median(sav.values()):.0f}% · {sum(v > 0 for v in sav.values())}/{len(tasks)} tasks cheaper</text>']
    for v, lab in [(50_000, "50k"), (100_000, "100k"), (200_000, "200k"), (500_000, "500k"), (1_000_000, "1M"), (2_000_000, "2M"), (4_000_000, "4M")]:
        if lo <= math.log10(v) <= hi:
            g.append(f'<line class="grid" x1="{left}" y1="{Y(v):.1f}" x2="{left + pw}" y2="{Y(v):.1f}" stroke-width="1"/>'
                     f'<text class="mu" x="{left - 14}" y="{Y(v) + 5:.1f}" font-size="14" text-anchor="end">{lab}</text>')
    g.append(f'<text class="mu" x="22" y="{top + ph / 2:.0f}" font-size="13" transform="rotate(-90 22 {top + ph / 2:.0f})" text-anchor="middle">total tokens (log scale)</text>')
    for k, (cls, name) in enumerate([("s1", "clean Claude Code"), ("s2", "tokenforge (default)")]):
        y = top + 4 + 26 * k
        g.append(f'<circle class="{cls}" cx="{left + 22}" cy="{y}" r="6"/><text class="t1" x="{left + 36}" y="{y + 5}" font-size="15">{name}</text>')
    for i, t in enumerate(tasks):
        x, n, d = X(i), st.median(nat[t]), st.median(tf[t])
        yn, yd = Y(n), Y(d)
        up = d > n
        row = 46 if i % 2 else 0  # two alternating rows of axis labels: names never collide
        g.append(f'<line class="l2 dash" x1="{x:.1f}" y1="{yn:.1f}" x2="{x:.1f}" y2="{yd:.1f}" stroke-width="1.6"/>'
                 f'<line class="grid" x1="{x:.1f}" y1="{top + ph + 4:.1f}" x2="{x:.1f}" y2="{top + ph + 10 + row:.1f}" stroke-width="1"/>'
                 f'<circle class="s1" cx="{x:.1f}" cy="{yn:.1f}" r="7"><title>{LABEL[t]}: clean Claude Code {fmt_k(n)}</title></circle>'
                 f'<text class="t1" x="{x:.1f}" y="{top + ph + 26 + row:.1f}" font-size="14" font-weight="600" text-anchor="middle">{LABEL[t]}</text>'
                 f'<text class="mu" x="{x:.1f}" y="{top + ph + 43 + row:.1f}" font-size="12.5" text-anchor="middle">{fmt_k(n)} → {fmt_k(d)}</text>'
                 f'<circle class="s2" cx="{x:.1f}" cy="{yd:.1f}" r="7"><title>{LABEL[t]}: tokenforge {fmt_k(d)} ({sav[t]:.0f}% fewer)</title></circle>'
                 f'<circle class="ring l2" cx="{x:.1f}" cy="{yd:.1f}" r="11"/>'
                 f'<text class="big o" x="{x + 16:.1f}" y="{yd + (-14 if up else 26):.1f}">{"+" if up else "−"}{abs(sav[t]):.0f}%</text>')
    g.append(f'<text class="mu" x="40" y="{H - 26}" font-size="13">Medians of 1–3 runs per side, Opus 5.5, quality from hidden tests; single runs vary about ±20%. Raw data: bench/reports/. Regenerate: python3 bench/scripts/charts.py</text>')
    g.append("</svg>")
    return "\n".join(g), sav



def final_rows(tasks, nat, tf, title, subtitle):
    """Same comparison as final_chart, one row per task (for many tasks): log-scale x, labels left, savings right."""
    import math
    tasks = sorted(tasks, key=lambda t: st.median(tf[t]) / st.median(nat[t]))
    sav = {t: 100 * (1 - st.median(tf[t]) / st.median(nat[t])) for t in tasks}
    rowh, top, bottom, left, right, W = 38, 150, 84, 330, 110, 1240
    H = top + rowh * len(tasks) + bottom
    pw = W - left - right
    vals = [v for t in tasks for v in (st.median(nat[t]), st.median(tf[t]))]
    lo = math.log10(min(vals) * 0.8); hi = math.log10(max(vals) * 1.25)
    X = lambda v: left + pw * (math.log10(v) - lo) / (hi - lo)
    g = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" role="img" aria-label="{title}">', STYLE,
         '<style>.hd{font-size:30px;font-weight:700;letter-spacing:-.4px} .big{font-size:17px;font-weight:700} .ring{fill:none;stroke-width:2}</style>',
         f'<rect class="bg" width="{W}" height="{H}" rx="10"/>',
         f'<text class="t1 hd" x="40" y="58">{title}</text>',
         f'<text class="t2" x="40" y="88" font-size="15">{subtitle} · median −{st.median(sav.values()):.0f}% · {sum(v > 0 for v in sav.values())}/{len(tasks)} tasks cheaper</text>']
    for k, (cls, name) in enumerate([("s1", "clean Claude Code"), ("s2", "tokenforge (default)")]):
        x = 40 + 210 * k
        g.append(f'<circle class="{cls}" cx="{x + 6}" cy="118" r="6"/><text class="t1" x="{x + 20}" y="123" font-size="15">{name}</text>')
    bot = top + rowh * len(tasks)
    for v, lab in [(50_000, "50k"), (100_000, "100k"), (200_000, "200k"), (500_000, "500k"), (1_000_000, "1M"), (2_000_000, "2M"), (4_000_000, "4M")]:
        if lo <= math.log10(v) <= hi:
            g.append(f'<line class="grid" x1="{X(v):.1f}" y1="{top - 6}" x2="{X(v):.1f}" y2="{bot}" stroke-width="1"/>'
                     f'<text class="mu" x="{X(v):.1f}" y="{bot + 20}" font-size="13" text-anchor="middle">{lab}</text>')
    g.append(f'<text class="mu" x="{left + pw / 2:.0f}" y="{bot + 40}" font-size="13" text-anchor="middle">total tokens (log scale)</text>')
    for i, t in enumerate(tasks):
        y = top + rowh * i + rowh / 2
        n, d = st.median(nat[t]), st.median(tf[t])
        up = d > n
        g.append(f'<text class="t1" x="{left - 18}" y="{y - 1:.1f}" font-size="14.5" font-weight="600" text-anchor="end">{LABEL[t]}</text>'
                 f'<text class="mu" x="{left - 18}" y="{y + 14:.1f}" font-size="12" text-anchor="end">{fmt_k(n)} → {fmt_k(d)}</text>'
                 f'<line class="l2" x1="{X(n):.1f}" y1="{y:.1f}" x2="{X(d):.1f}" y2="{y:.1f}" stroke-width="2"/>'
                 f'<circle class="s1" cx="{X(n):.1f}" cy="{y:.1f}" r="6.5"><title>{LABEL[t]}: clean Claude Code {fmt_k(n)}</title></circle>'
                 f'<circle class="s2" cx="{X(d):.1f}" cy="{y:.1f}" r="6.5"><title>{LABEL[t]}: tokenforge {fmt_k(d)}</title></circle>'
                 f'<text class="big o" x="{W - 40}" y="{y + 6:.1f}" text-anchor="end">{"+" if up else "−"}{abs(sav[t]):.0f}%</text>')
    g.append(f'<text class="mu" x="40" y="{H - 22}" font-size="13">Medians of 1–3 runs per side, Opus 5.5, quality from hidden tests; single runs vary about ±20%. Raw data: bench/reports/. Regenerate: python3 bench/scripts/charts.py</text>')
    g.append("</svg>")
    return "\n".join(g), sav

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rs = runs()
    for name, tasks, title, sub in [("bench-existing.svg", EXISTING, "Existing codebases: features, bugs, reviews", "total tokens per task, clean Claude Code → tokenforge"),
                                    ("bench-greenfield.svg", GREENFIELD, f"From scratch: {len(GREENFIELD)} projects, 15 languages", "total tokens to build each project, clean Claude Code → tokenforge")]:
        svg, sav = final_chart(rs, tasks, title, sub)
        if svg:
            (OUT / name).write_text(svg)
            print(name, {k: round(v) for k, v in sav.items()})
    (OUT / "bench-floor.svg").write_text(floor_chart())
    (OUT / "bench-context.svg").write_text(curve_chart(rs, "rust-cli", "balanced"))
    for old in ("bench-savings.svg", "bench-hero.svg"):
        (OUT / old).unlink(missing_ok=True)  # earlier charts mixed builds; only final-build charts are drawn now
    print("wrote", ", ".join(p.name for p in sorted(OUT.glob("bench-*.svg"))))


if __name__ == "__main__":
    main()
