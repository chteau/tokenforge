// "How it works": what each API request carries, clean Claude Code vs TokenForge. Schematic sizes (thousands of
// tokens) except the fixed part, which is the measured per-request floor (lean off vs the default level).
import { data } from '../data';
import { esc, reducedMotion } from '../util';

interface Side { label: string; fixed: number; results: number[] }

export function anatomy(box: HTMLElement): void {
  const fixed = (lvl: string) => (data.lean.find((l) => l.level === lvl)?.tokens ?? 0) / 1000;
  const sides: Record<'n' | 't', Side> = {
    n: { label: 'Clean Claude Code', fixed: fixed('off'), results: [8, 11, 5, 14, 6, 9, 7] },
    t: { label: 'With TokenForge', fixed: fixed(data.defaultLean), results: [5, 8, 4, 8, 5, 6] },
  };
  // request i re-sends the fixed part + every earlier result, and adds result i
  const cols = (s: Side) => [...s.results, 0].map((r, i) => ({ fixed: s.fixed, hist: s.results.slice(0, i).reduce((a, b) => a + b, 0), add: r }));
  const total = (s: Side) => cols(s).reduce((a, c) => a + c.fixed + c.hist, 0);
  const n = cols(sides.n).length;
  const max = Math.max(...cols(sides.n).map((c) => c.fixed + c.hist + c.add));

  box.innerHTML = `
  <div class="anat-top">
    <div class="seg" role="group" aria-label="Compare">
      <button type="button" data-s="n" aria-pressed="true">${esc(sides.n.label)}</button>
      <button type="button" data-s="t" aria-pressed="false">${esc(sides.t.label)}</button>
    </div>
    <div class="anat-sum"><b data-sum>0</b><span data-sub></span></div>
  </div>
  <div class="anat" aria-hidden="true">
    ${Array.from({ length: n }, (_, i) => `<div class="acol" data-i="${i}"><div class="astack"><i class="p-add"></i><i class="p-hist"></i><i class="p-fixed"></i></div><span>#${i + 1}</span></div>`).join('')}
  </div>
  <div class="legend anat-key">
    <span><i style="background:var(--s4)"></i>Tools &amp; instructions, sent every time</span>
    <span><i style="background:var(--s2);opacity:.45"></i>Everything read so far, sent again</span>
    <span><i style="background:var(--s2)"></i>New file or command output</span>
  </div>`;

  const set = (k: 'n' | 't') => {
    const s = sides[k];
    const cs = cols(s);
    box.querySelectorAll<HTMLElement>('.acol').forEach((el, i) => {
      const c = cs[i];
      el.classList.toggle('gone', !c);
      const h = (v: number) => `${((100 * v) / max).toFixed(2)}%`;
      const [add, hist, fx] = el.querySelectorAll<HTMLElement>('i');
      add!.style.height = h(c?.add ?? 0);
      hist!.style.height = h(c?.hist ?? 0);
      fx!.style.height = h(c?.fixed ?? 0);
    });
    box.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.s === k)));
    const t = total(s), tn = total(sides.n);
    (box.querySelector('[data-sum]') as HTMLElement).textContent = `≈${Math.round(t)}k tokens read`;
    (box.querySelector('[data-sub]') as HTMLElement).textContent = k === 'n'
      ? `${cs.length} requests`
      : `${cs.length} requests · ${Math.round(100 * (1 - t / tn))}% less in this sketch`;
  };

  let touched = false;
  box.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => b.addEventListener('click', () => { touched = true; set(b.dataset.s as 'n' | 't'); }));
  set('n');
  // switch to the TokenForge view once, shortly after the diagram scrolls into view
  if (reducedMotion()) return;
  const io = new IntersectionObserver((es) => {
    if (!es.some((e) => e.isIntersecting)) return;
    io.disconnect();
    setTimeout(() => { if (!touched) set('t'); }, 1800);
  }, { threshold: 0.5 });
  io.observe(box);
}
