// (a) Context per request for one real session pair: every request re-reads everything before it.
import { data } from '../data';
import { esc, fmtInt, fmtK, hideTip, mountChart, reducedMotion, showTip, ticks } from '../util';

export function contextChart(box: HTMLElement, counters: HTMLElement): void {
  const { native, tokenforge } = data.curve.series;
  const series = [
    { key: 'n', name: 'clean Claude Code', s: native, color: 'var(--native)', note: '' },
    { key: 't', name: 'tokenforge', s: tokenforge, color: 'var(--tf)', note: ` (default, lean ${tokenforge.lean ?? 'balanced'})` },
  ];
  const n = Math.max(native.points.length, tokenforge.points.length);
  const ymaxRaw = Math.max(...native.points, ...tokenforge.points);
  const yt = ticks(ymaxRaw * 1.05, 4);
  const ymax = yt[yt.length - 1] ?? ymaxRaw;

  // counters above the chart: running sum of context re-read, up to the request the animation has reached
  counters.innerHTML = series
    .map((x) => `<div><i style="background:${x.color}"></i>${esc(x.name + x.note)}<b data-c="${x.key}">0</b><span class="muted" data-r="${x.key}">0 requests</span></div>`)
    .join('');
  const setCounters = (upTo: number) => {
    for (const x of series) {
      const k = Math.min(Math.floor(upTo), x.s.points.length);
      let sum = 0;
      for (let i = 0; i < k; i++) sum += x.s.points[i] ?? 0;
      const b = counters.querySelector(`[data-c="${x.key}"]`);
      const r = counters.querySelector(`[data-r="${x.key}"]`);
      if (b) b.textContent = `${fmtK(sum)} read`;
      if (r) r.textContent = `${k} request${k === 1 ? '' : 's'}`;
    }
  };
  setCounters(0);

  let geo = { left: 0, pw: 0, top: 0, ph: 0 };
  const X = (i: number) => geo.left + (geo.pw * i) / Math.max(n - 1, 1);
  const Y = (v: number) => geo.top + geo.ph * (1 - v / ymax);

  const draw = (W: number, played: boolean) => {
    const narrow = W < 560;
    const H = narrow ? 290 : 360;
    geo = { left: narrow ? 40 : 52, top: 28, pw: W - (narrow ? 40 : 52) - (narrow ? 12 : 24), ph: H - 28 - 44 };
    const g: string[] = [];
    g.push(`<svg class="chart anim" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Context size of each API request in the ${esc(data.curve.label)} task: clean Claude Code versus tokenforge">`);
    g.push(`<defs><clipPath id="ctx-clip"><rect id="ctx-clip-r" x="0" y="0" width="${played || reducedMotion() ? W : geo.left}" height="${H}"/></clipPath></defs>`);
    for (const v of yt) {
      g.push(`<line class="gridl" x1="${geo.left}" x2="${geo.left + geo.pw}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>`);
      g.push(`<text class="tick" x="${geo.left - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${v === 0 ? '0' : fmtK(v)}</text>`);
    }
    const every = narrow ? 3 : 1;
    for (let i = 0; i < n; i++) {
      if (i % every && i !== n - 1) continue;
      g.push(`<text class="tick" x="${X(i).toFixed(1)}" y="${geo.top + geo.ph + 18}" text-anchor="middle">${i + 1}</text>`);
    }
    g.push(`<text x="${geo.left + geo.pw / 2}" y="${H - 6}" text-anchor="middle">API request #</text>`);
    g.push(`<g clip-path="url(#ctx-clip)">`);
    for (const x of series) {
      const pts = x.s.points.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
      const last = x.s.points.length - 1;
      g.push(`<polygon points="${X(0).toFixed(1)},${Y(0)} ${pts} ${X(last).toFixed(1)},${Y(0)}" style="fill:${x.color};fill-opacity:.14"/>`);
      g.push(`<polyline points="${pts}" fill="none" style="stroke:${x.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    }
    g.push(`</g>`);
    g.push(`<line class="base" x1="${geo.left}" x2="${geo.left + geo.pw}" y1="${Y(0)}" y2="${Y(0)}"/>`);
    // end markers + direct labels (fade in when the sweep reaches them)
    for (const x of series) {
      const last = x.s.points.length - 1;
      const ex = X(last), ey = Y(x.s.points[last] ?? 0);
      const d = (2.6 * last) / (n - 1);
      const ly1 = ey - 24, ly2 = ey - 10;
      g.push(`<g class="fade" style="--d:${d.toFixed(2)}s">`);
      g.push(`<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="4.5" class="ring" style="fill:${x.color}"/>`);
      if (!narrow) g.push(`<text class="t1" x="${(ex - 8).toFixed(1)}" y="${ly1.toFixed(1)}" text-anchor="end" font-weight="600">${esc(x.name)}</text>`);
      if (!narrow) g.push(`<text class="t2" x="${(ex - 8).toFixed(1)}" y="${ly2.toFixed(1)}" text-anchor="end">${fmtK(x.s.sum)} read in ${x.s.requests} requests</text>`);
      g.push(`</g>`);
    }
    // hover layer: crosshair snaps to the nearest request
    g.push(`<line id="ctx-cross" class="cross" x1="0" x2="0" y1="${geo.top}" y2="${geo.top + geo.ph}" visibility="hidden"/>`);
    for (const x of series) g.push(`<circle id="ctx-dot-${x.key}" r="4.5" class="ring" style="fill:${x.color}" visibility="hidden"/>`);
    g.push(`<rect id="ctx-hit" class="hit" x="${geo.left - 10}" y="${geo.top}" width="${geo.pw + 20}" height="${geo.ph}" tabindex="0" aria-label="Move across the chart to read each request"/>`);
    g.push(`</svg>`);
    box.innerHTML = g.join('');
    if (played) setCounters(n);
    bindHover(box);
  };

  const bindHover = (root: HTMLElement) => {
    const hit = root.querySelector('#ctx-hit') as SVGRectElement;
    const cross = root.querySelector('#ctx-cross') as SVGLineElement;
    const at = (i: number, cx: number, cy: number) => {
      cross.setAttribute('x1', X(i).toFixed(1));
      cross.setAttribute('x2', X(i).toFixed(1));
      cross.setAttribute('visibility', 'visible');
      for (const x of series) {
        const dot = root.querySelector(`#ctx-dot-${x.key}`) as SVGCircleElement;
        const v = x.s.points[i];
        if (v === undefined) { dot.setAttribute('visibility', 'hidden'); continue; }
        dot.setAttribute('cx', X(i).toFixed(1));
        dot.setAttribute('cy', Y(v).toFixed(1));
        dot.setAttribute('visibility', 'visible');
      }
      showTip({
        title: `Request ${i + 1}: context re-read`,
        rows: series.map((x) => ({ color: x.color, label: x.name, value: x.s.points[i] !== undefined ? fmtInt(x.s.points[i] ?? 0) : 'done' })),
      }, cx, cy);
    };
    const off = () => {
      cross.setAttribute('visibility', 'hidden');
      for (const x of series) root.querySelector(`#ctx-dot-${x.key}`)?.setAttribute('visibility', 'hidden');
      hideTip();
    };
    hit.addEventListener('pointermove', (e) => {
      const r = hit.getBoundingClientRect();
      const svgX = ((e.clientX - r.left) / r.width) * (geo.pw + 20) + geo.left - 10;
      const i = Math.max(0, Math.min(n - 1, Math.round(((svgX - geo.left) / geo.pw) * (n - 1))));
      at(i, e.clientX, e.clientY);
    });
    hit.addEventListener('pointerleave', off);
    let kbd = n - 1;
    hit.addEventListener('focus', () => { const r = hit.getBoundingClientRect(); at(kbd, r.left + r.width / 2, r.top + 20); });
    hit.addEventListener('blur', off);
    hit.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      kbd = Math.max(0, Math.min(n - 1, kbd + (e.key === 'ArrowRight' ? 1 : -1)));
      const r = hit.getBoundingClientRect();
      at(kbd, r.left + (r.width * (X(kbd) - geo.left + 10)) / (geo.pw + 20), r.top + 20);
    });
  };

  const play = () => {
    const rect = () => box.querySelector('#ctx-clip-r');
    if (reducedMotion()) { setCounters(n); return; }
    const dur = 2600, t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      const w = box.querySelector('svg')?.viewBox.baseVal.width ?? 0;
      rect()?.setAttribute('width', String(geo.left + geo.pw * p + (p >= 1 ? w : 0)));
      setCounters(p * (n - 1) + 1);
      if (p < 1) requestAnimationFrame(step);
      else setCounters(n);
    };
    requestAnimationFrame(step);
  };

  mountChart(box, draw, play);
}

export function contextTable(): string {
  const { native, tokenforge } = data.curve.series;
  const n = Math.max(native.points.length, tokenforge.points.length);
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = native.points[i], b = tokenforge.points[i];
    rows.push(`<tr><td class="num">${i + 1}</td><td class="num">${a !== undefined ? fmtInt(a) : '—'}</td><td class="num">${b !== undefined ? fmtInt(b) : '—'}</td></tr>`);
  }
  rows.push(`<tr><td><b>Sum</b></td><td class="num"><b>${fmtInt(native.sum)}</b></td><td class="num"><b>${fmtInt(tokenforge.sum)}</b></td></tr>`);
  return `<div class="scroll"><table><thead><tr><th class="num">Request</th><th class="num">Clean Claude Code</th><th class="num">tokenforge</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}
