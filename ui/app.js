// tokenforge dashboard. Plain ES modules, no dependencies, no network beyond this local server.
import { LANG, renderGraph } from './graph.js';
import { MEM_TYPES, renderMemGraph } from './memgraph.js';

const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
const tip = $('#tip');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const compact = (n) => {
  n = Number(n) || 0;
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K';
  return String(Math.round(n));
};
const comma = (n) => Math.round(n).toLocaleString('en-US');
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dateTime = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function until(ms) {
  const d = Math.max(0, ms - Date.now());
  const h = Math.floor(d / 3.6e6);
  const m = Math.round((d % 3.6e6) / 6e4);
  return h >= 48 ? `${Math.round(h / 24)} days` : h ? `${h} h ${m} min` : `${m} min`;
}
function ago(sec) {
  const d = Date.now() / 1000 - sec;
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} days ago`;
}
const shortPath = (p) => String(p).replace(/^\/home\/[^/]+/, '~');
const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || p;

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// ---------- tooltip ----------
function showTip(html, ev) {
  tip.innerHTML = html;
  tip.hidden = false;
  const pad = 14;
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => (tip.hidden = true);

// ---------- icons (16px, currentColor) ----------
const ICON = {
  bolt: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M9 1L3 9h4l-1 6 6-8H8z"/></svg>',
  week: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h12v2H2zM2 7h12v7H2zM5 1h2v3H5zM9 1h2v3H9z"/></svg>',
  month: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1 13h14v2H1zM2 8h3v4H2zM6.5 4h3v8h-3zM11 6h3v6h-3z"/></svg>',
  clock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>',
};

// ---------- chart helpers ----------
const SVG = 'http://www.w3.org/2000/svg';
function el(name, attrs = {}, parent) {
  const n = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
const legend = (series) => `<div class="legend">${series.map((s) => `<span><i style="background:var(${s.color})"></i>${esc(s.label)}</span>`).join('')}</div>`;
function table(cols, rows) {
  return `<div class="scroll"><table><thead><tr>${cols.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.html ? c.html(r[c.key], r) : esc(c.fmt ? c.fmt(r[c.key], r) : r[c.key])}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

// Card body with a Chart/Table toggle: every chart has its data as rows too.
function chartCard(container, { title, sub, render, tableHtml }) {
  container.innerHTML = `<button class="toggle">Table</button><h2>${esc(title)}</h2><p class="sub">${sub || ''}</p><div class="body"></div>`;
  const body = $('.body', container);
  let asTable = false;
  const draw = () => {
    body.innerHTML = '';
    if (asTable) body.innerHTML = tableHtml();
    else render(body);
  };
  $('.toggle', container).addEventListener('click', (e) => {
    asTable = !asTable;
    e.target.textContent = asTable ? 'Chart' : 'Table';
    draw();
  });
  draw();
  return draw;
}

function axes(svg, { W, H, m, max }) {
  const ph = H - m.t - m.b;
  for (let i = 0; i <= 4; i++) {
    const y = m.t + ph - (ph * i) / 4;
    el('line', { class: i ? 'grid' : 'base', x1: m.l, x2: W - m.r, y1: y, y2: y }, svg);
    el('text', { x: m.l - 8, y: y + 4, 'text-anchor': 'end' }, svg).textContent = compact((max * i) / 4);
  }
}

// Stacked columns, square ends, 2px surface gap between segments.
function stackedColumns(body, { items, series, xLabel, height = 240, tipTitle, showLegend = true }) {
  body.innerHTML = showLegend ? legend(series) : '';
  const W = Math.max(280, body.clientWidth);
  const H = height;
  const m = { l: 46, r: 6, t: 8, b: 24 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const totals = items.map((it) => series.reduce((a, s) => a + (it[s.key] || 0), 0));
  const max = niceMax(Math.max(...totals, 1));
  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' }, body);
  axes(svg, { W, H, m, max });
  const band = pw / items.length;
  const bw = Math.min(16, Math.max(3, band * 0.55));
  const labelEvery = Math.ceil(items.length / Math.max(1, Math.floor(pw / 56)));
  items.forEach((it, i) => {
    const x0 = m.l + i * band;
    const hl = el('rect', { class: 'hl', x: x0, y: m.t, width: band, height: ph, fill: 'transparent' }, svg);
    let y = m.t + ph;
    series.filter((s) => (it[s.key] || 0) > 0).forEach((s, si) => {
      const h = ((it[s.key] || 0) / max) * ph;
      const gap = si > 0 ? 2 : 0;
      y -= h;
      if (h - gap > 0) el('rect', { x: x0 + (band - bw) / 2, y: y + gap, width: bw, height: h - gap, fill: `var(${s.color})` }, svg);
    });
    if (i % labelEvery === 0) el('text', { x: x0 + band / 2, y: H - 6, 'text-anchor': 'middle' }, svg).textContent = xLabel(it);
    const hit = el('rect', { class: 'hit', x: x0, y: m.t, width: band, height: ph }, svg);
    hit.addEventListener('mousemove', (ev) => {
      hl.classList.add('on');
      const rows = series
        .slice()
        .reverse()
        .map((s) => `<tr><td><span class="k" style="background:var(${s.color})"></span>${esc(s.label)}</td><td class="num">${compact(it[s.key] || 0)}</td></tr>`)
        .join('');
      showTip(`<b>${esc(tipTitle(it))}</b><table>${rows}${series.length > 1 ? `<tr><td>Total</td><td class="num"><b>${compact(totals[i])}</b></td></tr>` : ''}</table>`, ev);
    });
    hit.addEventListener('mouseleave', () => {
      hl.classList.remove('on');
      hideTip();
    });
  });
}

// Thin ivory sticks on an inset panel (single series, like an activity strip).
function sticks(body, { items, value, xLabel, tipHtml, height = 170 }) {
  body.innerHTML = '';
  const inset = document.createElement('div');
  inset.className = 'inset';
  body.appendChild(inset);
  const W = Math.max(240, inset.clientWidth - 24);
  const H = height;
  const m = { l: 38, r: 4, t: 6, b: 20 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const max = niceMax(Math.max(...items.map(value), 1));
  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' }, inset);
  axes(svg, { W, H, m, max });
  const band = pw / Math.max(1, items.length);
  const labelEvery = Math.ceil(items.length / Math.max(1, Math.floor(pw / 48)));
  items.forEach((it, i) => {
    const h = (value(it) / max) * ph;
    const x = m.l + i * band + band / 2;
    el('rect', { x: x - 1.5, y: m.t + ph - h, width: 3, height: h, fill: 'var(--ivory)' }, svg);
    if (i % labelEvery === 0) el('text', { x, y: H - 4, 'text-anchor': 'middle' }, svg).textContent = xLabel(it);
    const hit = el('rect', { class: 'hit', x: m.l + i * band, y: m.t, width: band, height: ph }, svg);
    hit.addEventListener('mousemove', (ev) => showTip(tipHtml(it), ev));
    hit.addEventListener('mouseleave', hideTip);
  });
}

// Area line with a gradient wash, crosshair and nearest-point tooltip.
let gradId = 0;
function areaChart(body, { points, x, y, xLabel, tipHtml, height = 220, color = '--s1', markers = [] }) {
  body.innerHTML = '';
  const W = Math.max(280, body.clientWidth);
  const H = height;
  const m = { l: 46, r: 12, t: 12, b: 24 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const xs = points.map(x);
  const ys = points.map(y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const max = niceMax(Math.max(...ys, 1));
  const sx = (v) => m.l + (x1 === x0 ? pw / 2 : ((v - x0) / (x1 - x0)) * pw);
  const sy = (v) => m.t + ph - (v / max) * ph;
  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' }, body);
  const id = `g${++gradId}`;
  const defs = el('defs', {}, svg);
  const lg = el('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el('stop', { offset: '0%', 'stop-color': `var(${color})`, 'stop-opacity': 0.42 }, lg);
  el('stop', { offset: '100%', 'stop-color': `var(${color})`, 'stop-opacity': 0 }, lg);
  axes(svg, { W, H, m, max });
  const ticks = Math.min(6, points.length);
  for (let i = 0; i < ticks; i++) {
    const p = points[Math.round((i * (points.length - 1)) / Math.max(1, ticks - 1))];
    el('text', { x: sx(x(p)), y: H - 6, 'text-anchor': 'middle' }, svg).textContent = xLabel(p);
  }
  if (!points.length) return;
  // Smooth with horizontal-tangent cubic segments: no overshoot above the data's own extremes.
  let d = `M${sx(xs[0])},${sy(ys[0])}`;
  for (let i = 1; i < points.length; i++) {
    const mx = (sx(xs[i - 1]) + sx(xs[i])) / 2;
    d += `C${mx},${sy(ys[i - 1])} ${mx},${sy(ys[i])} ${sx(xs[i])},${sy(ys[i])}`;
  }
  el('path', { d: `${d}L${sx(x1)},${m.t + ph}L${sx(x0)},${m.t + ph}Z`, fill: `url(#${id})` }, svg);
  el('path', { d, fill: 'none', stroke: `var(${color})`, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  for (const mk of markers) {
    const p = points[mk.index];
    if (!p) continue;
    el('circle', { cx: sx(x(p)), cy: sy(y(p)), r: 4, fill: `var(${color})`, stroke: 'var(--surface-1)', 'stroke-width': 2 }, svg);
    el('text', { x: sx(x(p)) + (mk.anchor === 'end' ? -8 : 8), y: sy(y(p)) - 9, 'text-anchor': mk.anchor || 'start', style: 'fill:var(--text-secondary)' }, svg).textContent = mk.label;
  }
  const cross = el('line', { x1: 0, x2: 0, y1: m.t, y2: m.t + ph, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' }, svg);
  const dot = el('circle', { r: 4, fill: `var(${color})`, stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden' }, svg);
  const hit = el('rect', { class: 'hit', x: m.l, y: m.t, width: pw, height: ph }, svg);
  hit.addEventListener('mousemove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(sx(xs[i]) - px) < Math.abs(sx(xs[best]) - px)) best = i;
    const p = points[best];
    cross.setAttribute('x1', sx(x(p)));
    cross.setAttribute('x2', sx(x(p)));
    dot.setAttribute('cx', sx(x(p)));
    dot.setAttribute('cy', sy(y(p)));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('visibility', 'visible');
    showTip(tipHtml(p, best), ev);
  });
  hit.addEventListener('mouseleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    hideTip();
  });
}

// 270-degree arc gauge.
function gauge({ pct, label, sub, color }) {
  const r = 70;
  const c = 2 * Math.PI * r;
  const arc = c * 0.75;
  const p = Math.max(0, Math.min(100, pct));
  return `<svg width="190" height="170" viewBox="0 0 190 170" role="img" aria-label="${esc(label)} ${Math.round(p)}%">
    <g transform="rotate(135 95 95)">
      <circle cx="95" cy="95" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="10" stroke-dasharray="${arc} ${c}"/>
      <circle cx="95" cy="95" r="${r}" fill="none" stroke="var(${color})" stroke-width="10" stroke-dasharray="${(arc * p) / 100} ${c}"/>
    </g>
    <text x="95" y="96" text-anchor="middle" class="gauge-num">${Math.round(p)}%</text>
    <text x="95" y="118" text-anchor="middle" class="gauge-cap">${esc(sub)}</text>
  </svg>`;
}

const TOKEN_SERIES = [
  { key: 'wInput', label: 'Input', color: '--s1' },
  { key: 'wCw', label: 'Cache write ×1.25', color: '--s2' },
  { key: 'wCr', label: 'Cache read ×0.1', color: '--s3' },
  { key: 'wOut', label: 'Output ×5', color: '--s4' },
];
const weighted = (r) => ({ ...r, wInput: r.input, wCw: r.cw * 1.25, wCr: r.cr * 0.1, wOut: r.out * 5 });

function header(crumbs, title) {
  $('#crumb').innerHTML = crumbs.map((c) => (c.href ? `<a href="${c.href}">${esc(c.label)}</a>` : esc(c.label))).join(' / ');
  $('#title').textContent = title;
  document.title = `${title} · tokenforge`;
}
const kpiCard = (label, value, extra, icon) =>
  `<div class="card kpi"><div class="txt"><div class="label">${esc(label)}</div><div class="value">${value}<small>${extra || ''}</small></div></div>${icon ? `<div class="badge">${ICON[icon]}</div>` : ''}</div>`;

// ---------- overview ----------
function limitGauge(label, w) {
  const used = Math.max(0, Math.min(100, w.used));
  const [color, text] = used >= 90 ? ['--critical', 'Near the limit'] : used >= 70 ? ['--warning', 'Getting close'] : ['--good', 'Plenty left'];
  const at = w.resetsAt * 1000;
  return `<div class="card"><h2>${esc(label)}</h2><p class="sub">Resets ${at - Date.now() < 86400e3 ? 'at ' + clock(at) : dateTime(at)}</p>
    <div class="gauge-wrap">${gauge({ pct: used, label, sub: `resets in ${until(at)}`, color })}
    <div class="gauge-foot"><span>0%</span><span>used</span><span>100%</span></div>
    <span class="state"><i style="background:var(${color})"></i>${text}</span></div></div>`;
}

function windowGauge(b) {
  const pct = b ? ((Date.now() - b.start) / (b.end - b.start)) * 100 : 0;
  return `<div class="card"><h2>5-hour window</h2><p class="sub">${b ? 'Estimated from your sessions' : 'No window active'}</p>
    <div class="gauge-wrap">${gauge({ pct, label: 'Window elapsed', sub: b ? `resets in ${until(b.end)}` : 'idle', color: '--s1' })}
    <div class="gauge-foot"><span>${b ? clock(b.start) : '-'}</span><span>elapsed</span><span>${b ? clock(b.end) : '-'}</span></div>
    <span class="state">Shows time elapsed, not usage. Exact limits: <code>tforge statusline --setup</code></span></div></div>`;
}

// Same estimate as the status line (lib/estimate.mjs), in raw tokens, for sessions the status line has seen today.
function savedLead(e) {
  if (!e || !(e.saved > 0)) return '';
  const parts = [e.fixed && `lean tools ${compact(e.fixed)}`, e.tools && `tkit ${compact(e.tools)}`, e.answers && `answer cache ${compact(e.answers)}`].filter(Boolean).join(', ');
  return `<div class="lead"><b>TokenForge today: ~${Math.round(e.pct * 100)}% fewer tokens</b> (~${compact(e.saved)} saved: ${parts}). An estimate, from sessions shown in your status line.</div>`;
}

async function overviewView() {
  header([{ label: 'Pages' }, { label: 'Overview' }], 'Overview');
  // Savings are optional: an older server without the route must not break the overview.
  const noSavings = { totals: Object.fromEntries(['today', 'd7', 'd30', 'all'].map((k) => [k, { calls: 0, raw: 0, out: 0, saved: 0 }])), tools: [], daily: [] };
  const [o, sv] = await Promise.all([api('/api/overview'), api('/api/savings').catch(() => noSavings)]);
  const cur = o.limits.current;
  const fresh = cur && Date.now() - cur.at < 6 * 3600e3 && (cur.fiveHour || cur.sevenDay);
  $('#side-card').hidden = Boolean(fresh);
  const b = o.activeBlock;
  const gauges = fresh ? `${cur.fiveHour ? limitGauge('5-hour limit', cur.fiveHour) : ''}${cur.sevenDay ? limitGauge('Weekly limit', cur.sevenDay) : ''}` : windowGauge(b);
  view.innerHTML = `
    <div id="health-banner"></div>
    <div class="grid cols-4">
      ${kpiCard('Today', compact(o.totals.today.weq), `${comma(o.totals.today.calls)} calls`, 'bolt')}
      ${kpiCard('Last 7 days', compact(o.totals.d7.weq), `${comma(o.totals.d7.calls)} calls`, 'week')}
      ${kpiCard('Last 30 days', compact(o.totals.d30.weq), `${comma(o.totals.d30.calls)} calls`, 'month')}
      ${kpiCard('This 5-hour window', b ? compact(b.weq) : '0', b ? `resets ~${clock(b.end)}` : 'idle', 'clock')}
    </div>
    <div class="grid cols-2" style="margin-top:18px">
      <div class="card hero">
        <div><div class="eyebrow">Input-equivalent tokens today</div><div class="big">${compact(o.totals.today.weq)}</div>
        <div class="lead">Every call re-reads the whole conversation, so cost grows with turns × context. Cache reads count 0.1×, cache writes 1.25×, output 5×.</div>${savedLead(sv.estimate)}</div>
        <div class="foot">${b ? `Window ${clock(b.start)} to ${clock(b.end)}: ${comma(b.calls)} calls so far` : 'No calls in the last 5 hours'}${o.models[0] ? ` · mostly ${esc(o.models[0].model.replace(/^claude-/, ''))}` : ''}</div>
      </div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">${gauges}</div>
    </div>
    <div class="grid cols-3-1" style="margin-top:18px"><div class="card" id="daily"></div><div class="card" id="blocks"></div></div>
    <div class="grid cols-3-1" style="margin-top:18px"><div class="card" id="saved"></div><div class="card" id="savedTools"></div></div>
    <div class="grid cols-3-1" style="margin-top:18px"><div class="card" id="hourly"></div><div class="card" id="models"></div></div>`;
  healthBanner($('#health-banner'));
  const st = sv.totals;
  const pct = (t) => (t.raw ? ` · ${Math.round((100 * t.saved) / t.raw)}% of raw` : '');
  const drawSaved = chartCard($('#saved'), {
    title: 'Tokens saved by tkit',
    sub: `Today ${compact(st.today.saved)} · 7 days ${compact(st.d7.saved)} · 30 days ${compact(st.d30.saved)}${pct(st.d30)} · all time ${compact(st.all.saved)}. Raw output the tools read for the model minus what they printed, at about 4 bytes per token. Not counted: fewer turns, terse replies.`,
    render: (bd) =>
      st.all.calls
        ? sticks(bd, { items: sv.daily, value: (d) => d.saved, xLabel: (d) => d.day.slice(5), tipHtml: (d) => `<b>${new Date(d.day + 'T12:00').toDateString()}</b><br>${compact(d.saved)} tokens saved · ${comma(d.calls)} tkit calls` })
        : (bd.innerHTML = '<p class="sub">No tkit calls recorded yet. Savings appear after the first <code>tkit check</code>, <code>tkit test</code>, <code>tkit diff</code>, ...</p>'),
    tableHtml: () => table([{ key: 'day', label: 'Day' }, { key: 'calls', label: 'tkit calls', num: true, fmt: comma }, { key: 'saved', label: 'Saved', num: true, fmt: compact }], sv.daily.filter((d) => d.calls).reverse()),
  });
  const maxT = Math.max(1, ...sv.tools.map((x) => x.saved));
  $('#savedTools').innerHTML = `<h2>By tool</h2><p class="sub">Last 30 days</p>${table(
    [
      { key: 'tool', label: 'Tool' },
      { key: 'calls', label: 'Calls', num: true, fmt: comma },
      { key: 'saved', label: 'Saved', num: true, html: (v) => `${compact(v)}<span class="pbar"><span style="width:${(100 * v) / maxT}%"></span></span>` },
    ],
    sv.tools,
  )}`;
  const daily = o.daily.map(weighted);
  const drawDaily = chartCard($('#daily'), {
    title: 'Daily usage',
    sub: 'Last 30 days · input-equivalent tokens by type',
    render: (bd) => stackedColumns(bd, { items: daily, series: TOKEN_SERIES, xLabel: (d) => d.day.slice(5), tipTitle: (d) => new Date(d.day + 'T12:00').toDateString() }),
    tableHtml: () => table([{ key: 'day', label: 'Day' }, { key: 'calls', label: 'Calls', num: true, fmt: comma }, { key: 'input', label: 'Input', num: true, fmt: compact }, { key: 'cw', label: 'Cache write', num: true, fmt: compact }, { key: 'cr', label: 'Cache read', num: true, fmt: compact }, { key: 'out', label: 'Output', num: true, fmt: compact }, { key: 'weq', label: 'Input-equiv', num: true, fmt: compact }], daily.slice().reverse()),
  });
  const bl = o.blocks;
  const peak = bl.reduce((a, x) => (x.weq > (a?.weq ?? -1) ? x : a), null);
  const drawBlocks = chartCard($('#blocks'), {
    title: '5-hour windows',
    sub: 'Last 7 days · estimated from timestamps',
    render: (bd) => {
      sticks(bd, { items: bl, value: (x) => x.weq, xLabel: (x) => new Date(x.start).toLocaleDateString([], { weekday: 'short' }), tipHtml: (x) => `<b>${dateTime(x.start)} to ${clock(x.end)}</b><br>${compact(x.weq)} input-equiv · ${comma(x.calls)} calls` });
      const tot = bl.reduce((a, x) => a + x.weq, 0);
      const avg = tot / Math.max(1, bl.length);
      const mini = (label, v, pct, color) => `<div class="mini"><div class="k"><i><b style="background:var(${color})"></b></i>${label}</div><div class="v">${v}</div><div class="bar"><span style="width:${pct}%;background:var(${color})"></span></div></div>`;
      bd.insertAdjacentHTML('beforeend', `<div class="minis">${mini('Windows', bl.length, 100, '--s1')}${mini('Busiest', peak ? compact(peak.weq) : '0', 100, '--s2')}${mini('Average', compact(avg), peak ? (100 * avg) / Math.max(1, peak.weq) : 0, '--s3')}</div>`);
    },
    tableHtml: () => table([{ key: 'start', label: 'Window', fmt: (v, r) => `${dateTime(v)} to ${clock(r.end)}` }, { key: 'calls', label: 'Calls', num: true, fmt: comma }, { key: 'weq', label: 'Input-equiv', num: true, fmt: compact }], bl.slice().reverse()),
  });
  const drawHourly = chartCard($('#hourly'), {
    title: 'Last 48 hours',
    sub: 'Input-equivalent tokens per hour',
    render: (bd) => areaChart(bd, { points: o.hourly, x: (p) => p.hour, y: (p) => p.weq, xLabel: (p) => clock(p.hour * 1000), tipHtml: (p) => `<b>${dateTime(p.hour * 1000)}</b><br>${compact(p.weq)} input-equiv · ${comma(p.calls)} calls` }),
    tableHtml: () => table([{ key: 'hour', label: 'Hour', fmt: (v) => dateTime(v * 1000) }, { key: 'calls', label: 'Calls', num: true, fmt: comma }, { key: 'weq', label: 'Input-equiv', num: true, fmt: compact }], o.hourly.filter((h) => h.calls).reverse()),
  });
  const models = o.models.filter((x) => !x.model.startsWith('<'));
  const maxM = Math.max(1, ...models.map((x) => x.weq));
  $('#models').innerHTML = `<h2>Models</h2><p class="sub">Last 30 days</p>${table(
    [
      { key: 'model', label: 'Model', fmt: (v) => v.replace(/^claude-/, '') },
      { key: 'weq', label: 'Input-equiv', num: true, html: (v) => `${compact(v)}<span class="pbar"><span style="width:${(100 * v) / maxM}%"></span></span>` },
    ],
    models,
  )}`;
  return () => {
    drawDaily();
    drawBlocks();
    drawSaved();
    drawHourly();
  };
}

// ---------- projects ----------
// One line on the overview when something needs attention; details and switches live in Settings.
async function healthBanner(slot) {
  try {
    const h = await api('/api/health');
    const warn = h.issues.filter((i) => i.level === 'warn');
    if (warn.length) slot.innerHTML = `<a class="banner" href="#/settings"><b>${warn.length} issue${warn.length > 1 ? 's' : ''}</b> ${esc(warn[0].text.split(':')[0])}. Open Settings</a>`;
  } catch {}
}

// Measured fixed context per request (Claude Code 2.1.293) and what each level removes.
const LEAN = [
  { id: 'off', ctx: '16.9k', what: 'Claude Code as installed.' },
  { id: 'on', ctx: '11.9k', what: 'Hides agent-orchestration tools: Workflow, Monitor, Cron, RemoteTrigger, SendMessage, worktrees, NotebookEdit. Compacts 1M-context sessions at 400k tokens instead of near 1M.' },
  { id: 'balanced', ctx: '9.7k', what: 'Default. Also hides Claude Code\'s built-in skills from Claude; you can still type them. Your own skills, subagents and web stay.' },
  { id: 'max', ctx: '5.8k', what: 'Also hides the Skill tool, subagents, web tools and Claude Code\'s git instructions. Slash commands you type still work. Compacts at 300k.' },
  { id: 'ultra', ctx: '4.4k', what: 'Also hides Read/Edit/Write; Claude reads and edits files with Bash. No image or PDF viewing. Compacts at 200k.' },
];

async function settingsView() {
  header([{ label: 'Pages' }, { label: 'Settings' }], 'Settings');
  const h = await api('/api/health');
  const on = h.sessions.filter((s) => s.tokenforge).length;
  const color = { warn: '--warning', info: '--s2', tip: '--muted' };
  view.innerHTML = `
    <div class="card"><h2>Health</h2>
      <p class="sub">tokenforge ${esc(h.pluginVersion)} · ${on}/${h.sessions.length} sessions in the last 24 h loaded it · Claude Code ${esc(h.claudeCodeVersions.join(', ') || '?')}</p>
      ${h.issues.length ? `<ul class="issues">${h.issues.map((i) => `<li style="border-left:3px solid var(${color[i.level] || '--muted'})">${esc(i.text)}</li>`).join('')}</ul>` : (h.sessions.length ? '<p class="sub">All recent sessions run tokenforge; no stale hooks.</p>' : '<p class="sub">No Claude Code sessions in the last 24 h yet.</p>')}
    </div>
    <div class="card" style="margin-top:18px"><h2>Lean tools</h2>
      <p class="sub">Every request re-sends the definition of every enabled tool. Fewer tools, less fixed context on every call. Applies to sessions started afterwards. Writes only tokenforge's own deny entries in your Claude Code settings.</p>
      <div class="levels">${LEAN.map((l) => `<button class="level ${l.id === h.lean.level ? 'active' : ''}" data-lean="${l.id}"><span class="lv-name">${l.id}</span><span class="lv-ctx">${l.ctx}<small> per request</small></span><span class="lv-what">${esc(l.what)}</span></button>`).join('')}</div>
    </div>
    ${h.lean.level === 'balanced' ? `<div class="card" style="margin-top:18px"><h2>Built-in skills Claude may use on its own</h2>
      <p class="sub">Under Balanced, Claude Code's built-in skills are hidden from Claude (about 115 tokens each, per request) but stay available as slash commands you type. Tick the ones Claude should still pick up by itself. Your own and plugin skills are never hidden.</p>
      <div class="skills">${h.builtinSkills.map((s) => `<label><input type="checkbox" data-skill="${esc(s)}" ${h.lean.skillsKeep.includes(s) ? 'checked' : ''}> ${esc(s)}</label>`).join('')}</div>
    </div>` : ''}
    <div class="card" style="margin-top:18px" id="ctxdiag"><h2>Skills and MCP servers</h2><p class="sub">Checking…</p></div>
    <div class="card" style="margin-top:18px"><h2>Terse replies</h2>
      <p class="sub">Shorter prose between tool calls and in final answers. Code and anything written to files keep their normal style.</p>
      <div class="levels small">${[['full', 'Status lines and 1–3 line answers.'], ['lite', 'Short full sentences.'], ['off', 'Claude\'s normal style.']].map(([id, what]) => `<button class="level ${id === h.terse ? 'active' : ''}" data-terse="${id}"><span class="lv-name">${id}</span><span class="lv-what">${what}</span></button>`).join('')}</div>
    </div>`;
  contextCard(view.querySelector('#ctxdiag'));
  const post = async (body) => {
    await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    settingsView();
  };
  view.querySelectorAll('[data-lean]').forEach((b) => b.addEventListener('click', () => post({ lean: b.dataset.lean })));
  view.querySelectorAll('[data-terse]').forEach((b) => b.addEventListener('click', () => post({ terse: b.dataset.terse })));
  view.querySelectorAll('[data-skill]').forEach((c) =>
    c.addEventListener('change', () => post({ skillsKeep: [...view.querySelectorAll('[data-skill]:checked')].map((x) => x.dataset.skill) })),
  );
}

// Skills and MCP servers are listed in every request: show the wordy and the unused ones.
async function contextCard(slot) {
  try {
    const [d, cmds] = await Promise.all([api('/api/context'), api('/api/commands').catch(() => [])]);
    const long = d.skills.filter((s) => s.tokens > d.longTokens);
    const idle = d.skills.filter((s) => !s.uses);
    const mcpIdle = d.mcps.filter((m) => !m.uses);
    const row = (a, b, c) => `<tr><td>${esc(a)}</td><td class="num">${b}</td><td class="num">${c}</td></tr>`;
    const table = (head, rows) => (rows.length ? `<div class="scroll"><table><thead><tr><th>${head[0]}</th><th class="num">${head[1]}</th><th class="num">${head[2]}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<p class="sub">None.</p>');
    slot.innerHTML = `<h2>Skills and MCP servers</h2>
      <p class="sub">Each skill's name and description, and each MCP server's tools, are re-sent on every request. Based on the last ${d.days} days (${d.sessions} sessions). Shorten the description in its SKILL.md, or remove what nothing calls.</p>
      <h3>Long skill descriptions (over ${d.longTokens} tokens)</h3>${table(['Skill', 'Tokens', 'Calls'], long.map((s) => row(s.name, s.tokens, s.uses)))}
      <h3>Skills never called (${idle.length} of ${d.skills.length})</h3>${table(['Skill', 'Tokens', 'Calls'], idle.map((s) => row(s.name, s.tokens, 0)))}
      <h3>Shell commands by result cost (60 newest sessions)</h3>${table(['Command', 'Est. tokens', 'Calls'], cmds.map((c) => row(c.cmd, comma(c.estTokens), c.calls)))}
      <h3>MCP servers never called (${mcpIdle.length} of ${d.mcps.length})</h3>${table(['Server', 'Scope', 'Calls'], mcpIdle.map((m) => row(m.name, esc(m.scope), 0)))}`;
  } catch {
    slot.innerHTML = '<h2>Skills and MCP servers</h2><p class="sub">Could not read them.</p>';
  }
}

async function projectsView() {
  header([{ label: 'Pages' }, { label: 'Projects' }], 'Projects');
  const ps = await api('/api/projects');
  const maxW = Math.max(1, ...ps.map((p) => p.weq));
  view.innerHTML = `<div class="card"><h2>Projects</h2><p class="sub"><b>${ps.length}</b> folders Claude Code ran in, newest first. Agent worktrees count toward their repo.</p>
  <div class="scroll"><table><thead><tr><th>Project</th><th class="num">Sessions</th><th class="num">Calls</th><th class="num">Subagent share</th><th class="num">Input-equiv</th><th>Last active</th></tr></thead><tbody>${ps
    .map(
      (p) => `<tr class="click" data-p="${esc(p.project)}"><td class="path" title="${esc(p.project)}"><b>${esc(baseName(p.project))}</b> <span class="muted">${esc(shortPath(p.project))}</span></td><td class="num">${comma(p.sessions)}</td><td class="num">${comma(p.calls)}</td><td class="num">${p.weq ? Math.round((100 * p.subWeq) / p.weq) : 0}%</td><td class="num">${compact(p.weq)}<span class="pbar"><span style="width:${(100 * p.weq) / maxW}%"></span></span></td><td>${ago(p.last)}</td></tr>`,
    )
    .join('')}</tbody></table></div></div>`;
  view.querySelectorAll('tr[data-p]').forEach((tr) => tr.addEventListener('click', () => (location.hash = `#/project/${encodeURIComponent(tr.dataset.p)}`)));
}

async function projectView(project) {
  header([{ label: 'Projects', href: '#/projects' }, { label: baseName(project) }], baseName(project));
  const [ss, forge] = await Promise.all([api(`/api/sessions?project=${encodeURIComponent(project)}`), api(`/api/forge?project=${encodeURIComponent(project)}`)]);
  const weq = ss.reduce((a, s) => a + s.weq, 0);
  const sub = ss.reduce((a, s) => a + s.subWeq, 0);
  view.innerHTML = `<div class="grid cols-4">${kpiCard('Sessions', comma(ss.length))}${kpiCard('Input-equiv', compact(weq))}${kpiCard('Subagent share', `${weq ? Math.round((100 * sub) / weq) : 0}%`)}<a class="card kpi" href="#/map/${encodeURIComponent(project)}" style="text-decoration:none"><div class="txt"><div class="label">Code graph</div><div class="value">Open →</div></div></a></div>
    <div class="card" style="margin-top:18px"><h2>Sessions</h2><p class="sub">Average context is what each call re-reads. A high average means the session should have been split. Click a row for its context curve.</p><div id="stable"></div></div>
    <div class="card" id="snaps" style="margin-top:18px"></div>
    <div class="card" id="forge" style="margin-top:18px"></div>`;
  snapshotsCard($('#snaps'), project).catch((e) => ($('#snaps').innerHTML = `<h2>Snapshots</h2><p class="sub">Could not load: ${esc(e.message)}</p>`));
  $('#stable').innerHTML = `<div class="scroll"><table><thead><tr><th>Started</th><th class="num">Calls</th><th class="num">Avg context</th><th class="num">Peak</th><th class="num">Subagents</th><th class="num">Input-equiv</th></tr></thead><tbody>${ss
    .map((s) => `<tr class="click" data-s="${esc(s.session)}"><td>${dateTime(s.start * 1000)}</td><td class="num">${comma(s.calls)}</td><td class="num">${compact(s.avgCtx)}</td><td class="num">${compact(s.peakCtx)}</td><td class="num">${s.subagents}</td><td class="num">${compact(s.weq)}</td></tr>`)
    .join('')}</tbody></table></div>`;
  view.querySelectorAll('tr[data-s]').forEach((tr) => tr.addEventListener('click', () => (location.hash = `#/session/${encodeURIComponent(tr.dataset.s)}`)));
  const f = $('#forge');
  if (!forge.present) f.innerHTML = `<h2>tforge</h2><p class="sub">No forge plan in this project yet. <code>/tokenforge:forge</code> plans and runs multi-file builds with small workers.</p>`;
  else {
    const cost = forge.attempts.reduce((a, r) => a + (r.costUsd || 0), 0);
    f.innerHTML = `<h2>tforge: ${esc(forge.goal || '')}</h2><p class="sub"><b>${forge.tasks.filter((t) => t.status === 'done').length}/${forge.tasks.length}</b> tasks done · ${forge.attempts.length} worker attempts · $${cost.toFixed(3)}</p>${table(
      [{ key: 'id', label: 'Task' }, { key: 'model', label: 'Model' }, { key: 'status', label: 'Status' }, { key: 'costUsd', label: 'Cost', num: true, fmt: (v) => '$' + Number(v).toFixed(3) }],
      forge.tasks,
    )}`;
  }
}

// Session snapshots (.forge/snapshots/): one row per chunk, newest first; the top two are what /clear reloads.
async function snapshotsCard(card, project) {
  const q = `project=${encodeURIComponent(project)}`;
  const list = await api(`/api/snapshots?${q}`);
  if (!list.length) {
    card.innerHTML = `<h2>Snapshots</h2><p class="sub">None yet. After every reply the checkpoint hook saves the session in chunks to <code>.forge/snapshots/</code>; <code>/clear</code> reloads the newest two.</p>`;
    return;
  }
  const when = (iso) => (iso ? dateTime(Date.parse(iso)) : '?');
  card.innerHTML = `<h2>Snapshots</h2><p class="sub"><b>${list.length}</b> chunks, newest first. The two marked <b>reload</b> are injected after <code>/clear</code>. Click a row to read it.</p>
  <div class="scroll"><table><thead><tr><th>Chunk</th><th>Session</th><th>From</th><th>To</th><th class="num">Requests</th><th class="num">Files</th><th class="num">Context</th></tr></thead><tbody>${list
    .map(
      (s, i) =>
        `<tr class="click" data-f="${esc(s.file)}"><td>#${esc(s.n ?? '?')}${i < 2 ? ' <span class="pill">reload</span>' : ''}</td><td class="muted">${esc(String(s.sid || '').slice(0, 8))}</td><td>${when(s.start)}</td><td>${when(s.end)}</td><td class="num">${comma(s.prompts || 0)}</td><td class="num">${comma(s.files || 0)}</td><td class="num">${compact(s.ctx || 0)}</td></tr><tr class="snap-body" hidden><td colspan="7"><pre></pre></td></tr>`,
    )
    .join('')}</tbody></table></div>`;
  card.querySelectorAll('tr[data-f]').forEach((tr) =>
    tr.addEventListener('click', async () => {
      const row = tr.nextElementSibling;
      row.hidden = !row.hidden;
      const pre = $('pre', row);
      if (!row.hidden && !pre.textContent) pre.textContent = (await api(`/api/snapshot?${q}&file=${encodeURIComponent(tr.dataset.f)}`)).body || '(empty)';
    }),
  );
}

async function sessionView(id) {
  const s = await api(`/api/session?id=${encodeURIComponent(id)}`);
  header([{ label: 'Projects', href: '#/projects' }, { label: `Session ${id.slice(0, 8)}` }], `Session ${id.slice(0, 8)}`);
  const pts = s.main.map((p, i) => ({ ...p, i: i + 1 }));
  const peak = pts.reduce((b, p, i) => (p.ctx > (pts[b]?.ctx ?? -1) ? i : b), 0);
  view.innerHTML = `<div class="grid cols-4">${kpiCard('Main-thread calls', comma(pts.length))}${kpiCard('Peak context', compact(pts[peak]?.ctx || 0))}${kpiCard('Subagents', s.subagents.length, compact(s.subagents.reduce((a, x) => a + x.weq, 0)) + ' input-equiv')}${kpiCard('Started', pts[0] ? dateTime(pts[0].ts * 1000) : '-')}</div>
    <div class="card" id="curve" style="margin-top:18px"></div><div class="card" id="cost" style="margin-top:18px"><h2>Where the tokens went</h2><p class="sub">Reading the transcript…</p></div><div class="card" id="subs" style="margin-top:18px"></div>`;
  costCard($('#cost'), id);
  const redraw = chartCard($('#curve'), {
    title: 'Context per call',
    sub: 'Tokens each main-thread call re-read. The area under this curve is the cost; drops are compactions or clears.',
    render: (b) => areaChart(b, { points: pts, x: (p) => p.i, y: (p) => p.ctx, xLabel: (p) => `#${p.i}`, height: 260, markers: pts.length ? [{ index: peak, label: `peak ${compact(pts[peak].ctx)}`, anchor: peak > pts.length / 2 ? 'end' : 'start' }] : [], tipHtml: (p) => `<b>Call #${p.i}</b> · ${dateTime(p.ts * 1000)}<br>Context ${compact(p.ctx)} · output ${compact(p.out)} · cache write ${compact(p.cw)}` }),
    tableHtml: () => table([{ key: 'i', label: 'Call', num: true }, { key: 'ts', label: 'Time', fmt: (v) => dateTime(v * 1000) }, { key: 'ctx', label: 'Context', num: true, fmt: compact }, { key: 'out', label: 'Output', num: true, fmt: compact }, { key: 'weq', label: 'Input-equiv', num: true, fmt: compact }], pts),
  });
  $('#subs').innerHTML = s.subagents.length
    ? `<h2>Subagents</h2><p class="sub">Each subagent re-reads its own growing context on every call.</p>${table([{ key: 'calls', label: 'Calls', num: true, fmt: comma }, { key: 'avgCtx', label: 'Avg context', num: true, fmt: compact }, { key: 'peakCtx', label: 'Peak', num: true, fmt: compact }, { key: 'out', label: 'Output', num: true, fmt: compact }, { key: 'weq', label: 'Input-equiv', num: true, fmt: compact }], s.subagents)}`
    : `<h2>Subagents</h2><p class="sub">None in this session.</p>`;
  return redraw;
}

// Tool results ranked by what they cost: every later call re-reads them.
async function costCard(card, id) {
  let c;
  try {
    c = await api(`/api/session-cost?id=${encodeURIComponent(id)}`);
  } catch {
    card.hidden = true;
    return;
  }
  if (c.error || !c.top?.length) {
    card.innerHTML = `<h2>Where the tokens went</h2><p class="sub">${esc(c.error || 'No tool results in this session.')}</p>`;
    return;
  }
  const top3 = c.top.slice(0, 3).reduce((n, t) => n + t.share, 0);
  card.innerHTML = `<h2>Where the tokens went</h2>
    <p class="sub">Each tool result stays in context and is re-read by every later call. ${c.toolResults} results over ${c.requests} calls cost about ${compact(c.estTokensFromResults)} tokens; the top 3 are ${Math.round(top3)}% of that. Read narrowly early in a session: an early 20k-char dump is paid for on every call after it. (Estimate: characters / 4 × later calls.)</p>
    ${table([
      { key: 'req', label: 'Call', num: true },
      { key: 'tool', label: 'Tool' },
      { key: 'what', label: 'Command / file', html: (v) => `<code>${esc(shortPath(v))}</code>` },
      { key: 'chars', label: 'Size', num: true, fmt: (v) => `${compact(v)} ch` },
      { key: 'rereads', label: 'Re-read by', num: true, fmt: (v) => `${v} calls` },
      { key: 'estTokens', label: '≈ Tokens', num: true, fmt: compact },
      { key: 'share', label: 'Share', num: true, fmt: (v) => `${v}%` },
    ], c.top)}`;
}

// ---------- memory ----------
// Past sessions of a project as a graph (sessions, files edited, keywords) plus the same search Claude gets
// through `tforge recall`.
async function memoryView(project) {
  const ps = await api('/api/projects');
  const onDisk = ps.filter((p) => p.project && p.project !== '(unknown)' && !p.project.startsWith('/tmp/') && !p.project.startsWith('/var/tmp/'));
  if (!project && onDisk.length) project = onDisk[0].project;
  header([{ label: 'Pages' }, { label: 'Memory' }], project ? baseName(project) : 'Memory');
  view.innerHTML = `<div class="card graph-card"><canvas id="cv"></canvas>
    <div class="g-controls">
      <div class="g-panel">
        <select id="proj">${onDisk.map((p) => `<option value="${esc(p.project)}" ${p.project === project ? 'selected' : ''}>${esc(baseName(p.project))} · ${esc(shortPath(p.project))}</option>`).join('')}</select>
        <input id="q" placeholder="Search past work: feature, file, bug…" style="margin-top:8px" autocomplete="off">
      </div>
      <div class="g-panel"><div class="g-legend">${Object.values(MEM_TYPES).map((t) => `<span><i style="background:var(${t.color})"></i>${t.label}</span>`).join('')}</div><div class="g-stats" id="gstats" style="margin-top:8px">Reading sessions…</div></div>
    </div>
    <div class="g-panel g-detail" id="detail" hidden></div>
    <div class="g-hint">Claude searches this with <code>tforge recall &lt;words&gt;</code> · scroll to zoom · drag to pan · click for details</div></div>`;
  $('#proj').addEventListener('change', (e) => (location.hash = `#/memory/${encodeURIComponent(e.target.value)}`));
  if (!project) return;
  const g = await api(`/api/memory-graph?project=${encodeURIComponent(project)}`);
  if (g.error || !g.nodes.length) {
    $('#gstats').textContent = g.error || 'No sessions with prompts or edits in this project yet.';
    return;
  }
  graphHandle?.destroy();
  const detail = $('#detail');
  const q = encodeURIComponent(project);
  const showDetail = async (n) => {
    if (!n) return void (detail.hidden = true);
    detail.hidden = false;
    const nb = graphHandle.neighborsOf(n);
    const list = (type) => nb.filter((m) => m.type === type).slice(0, 10).map((m) => `<tr><td class="path">${esc(m.label)}</td></tr>`).join('');
    detail.innerHTML = `<button class="x" title="Close">×</button><h3>${esc(n.type === 'session' ? `Session ${n.id.slice(2, 10)}` : n.label)}</h3>
      <div class="meta">${n.type === 'session' ? `${dateTime(Date.parse(n.start))} · ${n.prompts} prompts · ${n.edited} files edited` : n.type === 'file' ? `edited in ${n.edits} session${n.edits > 1 ? 's' : ''}` : `in ${n.sessions} sessions`}</div>
      ${n.type !== 'session' && list('session') ? `<table><thead><tr><th>Sessions</th></tr></thead><tbody>${list('session')}</tbody></table>` : ''}
      ${n.type === 'session' ? '<pre id="sess">Loading…</pre>' : ''}`;
    $('.x', detail).addEventListener('click', () => ((detail.hidden = true), graphHandle.select(null)));
    if (n.type === 'session') {
      const r = await api(`/api/memory-session?project=${q}&id=${encodeURIComponent(n.id.slice(2))}`);
      const pre = $('#sess', detail);
      if (pre) pre.textContent = r.text || r.error || '';
    }
  };
  graphHandle = renderMemGraph($('#cv'), g, {
    onSelect: showDetail,
    onHover: (n, ev) => (n ? showTip(`<b>${esc(n.label)}</b><br>${esc(MEM_TYPES[n.type].label)}`, ev) : hideTip()),
  });
  const counts = (t) => g.nodes.filter((n) => n.type === t).length;
  $('#gstats').textContent = `${comma(counts('session'))} sessions · ${comma(counts('file'))} files edited · ${comma(counts('keyword'))} keywords`;
  let qt;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qt);
    qt = setTimeout(async () => {
      const text = e.target.value.trim();
      if (!text) return graphHandle.setFilter(null);
      const r = await api(`/api/memory-recall?project=${q}&q=${encodeURIComponent(text)}`);
      const hit = new Set([...r.sessions.map((s) => `s:${s.id}`), ...r.files.map((f) => `f:${f}`)]);
      const words = r.query || [];
      graphHandle.setFilter((n) => hit.has(n.id) || (n.type === 'keyword' && words.includes(n.label)));
      $('#gstats').textContent = r.sessions.length ? `${r.sessions.length} matching sessions · ${r.files.length} files` : 'No match';
    }, 250);
  });
  return () => graphHandle && graphHandle.select(null);
}

// ---------- code graph ----------
let graphHandle = null;
async function mapView(project) {
  const ps = await api('/api/projects');
  const onDisk = ps.filter((p) => p.project && p.project !== '(unknown)' && !p.project.startsWith('/tmp/'));
  if (!project && onDisk.length) project = onDisk[0].project;
  header([{ label: 'Pages' }, { label: 'Code graph' }], project ? baseName(project) : 'Code graph');
  view.innerHTML = `<div class="card graph-card"><canvas id="cv"></canvas>
    <div class="g-controls">
      <div class="g-panel">
        <select id="proj">${onDisk.map((p) => `<option value="${esc(p.project)}" ${p.project === project ? 'selected' : ''}>${esc(baseName(p.project))} · ${esc(shortPath(p.project))}</option>`).join('')}</select>
        <input id="q" placeholder="Filter: path or symbol" style="margin-top:8px" autocomplete="off">
        <label><input type="checkbox" id="calls"> Call links between files</label>
        <label><input type="checkbox" id="flabels" checked> File names when zoomed in</label>
      </div>
      <div class="g-panel"><div class="g-legend">${LANG.map((l) => `<span><i style="background:${l.color}"></i>${l.label}</span>`).join('')}<span><i style="background:#8f8d86"></i>Other</span><span><i style="background:#e8e4d8"></i>Folder</span></div><div class="g-stats" id="gstats" style="margin-top:8px">Indexing…</div></div>
    </div>
    <div class="g-panel g-detail" id="detail" hidden></div>
    <div class="g-hint">Scroll to zoom · drag to pan · drag a node to move it · click for details</div></div>`;
  $('#proj').addEventListener('change', (e) => (location.hash = `#/map/${encodeURIComponent(e.target.value)}`));
  if (!project) return;
  const g = await api(`/api/graph?project=${encodeURIComponent(project)}`);
  if (g.error) {
    $('#gstats').textContent = g.error;
    return;
  }
  graphHandle?.destroy();
  const detail = $('#detail');
  const showDetail = async (n) => {
    if (!n) {
      detail.hidden = true;
      return;
    }
    detail.hidden = false;
    const { inc, out } = graphHandle.neighborsOf(n);
    const list = (arr, pick) => arr.slice(0, 8).map((l) => `<tr><td class="path">${esc(pick(l).path)}</td><td class="num">${comma(l.w)}</td></tr>`).join('');
    detail.innerHTML = `<button class="x" title="Close">×</button><h3>${esc(n.kind === 'root' ? baseName(project) : n.path)}</h3>
      <div class="meta">${n.kind === 'file' ? (n.lang ? n.lang.label : 'File') : 'Folder'} · ${comma(n.lines)} lines · ${comma(n.syms)} definitions${n.kind !== 'file' ? ` · ${comma(n.files)} files` : ''}</div>
      ${n.kind === 'file' ? `<div class="meta">${comma(n.inbound)} calls in · ${comma(n.outbound)} calls out</div>` : ''}
      ${inc.length ? `<table><thead><tr><th>Called from</th><th class="num">Calls</th></tr></thead><tbody>${list(inc, (l) => l.s)}</tbody></table>` : ''}
      ${out.length ? `<table style="margin-top:8px"><thead><tr><th>Calls into</th><th class="num">Calls</th></tr></thead><tbody>${list(out, (l) => l.t)}</tbody></table>` : ''}
      ${n.kind === 'file' ? '<pre id="outline">Loading outline…</pre>' : ''}`;
    $('.x', detail).addEventListener('click', () => {
      detail.hidden = true;
      graphHandle.select(null);
    });
    if (n.kind === 'file') {
      const r = await api(`/api/outline?project=${encodeURIComponent(project)}&file=${encodeURIComponent(n.path)}`);
      const pre = $('#outline', detail);
      if (pre) pre.textContent = r.text || r.error || '';
    }
  };
  graphHandle = renderGraph($('#cv'), g, {
    rootName: baseName(project),
    onSelect: showDetail,
    onHover: (n, ev) => (n ? showTip(`<b>${esc(n.kind === 'root' ? baseName(project) : n.path)}</b><br>${comma(n.lines)} lines · ${comma(n.syms)} definitions${n.kind === 'file' ? ` · ${comma(n.inbound)} calls in` : ` · ${comma(n.files)} files`}`, ev) : hideTip()),
  });
  const stats = () => `${comma(graphHandle.fileCount)} files · ${comma(graphHandle.nodeCount - graphHandle.fileCount - 1)} folders · ${comma(graphHandle.callCount)} file-to-file call links`;
  $('#gstats').textContent = stats();
  $('#calls').addEventListener('change', (e) => graphHandle.setShowCalls(e.target.checked));
  $('#flabels').addEventListener('change', (e) => graphHandle.setShowFileLabels(e.target.checked));
  let qt;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qt);
    qt = setTimeout(() => {
      const n = graphHandle.search(e.target.value);
      $('#gstats').textContent = e.target.value ? `${comma(n)} matching nodes` : stats();
    }, 150);
  });
}

// ---------- router ----------
let redraw = null;
// ---------- checkpoints ----------
// All projects with snapshots, or one project's (#/snapshots/<project>).
async function snapshotsView(project) {
  const list = await api('/api/snapshot-projects');
  const shown = project ? list.filter((p) => p.project === project) : list;
  header([{ label: 'Checkpoints', href: '#/snapshots' }, ...(project ? [{ label: baseName(project) }] : [])], project ? baseName(project) : 'Checkpoints');
  if (!shown.length) {
    view.innerHTML = `<div class="card"><h2>Checkpoints</h2><p class="sub">${project ? 'No snapshots for this project yet.' : 'No project has snapshots yet.'} After every reply the checkpoint hook saves the session in chunks to <code>.forge/snapshots/</code>; <code>/clear</code> reloads the newest two.</p></div>`;
    return;
  }
  view.innerHTML = shown.map((p, i) => `<div class="card" id="snap-${i}" ${i ? 'style="margin-top:18px"' : ''}></div>`).join('');
  await Promise.all(
    shown.map(async (p, i) => {
      const card = $(`#snap-${i}`);
      await snapshotsCard(card, p.project).catch((e) => (card.innerHTML = `<p class="sub">Could not load: ${esc(e.message)}</p>`));
      // Name the project: the shared card only says "Snapshots".
      const h = $('h2', card);
      if (h) h.innerHTML = `<a href="#/project/${encodeURIComponent(p.project)}">${esc(baseName(p.project))}</a> <span class="muted">${esc(shortPath(p.project))}</span>`;
    }),
  );
}

// Sidebar: projects with snapshots, one click to their checkpoints.
async function sideSnapshots() {
  const box = $('#side-snaps');
  try {
    const list = await api('/api/snapshot-projects');
    const cur = decodeURIComponent((location.hash.match(/^#\/snapshots\/(.+)$/) || [])[1] || '');
    box.innerHTML = list
      .slice(0, 12)
      .map((p) => `<a href="#/snapshots/${encodeURIComponent(p.project)}" class="${p.project === cur ? 'on' : ''}" title="${esc(p.project)}"><span>${esc(baseName(p.project))}</span><small>${p.count}</small></a>`)
      .join('');
  } catch {
    box.innerHTML = '';
  }
}

async function route() {
  hideTip();
  if (graphHandle) {
    graphHandle.destroy();
    graphHandle = null;
  }
  const [, kind, arg] = (location.hash || '#/overview').split('/');
  const param = arg ? decodeURIComponent(arg) : undefined;
  const tab = { overview: 'overview', projects: 'projects', project: 'projects', session: 'projects', map: 'map', snapshots: 'snapshots', settings: 'settings', memory: 'memory' }[kind] || 'overview';
  sideSnapshots();
  document.querySelectorAll('.nav button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === tab)));
  try {
    redraw = await ({ overview: overviewView, projects: projectsView, project: () => projectView(param), session: () => sessionView(param), map: () => mapView(param), snapshots: () => snapshotsView(param), settings: settingsView, memory: () => memoryView(param) }[kind] || overviewView)();
  } catch (e) {
    view.innerHTML = `<div class="card"><h2>Could not load</h2><p class="sub">${esc(e.message)}</p></div>`;
  }
}
document.querySelectorAll('.nav button').forEach((b) => b.addEventListener('click', () => (location.hash = `#/${b.dataset.view}`)));
addEventListener('hashchange', route);
let rt;
addEventListener('resize', () => {
  clearTimeout(rt);
  rt = setTimeout(() => redraw && redraw(), 150);
});

// While the first scan runs, poll fast and re-render once it finishes.
let wasScanning = false;
async function pollStatus() {
  try {
    const s = await api('/api/status');
    $('#scan').textContent = s.scanning ? `Reading transcripts ${s.done}/${s.total}…` : s.lastRefresh ? `Live · updated ${clock(s.lastRefresh)}` : '';
    if (wasScanning && !s.scanning) route();
    wasScanning = s.scanning;
    if (s.scanning) setTimeout(pollStatus, 1500);
  } catch {}
}
route();
pollStatus();
setInterval(pollStatus, 30000);
