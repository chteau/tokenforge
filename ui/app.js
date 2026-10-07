// tokenforge dashboard. Plain ES module, no dependencies, no network beyond this local server.
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

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// ---------- theme ----------
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
try {
  applyTheme(localStorage.getItem('tf-theme'));
} catch {}
$('#theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem('tf-theme', next);
  } catch {}
  route();
});

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
// Rect with 4px rounded top corners, square at the baseline.
function topRounded(x, y, w, h, r = 4) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function legend(series) {
  return `<div class="legend">${series.map((s) => `<span><i style="background:var(${s.color})"></i>${esc(s.label)}</span>`).join('')}</div>`;
}

function table(cols, rows) {
  return `<div class="scroll"><table><thead><tr>${cols.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${esc(c.fmt ? c.fmt(r[c.key], r) : r[c.key])}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

// Card with a chart and a "Table" toggle that swaps in the same data as rows.
function chartCard(container, { title, sub, render, tableHtml }) {
  container.innerHTML = `<button class="ghost toggle">Table</button><h2>${esc(title)}</h2><p class="sub">${sub || ''}</p><div class="body"></div>`;
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

// Stacked columns, one per x item; series stacked bottom-up with a 2px surface gap.
function stackedColumns(body, { items, series, xLabel, height = 220, tipTitle }) {
  body.innerHTML = legend(series);
  const W = Math.max(280, body.clientWidth);
  const H = height;
  const m = { l: 48, r: 8, t: 8, b: 24 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const totals = items.map((it) => series.reduce((a, s) => a + (it[s.key] || 0), 0));
  const max = niceMax(Math.max(...totals, 1));
  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' }, body);
  for (let i = 0; i <= 4; i++) {
    const y = m.t + ph - (ph * i) / 4;
    el('line', { class: i ? 'grid' : 'base', x1: m.l, x2: W - m.r, y1: y, y2: y }, svg);
    el('text', { x: m.l - 6, y: y + 4, 'text-anchor': 'end' }, svg).textContent = compact((max * i) / 4);
  }
  const band = pw / items.length;
  const bw = Math.min(24, Math.max(3, band * 0.68));
  const labelEvery = Math.ceil(items.length / Math.max(1, Math.floor(pw / 56)));
  items.forEach((it, i) => {
    const x0 = m.l + i * band;
    const hl = el('rect', { class: 'hl', x: x0, y: m.t, width: band, height: ph, fill: 'transparent' }, svg);
    let y = m.t + ph;
    const visible = series.filter((s) => (it[s.key] || 0) > 0);
    visible.forEach((s, si) => {
      const h = ((it[s.key] || 0) / max) * ph;
      const gap = si > 0 ? 2 : 0;
      const hh = Math.max(0, h - gap);
      y -= h;
      if (hh <= 0) return;
      const x = x0 + (band - bw) / 2;
      if (si === visible.length - 1) el('path', { d: topRounded(x, y, bw, hh), fill: `var(${s.color})` }, svg);
      else el('rect', { x, y: y + gap, width: bw, height: hh, fill: `var(${s.color})` }, svg);
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
      showTip(`<b>${esc(tipTitle(it))}</b><table>${rows}<tr><td>Total</td><td class="num"><b>${compact(totals[i])}</b></td></tr></table>`, ev);
    });
    hit.addEventListener('mouseleave', () => {
      hl.classList.remove('on');
      hideTip();
    });
  });
}

// Single-series line with a 10% area wash, crosshair and nearest-point tooltip.
function lineChart(body, { points, x, y, xLabel, tipHtml, height = 200, color = '--series-1', markers = [] }) {
  body.innerHTML = '';
  const W = Math.max(280, body.clientWidth);
  const H = height;
  const m = { l: 48, r: 12, t: 10, b: 24 };
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
  for (let i = 0; i <= 4; i++) {
    const yy = m.t + ph - (ph * i) / 4;
    el('line', { class: i ? 'grid' : 'base', x1: m.l, x2: W - m.r, y1: yy, y2: yy }, svg);
    el('text', { x: m.l - 6, y: yy + 4, 'text-anchor': 'end' }, svg).textContent = compact((max * i) / 4);
  }
  const ticks = Math.min(6, points.length);
  for (let i = 0; i < ticks; i++) {
    const p = points[Math.round((i * (points.length - 1)) / Math.max(1, ticks - 1))];
    el('text', { x: sx(x(p)), y: H - 6, 'text-anchor': 'middle' }, svg).textContent = xLabel(p);
  }
  if (!points.length) return;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(x(p)).toFixed(1)},${sy(y(p)).toFixed(1)}`).join('');
  el('path', { d: `${d}L${sx(x1)},${m.t + ph}L${sx(x0)},${m.t + ph}Z`, fill: `var(${color})`, 'fill-opacity': 0.1 }, svg);
  el('path', { d, fill: 'none', stroke: `var(${color})`, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  for (const mk of markers) {
    const p = points[mk.index];
    if (!p) continue;
    el('circle', { cx: sx(x(p)), cy: sy(y(p)), r: 4, fill: `var(${color})`, stroke: 'var(--surface-1)', 'stroke-width': 2 }, svg);
    el('text', { x: sx(x(p)) + (mk.anchor === 'end' ? -8 : 8), y: sy(y(p)) - 8, 'text-anchor': mk.anchor || 'start', style: 'fill:var(--text-secondary)' }, svg).textContent = mk.label;
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

const TOKEN_SERIES = [
  { key: 'wInput', label: 'Input', color: '--series-1' },
  { key: 'wCw', label: 'Cache write ×1.25', color: '--series-2' },
  { key: 'wCr', label: 'Cache read ×0.1', color: '--series-3' },
  { key: 'wOut', label: 'Output ×5', color: '--series-4' },
];
const weighted = (r) => ({ ...r, wInput: r.input, wCw: r.cw * 1.25, wCr: r.cr * 0.1, wOut: r.out * 5 });

// ---------- views ----------
function limitCard(label, w, now) {
  if (!w) return '';
  const used = Math.max(0, Math.min(100, w.used));
  const state = used >= 90 ? ['--critical', 'Near the limit'] : used >= 70 ? ['--warning', 'Getting close'] : ['--good', 'Plenty left'];
  return `<div class="card tile"><div class="label">${esc(label)}</div><div class="value">${Math.round(used)}%</div>
    <div class="meter"><span style="width:${used}%;background:var(${state[0]})"></span></div>
    <div class="state"><i style="background:var(${state[0]})"></i>${state[1]} · resets ${w.resetsAt * 1000 - now < 86400e3 ? 'at ' + clock(w.resetsAt * 1000) : dateTime(w.resetsAt * 1000)} (in ${until(w.resetsAt * 1000)})</div></div>`;
}

async function overviewView() {
  const o = await api('/api/overview');
  const now = Date.now();
  const cur = o.limits.current;
  const fresh = cur && now - cur.at < 6 * 3600e3;
  const limits = fresh && (cur.fiveHour || cur.sevenDay)
    ? `<div class="row">${limitCard('5-hour limit', cur.fiveHour, now)}${limitCard('Weekly limit', cur.sevenDay, now)}</div>
       <p class="note">Live from Claude Code's status line, updated ${ago(cur.at / 1000)}.</p>`
    : `<div class="card"><h2>Usage limits</h2><p class="sub">${
        o.activeBlock
          ? `Current 5-hour window (estimated from your sessions): started ${clock(o.activeBlock.start)}, resets about <b>${clock(o.activeBlock.end)}</b> (in ${until(o.activeBlock.end)}). ${comma(o.activeBlock.calls)} calls, ${compact(o.activeBlock.weq)} input-equivalent tokens so far.`
          : 'No 5-hour window is active (no calls in the last 5 hours).'
      }</p><p class="note">For exact limit percentages and reset times, run <code>tforge statusline --setup</code> in a terminal and add the snippet it prints to your settings. It records the limits Claude Code reports to the status line and keeps your current status line running.</p></div>`;
  view.innerHTML = `
    ${limits}
    <div class="row">
      <div class="card tile hero"><div class="label">Today, input-equivalent tokens</div><div class="value">${compact(o.totals.today.weq)}</div><div class="detail">${comma(o.totals.today.calls)} API calls</div></div>
      <div class="card tile"><div class="label">Last 7 days</div><div class="value">${compact(o.totals.d7.weq)}</div><div class="detail">${comma(o.totals.d7.calls)} calls</div></div>
      <div class="card tile"><div class="label">Last 30 days</div><div class="value">${compact(o.totals.d30.weq)}</div><div class="detail">${comma(o.totals.d30.calls)} calls</div></div>
    </div>
    <div class="card" id="daily"></div>
    <div class="row"><div class="card" id="hourly"></div><div class="card" id="blocks"></div></div>
    <div class="card" id="models"></div>
    <p class="note">Input-equivalent tokens weigh each token type by its relative price: cache writes 1.25×, cache reads 0.1×, output 5×, plain input 1×. That makes days comparable regardless of the mix.</p>`;
  const daily = o.daily.map(weighted);
  const redrawDaily = chartCard($('#daily'), {
    title: 'Daily usage, last 30 days',
    sub: 'Input-equivalent tokens per day, by token type',
    render: (b) => stackedColumns(b, { items: daily, series: TOKEN_SERIES, xLabel: (d) => d.day.slice(5), tipTitle: (d) => new Date(d.day + 'T12:00').toDateString() }),
    tableHtml: () => table([{ key: 'day', label: 'Day' }, { key: 'calls', label: 'Calls', num: true, fmt: comma }, { key: 'input', label: 'Input', num: true, fmt: compact }, { key: 'cw', label: 'Cache write', num: true, fmt: compact }, { key: 'cr', label: 'Cache read', num: true, fmt: compact }, { key: 'out', label: 'Output', num: true, fmt: compact }, { key: 'weq', label: 'Input-equiv', num: true, fmt: compact }], daily.slice().reverse()),
  });
  const redrawHourly = chartCard($('#hourly'), {
    title: 'Last 48 hours',
    sub: 'Input-equivalent tokens per hour',
    render: (b) => lineChart(b, { points: o.hourly, x: (p) => p.hour, y: (p) => p.weq, xLabel: (p) => clock(p.hour * 1000), tipHtml: (p) => `<b>${dateTime(p.hour * 1000)}</b><br>${compact(p.weq)} input-equiv · ${comma(p.calls)} calls` }),
    tableHtml: () => table([{ key: 'hour', label: 'Hour', fmt: (v) => dateTime(v * 1000) }, { key: 'calls', label: 'Calls', num: true, fmt: comma }, { key: 'weq', label: 'Input-equiv', num: true, fmt: compact }], o.hourly.filter((h) => h.calls).reverse()),
  });
  const bl = o.blocks.map((b) => ({ ...b, label: clock(b.start) }));
  const redrawBlocks = chartCard($('#blocks'), {
    title: '5-hour windows, last 7 days',
    sub: 'Estimated from session timestamps',
    render: (b) => stackedColumns(b, { items: bl, series: [{ key: 'weq', label: 'Input-equivalent tokens', color: '--series-1' }], xLabel: (d) => new Date(d.start).toLocaleDateString([], { weekday: 'short' }), tipTitle: (d) => `${dateTime(d.start)} to ${clock(d.end)}` }),
    tableHtml: () => table([{ key: 'start', label: 'Window', fmt: (v, r) => `${dateTime(v)} to ${clock(r.end)}` }, { key: 'calls', label: 'Calls', num: true, fmt: comma }, { key: 'weq', label: 'Input-equiv', num: true, fmt: compact }], bl.slice().reverse()),
  });
  // A single series needs no legend box; the title names it.
  $('#blocks .legend')?.remove();
  $('#models').innerHTML = `<h2>Models, last 30 days</h2><p class="sub">Calls and input-equivalent tokens per model</p>${table(
    [{ key: 'model', label: 'Model' }, { key: 'calls', label: 'Calls', num: true, fmt: comma }, { key: 'weq', label: 'Input-equiv', num: true, fmt: compact }, { key: 'out', label: 'Output', num: true, fmt: compact }],
    o.models.filter((m) => !m.model.startsWith('<')),
  )}`;
  return () => {
    redrawDaily();
    redrawHourly();
    redrawBlocks();
    $('#blocks .legend')?.remove();
  };
}

async function projectsView() {
  const ps = await api('/api/projects');
  view.innerHTML = `<div class="card"><h2>Projects</h2><p class="sub">Every folder Claude Code ran in, newest first. Agent worktrees count toward their repo. Click a row for its sessions.</p><div id="ptable"></div></div>`;
  $('#ptable').innerHTML = `<div class="scroll"><table><thead><tr><th>Project</th><th class="num">Sessions</th><th class="num">Calls</th><th class="num">Input-equiv</th><th class="num">Subagent share</th><th>Last active</th></tr></thead><tbody>${ps
    .map(
      (p) => `<tr class="click" data-p="${esc(p.project)}"><td class="path" title="${esc(p.project)}">${esc(shortPath(p.project))}</td><td class="num">${comma(p.sessions)}</td><td class="num">${comma(p.calls)}</td><td class="num">${compact(p.weq)}</td><td class="num">${p.weq ? Math.round((100 * p.subWeq) / p.weq) : 0}%</td><td>${ago(p.last)}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
  view.querySelectorAll('tr[data-p]').forEach((tr) => tr.addEventListener('click', () => (location.hash = `#/project/${encodeURIComponent(tr.dataset.p)}`)));
}

async function projectView(project) {
  const [ss, forge] = await Promise.all([api(`/api/sessions?project=${encodeURIComponent(project)}`), api(`/api/forge?project=${encodeURIComponent(project)}`)]);
  view.innerHTML = `<div class="crumbs"><a href="#/projects">Projects</a><span class="muted">/</span><span>${esc(shortPath(project))}</span><span class="muted">·</span><a href="#/map/${encodeURIComponent(project)}">Code map</a></div>
    <div class="card"><h2>Sessions</h2><p class="sub">Average context is what every call re-reads; a high average means the session should have been split. Click a row for its context curve.</p><div id="stable"></div></div>
    <div class="card" id="forge"></div>`;
  $('#stable').innerHTML = `<div class="scroll"><table><thead><tr><th>Started</th><th class="num">Calls</th><th class="num">Avg context</th><th class="num">Peak</th><th class="num">Subagents</th><th class="num">Subagent share</th><th class="num">Input-equiv</th></tr></thead><tbody>${ss
    .map(
      (s) => `<tr class="click" data-s="${esc(s.session)}"><td>${dateTime(s.start * 1000)}</td><td class="num">${comma(s.calls)}</td><td class="num">${compact(s.avgCtx)}</td><td class="num">${compact(s.peakCtx)}</td><td class="num">${s.subagents}</td><td class="num">${s.weq ? Math.round((100 * s.subWeq) / s.weq) : 0}%</td><td class="num">${compact(s.weq)}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
  view.querySelectorAll('tr[data-s]').forEach((tr) => tr.addEventListener('click', () => (location.hash = `#/session/${encodeURIComponent(tr.dataset.s)}`)));
  const f = $('#forge');
  if (!forge.present) {
    f.innerHTML = `<h2>tforge</h2><p class="sub">No forge plan in this project yet. Use <code>/tokenforge:forge</code> for a multi-file build.</p>`;
  } else {
    const cost = forge.attempts.reduce((a, r) => a + (r.costUsd || 0), 0);
    f.innerHTML = `<h2>tforge: ${esc(forge.goal || '')}</h2><p class="sub">${forge.tasks.filter((t) => t.status === 'done').length} of ${forge.tasks.length} tasks done · ${forge.attempts.length} worker attempts · $${cost.toFixed(3)} (CLI-reported)</p>${table(
      [{ key: 'id', label: 'Task' }, { key: 'model', label: 'Model' }, { key: 'status', label: 'Status' }, { key: 'costUsd', label: 'Cost', num: true, fmt: (v) => '$' + Number(v).toFixed(3) }],
      forge.tasks,
    )}`;
  }
}

async function sessionView(id) {
  const s = await api(`/api/session?id=${encodeURIComponent(id)}`);
  const pts = s.main.map((p, i) => ({ ...p, i: i + 1 }));
  const peak = pts.reduce((b, p, i) => (p.ctx > (pts[b]?.ctx ?? -1) ? i : b), 0);
  view.innerHTML = `<div class="crumbs"><a href="#/projects">Projects</a><span class="muted">/</span><span>Session ${esc(id.slice(0, 8))}</span></div>
    <div class="row">
      <div class="card tile"><div class="label">Main-thread calls</div><div class="value">${comma(pts.length)}</div></div>
      <div class="card tile"><div class="label">Peak context</div><div class="value">${compact(pts[peak]?.ctx || 0)}</div></div>
      <div class="card tile"><div class="label">Subagents</div><div class="value">${s.subagents.length}</div><div class="detail">${compact(s.subagents.reduce((a, x) => a + x.weq, 0))} input-equiv</div></div>
    </div>
    <div class="card" id="curve"></div>
    <div class="card" id="subs"></div>`;
  const redraw = chartCard($('#curve'), {
    title: 'Context per call',
    sub: 'Tokens re-read by each call of the main thread. Every point is paid again on the next call, so the area under this curve is the cost.',
    render: (b) =>
      lineChart(b, {
        points: pts,
        x: (p) => p.i,
        y: (p) => p.ctx,
        xLabel: (p) => `#${p.i}`,
        markers: pts.length ? [{ index: peak, label: `peak ${compact(pts[peak].ctx)}`, anchor: peak > pts.length / 2 ? 'end' : 'start' }] : [],
        tipHtml: (p) => `<b>Call #${p.i}</b> · ${dateTime(p.ts * 1000)}<br>Context ${compact(p.ctx)} · output ${compact(p.out)} · cache write ${compact(p.cw)}`,
      }),
    tableHtml: () => table([{ key: 'i', label: 'Call', num: true }, { key: 'ts', label: 'Time', fmt: (v) => dateTime(v * 1000) }, { key: 'ctx', label: 'Context', num: true, fmt: compact }, { key: 'out', label: 'Output', num: true, fmt: compact }, { key: 'weq', label: 'Input-equiv', num: true, fmt: compact }], pts),
  });
  $('#subs').innerHTML = s.subagents.length
    ? `<h2>Subagents</h2><p class="sub">Each subagent re-reads its own growing context on every call.</p>${table(
        [{ key: 'calls', label: 'Calls', num: true, fmt: comma }, { key: 'avgCtx', label: 'Avg context', num: true, fmt: compact }, { key: 'peakCtx', label: 'Peak', num: true, fmt: compact }, { key: 'out', label: 'Output', num: true, fmt: compact }, { key: 'weq', label: 'Input-equiv', num: true, fmt: compact }],
        s.subagents,
      )}`
    : `<h2>Subagents</h2><p class="sub">None in this session.</p>`;
  return redraw;
}

// ---------- code map ----------
function squarify(items, x, y, w, h) {
  const out = [];
  const total = items.reduce((a, it) => a + it.value, 0);
  if (!total) return out;
  const scale = (w * h) / total;
  let rest = items.map((it) => ({ ...it, area: it.value * scale })).sort((a, b) => b.area - a.area);
  const worst = (row, side) => {
    const s = row.reduce((a, r) => a + r.area, 0);
    const mx = Math.max(...row.map((r) => r.area));
    const mn = Math.min(...row.map((r) => r.area));
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  while (rest.length) {
    const side = Math.min(w, h);
    const row = [rest[0]];
    let i = 1;
    while (i < rest.length && worst([...row, rest[i]], side) <= worst(row, side)) row.push(rest[i++]);
    rest = rest.slice(i);
    const s = row.reduce((a, r) => a + r.area, 0);
    if (w >= h) {
      const cw = s / h;
      let cy = y;
      for (const r of row) {
        const ch = r.area / cw;
        out.push({ ...r, x, y: cy, w: cw, h: ch });
        cy += ch;
      }
      x += cw;
      w -= cw;
    } else {
      const ch = s / w;
      let cx = x;
      for (const r of row) {
        const rw = r.area / ch;
        out.push({ ...r, x: cx, y, w: rw, h: ch });
        cx += rw;
      }
      y += ch;
      h -= ch;
    }
  }
  return out;
}

function buildTree(g) {
  const inbound = new Array(g.files.length).fill(0);
  const outbound = new Array(g.files.length).fill(0);
  for (const [a, b, n] of g.edges) {
    inbound[b] += n;
    outbound[a] += n;
  }
  const root = { name: '', path: '', kids: new Map(), lines: 0, files: 0, syms: 0, inbound: 0 };
  g.files.forEach((f, i) => {
    const parts = f.p.split('/');
    let node = root;
    const visit = (n) => {
      n.lines += f.l;
      n.files++;
      n.syms += f.s;
      n.inbound += inbound[i];
    };
    visit(node);
    parts.forEach((part, pi) => {
      const leaf = pi === parts.length - 1;
      if (!node.kids.has(part)) node.kids.set(part, { name: part, path: parts.slice(0, pi + 1).join('/'), kids: new Map(), lines: 0, files: 0, syms: 0, inbound: 0, file: leaf ? { ...f, out: outbound[i] } : null });
      node = node.kids.get(part);
      visit(node);
    });
  });
  // Collapse single-child folder chains (src/main/java/...) so the map starts where the code branches.
  const collapse = (n) => {
    for (const k of n.kids.values()) collapse(k);
    if (!n.file && n.kids.size === 1) {
      const only = [...n.kids.values()][0];
      if (!only.file && n.name) {
        n.name = `${n.name}/${only.name}`;
        n.path = only.path;
        n.kids = only.kids;
      }
    }
  };
  collapse(root);
  return root;
}

async function mapView(project) {
  const ps = await api('/api/projects');
  const onDisk = ps.filter((p) => p.project && p.project !== '(unknown)' && !p.project.startsWith('/tmp/'));
  if (!project && onDisk.length) project = onDisk[0].project;
  view.innerHTML = `<div class="card"><h2>Code map</h2><p class="sub">Folders and files sized by lines of code. Color shows how many calls come in from other files (darker = more depended on). Click a folder to zoom in.</p>
    <div class="search"><select id="proj">${onDisk.map((p) => `<option value="${esc(p.project)}" ${p.project === project ? 'selected' : ''}>${esc(shortPath(p.project))}</option>`).join('')}</select></div>
    <div class="crumbs" id="mcrumbs"></div>
    <div style="display:flex;align-items:center;gap:8px;margin:8px 0" class="note"><span>no or few incoming calls per line</span><span class="gradient"></span><span>most, relative to what is shown</span></div>
    <div class="treemap" id="tm"><p class="note">Indexing…</p></div></div>
    <div class="row"><div class="card"><h2>Find code</h2><p class="sub">Keyword search over definitions (tmap find)</p><div class="search"><input id="q" placeholder="e.g. orbit speed"><button id="go">Find</button></div><pre class="hits" id="hits"></pre></div>
    <div class="card" id="central"></div></div>`;
  $('#proj').addEventListener('change', (e) => (location.hash = `#/map/${encodeURIComponent(e.target.value)}`));
  if (!project) return;
  const doFind = async () => {
    const r = await api(`/api/find?project=${encodeURIComponent(project)}&q=${encodeURIComponent($('#q').value)}`);
    $('#hits').textContent = r.lines.join('\n') || 'No matches.';
  };
  $('#go').addEventListener('click', doFind);
  $('#q').addEventListener('keydown', (e) => e.key === 'Enter' && doFind());
  const g = await api(`/api/graph?project=${encodeURIComponent(project)}`);
  if (g.error) {
    $('#tm').innerHTML = `<p class="note">${esc(g.error)}</p>`;
    return;
  }
  const root = buildTree(g);
  const inbound = new Array(g.files.length).fill(0);
  for (const [, b, n] of g.edges) inbound[b] += n;
  const top = g.files.map((f, i) => ({ path: f.p, inbound: inbound[i], lines: f.l })).sort((a, b) => b.inbound - a.inbound).slice(0, 12);
  $('#central').innerHTML = `<h2>Most depended-on files</h2><p class="sub">Calls coming in from other files (resolved by unique name)</p>${table(
    [{ key: 'path', label: 'File' }, { key: 'inbound', label: 'Incoming calls', num: true, fmt: comma }, { key: 'lines', label: 'Lines', num: true, fmt: comma }],
    top,
  )}`;
  let stack = [root];
  const ramp = ['--seq-100', '--seq-250', '--seq-400', '--seq-550', '--seq-700'];
  const draw = () => {
    const node = stack[stack.length - 1];
    $('#mcrumbs').innerHTML = stack
      .map((n, i) => (i === stack.length - 1 ? `<span>${esc(n.name || shortPath(project))}</span>` : `<a data-i="${i}">${esc(n.name || shortPath(project))}</a>`))
      .join('<span class="muted">/</span>');
    $('#mcrumbs').querySelectorAll('a').forEach((a) => a.addEventListener('click', () => {
      stack = stack.slice(0, Number(a.dataset.i) + 1);
      draw();
    }));
    const box = $('#tm');
    box.innerHTML = '';
    const W = box.clientWidth;
    const H = box.clientHeight;
    const kidsOf = (n) => [...n.kids.values()].filter((k) => k.lines > 0).map((k) => ({ node: k, value: k.lines }));
    // Two levels: each folder at this level is a frame with its own contents laid out inside.
    const HEADER = 20;
    const leaves = [];
    for (const c of squarify(kidsOf(node), 0, 0, W, H)) {
      const inner = !c.node.file && c.node.kids.size && c.w > 90 && c.h > 70;
      if (!inner) {
        leaves.push(c);
        continue;
      }
      const frame = document.createElement('div');
      frame.className = 'cell';
      Object.assign(frame.style, { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px`, height: `${c.h}px`, background: 'var(--wash)', color: 'var(--text-primary)', padding: '2px 6px' });
      frame.innerHTML = `<div class="n">${esc(c.node.name)}/ <span class="muted">${compact(c.node.lines)} lines</span></div>`;
      frame.addEventListener('click', (e) => {
        if (e.target !== frame && !frame.firstChild.contains(e.target)) return;
        hideTip();
        stack.push(c.node);
        draw();
      });
      box.appendChild(frame);
      for (const g of squarify(kidsOf(c.node), c.x + 2, c.y + HEADER, c.w - 4, c.h - HEADER - 2)) leaves.push({ ...g, via: c.node });
    }
    // Rank-based shading: one extreme cell must not wash out the rest. Zero incoming calls = lightest step.
    const density = leaves.map((c) => c.node.inbound / Math.max(1, c.node.lines));
    const ranked = density.filter((d) => d > 0).sort((a, b) => a - b);
    const stepOf = (d) => (d <= 0 ? 0 : 1 + Math.min(ramp.length - 2, Math.floor((ranked.indexOf(d) / Math.max(1, ranked.length)) * (ramp.length - 1))));
    leaves.forEach((c, i) => {
      const step = stepOf(density[i]);
      const div = document.createElement('div');
      div.className = 'cell';
      Object.assign(div.style, { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px`, height: `${c.h}px`, background: `var(${ramp[step]})`, color: step >= 3 ? '#ffffff' : '#0b0b0b' });
      // Labels render only where they fit (about 7px per character at 12px); the tooltip always has them.
      const name = `${c.node.name}${c.node.file ? '' : '/'}`;
      const size = `${compact(c.node.lines)} lines`;
      const fits = (s) => s.length * 7 + 14 < c.w;
      if (c.h > 26 && fits(name)) div.innerHTML = `<div class="n">${esc(name)}</div>${c.h > 46 && fits(size) ? `<div>${size}</div>` : ''}`;
      div.addEventListener('mousemove', (ev) => {
        const n = c.node;
        const f = n.file;
        showTip(
          `<b>${esc(n.path)}</b><br>${comma(n.lines)} lines · ${comma(n.syms)} definitions${f ? '' : ` · ${comma(n.files)} files`}<br>${comma(n.inbound)} incoming calls${f ? ` · ${comma(f.out)} outgoing` : ''}${f && f.t.length ? `<br><span class="secondary">${esc(f.t.join(', '))}</span>` : ''}`,
          ev,
        );
      });
      div.addEventListener('mouseleave', hideTip);
      div.addEventListener('click', () => {
        if (!c.node.file && c.node.kids.size) {
          hideTip();
          if (c.via) stack.push(c.via);
          stack.push(c.node);
          draw();
        } else {
          $('#q').value = c.node.name.replace(/\.[^.]+$/, '');
          doFind();
        }
      });
      box.appendChild(div);
    });
  };
  draw();
  return draw;
}

// ---------- router ----------
let redraw = null;
async function route() {
  hideTip();
  const [, kind, arg] = (location.hash || '#/overview').split('/');
  const param = arg ? decodeURIComponent(arg) : undefined;
  const tab = { overview: 'overview', projects: 'projects', project: 'projects', session: 'projects', map: 'map' }[kind] || 'overview';
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === tab)));
  try {
    redraw = await ({ overview: overviewView, projects: projectsView, project: () => projectView(param), session: () => sessionView(param), map: () => mapView(param) }[kind] || overviewView)();
  } catch (e) {
    view.innerHTML = `<div class="card"><h2>Could not load</h2><p class="sub">${esc(e.message)}</p></div>`;
  }
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => (location.hash = `#/${b.dataset.view}`)));
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
    $('#scan').textContent = s.scanning ? `Reading transcripts ${s.done}/${s.total}…` : s.lastRefresh ? `Updated ${clock(s.lastRefresh)}` : '';
    if (wasScanning && !s.scanning) route();
    wasScanning = s.scanning;
    if (s.scanning) setTimeout(pollStatus, 1500);
  } catch {}
}
route();
pollStatus();
setInterval(pollStatus, 30000);
