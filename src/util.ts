// Small helpers shared by pages and charts.

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: string | number): string => String(s).replace(/[&<>"']/g, (c) => ESC[c] ?? c);

/** 1,444,788 -> "1.44M", 603,940 -> "604k", 9,738 -> "9.7k" */
export function fmtK(n: number, small = false): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (small && n < 100_000) return `${(n / 1e3).toFixed(1)}k`;
  return `${Math.round(n / 1e3)}k`;
}
export const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');
export const pct = (n: number): string => `−${Math.round(n)}%`;

export const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- tooltip ----------
export interface TipRow { color?: string; label: string; value: string }
export interface Tip { title: string; rows: TipRow[] }

const tipEl = (): HTMLElement => document.getElementById('tip') as HTMLElement;

export function showTip(tip: Tip, x: number, y: number): void {
  const el = tipEl();
  el.replaceChildren();
  const t = document.createElement('div');
  t.className = 'tt';
  t.textContent = tip.title;
  el.append(t);
  const table = document.createElement('table');
  for (const r of tip.rows) {
    const tr = document.createElement('tr');
    const v = document.createElement('td');
    v.className = 'v';
    v.textContent = r.value;
    const k = document.createElement('td');
    k.className = 'k';
    if (r.color) {
      const key = document.createElement('span');
      key.className = 'key';
      key.style.background = r.color;
      k.append(key);
    }
    k.append(document.createTextNode(r.label));
    tr.append(v, k);
    table.append(tr);
  }
  el.append(table);
  el.hidden = false;
  const w = el.offsetWidth, h = el.offsetHeight;
  const px = x + 14 + w > window.innerWidth - 8 ? x - w - 14 : x + 14;
  const py = Math.min(Math.max(8, y - h - 12), window.innerHeight - h - 8);
  el.style.left = `${Math.max(8, px)}px`;
  el.style.top = `${py}px`;
}
export const hideTip = (): void => { tipEl().hidden = true; };

/** Wire every [data-tip="i"] mark inside root to tips[i]; hovered mark gets .on. Keyboard focus shows the same. */
export function bindTips(root: Element, tips: Tip[]): void {
  let current: Element | null = null;
  const set = (el: Element | null) => {
    if (current === el) return;
    current?.classList.remove('on');
    root.querySelectorAll('.on[data-for]').forEach((n) => n.classList.remove('on'));
    current = el;
    if (el) {
      el.classList.add('on');
      const id = el.getAttribute('data-tip');
      root.querySelectorAll(`[data-for="${id}"]`).forEach((n) => n.classList.add('on'));
    }
  };
  root.addEventListener('pointermove', (e) => {
    const ev = e as PointerEvent;
    const el = (ev.target as Element).closest('[data-tip]');
    if (!el) { set(null); hideTip(); return; }
    set(el);
    const tip = tips[Number(el.getAttribute('data-tip'))];
    if (tip) showTip(tip, ev.clientX, ev.clientY);
  });
  root.addEventListener('pointerleave', () => { set(null); hideTip(); });
  root.addEventListener('focusin', (e) => {
    const el = (e.target as Element).closest('[data-tip]');
    if (!el) return;
    set(el);
    const r = el.getBoundingClientRect();
    const tip = tips[Number(el.getAttribute('data-tip'))];
    if (tip) showTip(tip, r.right, r.top);
  });
  root.addEventListener('focusout', () => { set(null); hideTip(); });
}

// ---------- responsive chart mounting + play on scroll ----------
export interface ChartHandle { played: boolean }

/**
 * Render `draw(width, played)` into box, re-render on width change, and call `play` once the chart scrolls into
 * view (adds .in to the svg). With reduced motion the final state is shown immediately.
 */
export function mountChart(box: HTMLElement, draw: (width: number, played: boolean) => void, play?: () => void): ChartHandle {
  const handle: ChartHandle = { played: false };
  let lastW = 0;
  const render = () => {
    const w = Math.round(box.clientWidth);
    if (!w || w === lastW) return;
    lastW = w;
    draw(w, handle.played);
    if (handle.played) box.querySelector('svg')?.classList.add('in');
  };
  render();
  new ResizeObserver(render).observe(box);
  const start = () => {
    if (handle.played) return;
    handle.played = true;
    const svg = box.querySelector('svg');
    if (reducedMotion()) { svg?.classList.add('in'); play?.(); return; }
    // next frame so the initial (hidden) state is painted before the transition starts
    requestAnimationFrame(() => requestAnimationFrame(() => { svg?.classList.add('in'); play?.(); }));
  };
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) { io.disconnect(); start(); }
  }, { threshold: 0.35 });
  io.observe(box);
  return handle;
}

/** Copy buttons on every pre[data-copy] inside root. */
export function bindCopy(root: Element): void {
  root.querySelectorAll<HTMLElement>('pre[data-copy]').forEach((pre) => {
    const b = document.createElement('button');
    b.className = 'copy';
    b.type = 'button';
    b.textContent = 'Copy';
    b.addEventListener('click', async () => {
      const text = pre.querySelector('code')?.textContent ?? '';
      try { await navigator.clipboard.writeText(text.trim()); b.textContent = 'Copied'; }
      catch { b.textContent = 'Select and copy'; }
      setTimeout(() => (b.textContent = 'Copy'), 1600);
    });
    pre.append(b);
  });
}

/** Nice round ticks for a linear axis. */
export function ticks(max: number, count = 4): number[] {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; out.length === 0 || out[out.length - 1]! < max; v += step) out.push(v);
  return out;
}
