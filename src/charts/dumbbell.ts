// (c) Per-task results: clean Claude Code -> tokenforge, total tokens on a log scale, direct labels.
import { data, type Task } from '../data';
import { bindTips, esc, fmtInt, fmtK, mountChart, type Tip } from '../util';

const LO = 50_000, HI = 3_000_000;
const TICKS: [number, string][] = [[50_000, '50k'], [100_000, '100k'], [200_000, '200k'], [500_000, '500k'], [1_000_000, '1M'], [2_000_000, '2M']];

export function dumbbellChart(box: HTMLElement, group: Task['group']): void {
  const tasks = data.tasks.filter((t) => t.group === group).sort((a, b) => b.savings - a.savings);
  const draw = (W: number) => {
    const narrow = W < 560;
    const left = narrow ? 112 : 236, right = narrow ? 50 : 70, top = 6, rowH = narrow ? 42 : 40;
    const H = top + tasks.length * rowH + 26;
    const span = W - left - right;
    const X = (v: number) => left + (span * (Math.log10(v) - Math.log10(LO))) / (Math.log10(HI) - Math.log10(LO));
    const tips: Tip[] = [];
    const g: string[] = [`<svg class="chart anim" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Total tokens per task, clean Claude Code versus tokenforge, log scale">`];
    for (const [v, lab] of TICKS) {
      g.push(`<line class="gridl" x1="${X(v).toFixed(1)}" x2="${X(v).toFixed(1)}" y1="${top}" y2="${H - 22}"/>`);
      if (!narrow || v === 100_000 || v === 1_000_000) g.push(`<text class="tick" x="${X(v).toFixed(1)}" y="${H - 6}" text-anchor="middle">${lab}</text>`);
    }
    g.push(`<text x="${W - 2}" y="${H - 6}" text-anchor="end">saved</text>`);
    tasks.forEach((t, i) => {
      const yc = top + i * rowH + rowH / 2;
      const xn = X(t.native.total), xt = X(t.tokenforge.total);
      const d = (0.08 * i).toFixed(2);
      const qn = t.native.quality, qt = t.tokenforge.quality;
      tips.push({
        title: `${t.label} · ${t.language}`,
        rows: [
          { color: 'var(--native)', label: `clean Claude Code (quality ${qn})`, value: fmtInt(t.native.total) },
          { color: 'var(--tf)', label: `tokenforge (quality ${qt})`, value: fmtInt(t.tokenforge.total) },
          { label: 'total tokens', value: `−${Math.round(t.savings)}%` },
          { label: 'price-weighted', value: `−${Math.round(t.savingsPriceWeighted)}%` },
        ],
      });
      g.push(`<rect class="hl" data-for="${i}" x="0" y="${top + i * rowH}" width="${W}" height="${rowH}"/>`);
      g.push(`<text class="t1" x="${left - 14}" y="${yc - 2}" text-anchor="end">${esc(narrow ? t.short : t.label)}</text>`);
      g.push(`<text x="${left - 14}" y="${yc + 12}" text-anchor="end">${fmtK(t.native.total)} → ${fmtK(t.tokenforge.total)}</text>`);
      g.push(`<line class="line-t shrink" style="--d:${d}s;--sx:0" x1="${xt.toFixed(1)}" x2="${xn.toFixed(1)}" y1="${yc}" y2="${yc}" stroke-width="2" stroke-opacity=".55"/>`);
      g.push(`<circle class="mark-n ring lift" data-for="${i}" cx="${xn.toFixed(1)}" cy="${yc}" r="6"/>`);
      g.push(`<circle class="mark-t ring slide lift" data-for="${i}" style="--d:${d}s;--dx:${(xn - xt).toFixed(1)}px" cx="${xt.toFixed(1)}" cy="${yc}" r="6"/>`);
      g.push(`<text class="big fade" style="--d:${(0.08 * i + 0.8).toFixed(2)}s" x="${W - 2}" y="${yc + 5}" text-anchor="end">−${Math.round(t.savings)}%</text>`);
      g.push(`<rect class="hit" data-tip="${i}" tabindex="0" x="0" y="${top + i * rowH}" width="${W}" height="${rowH}" aria-label="${esc(t.label)}: ${fmtInt(t.native.total)} to ${fmtInt(t.tokenforge.total)} tokens, ${Math.round(t.savings)}% fewer"/>`);
    });
    g.push('</svg>');
    box.innerHTML = g.join('');
    bindTips(box.querySelector('svg') as SVGSVGElement, tips);
  };
  mountChart(box, draw);
}

export function resultsTable(group?: Task['group'], full = false): string {
  const groups: Task['group'][] = group ? [group] : ['scratch', 'existing', 'academic'];
  const head = full
    ? '<th>Task</th><th>Language</th><th class="num">Runs (clean / tf)</th><th class="num">Clean Claude Code</th><th class="num">tokenforge</th><th class="num">Saved</th><th class="num">Price-weighted</th><th class="num">Requests</th><th class="num">Quality</th>'
    : '<th>Task</th><th class="num">Clean Claude Code</th><th class="num">tokenforge</th><th class="num">Saved</th><th class="num">Quality</th>';
  const cols = full ? 9 : 5;
  const body = groups.map((gname) => {
    const ts = data.tasks.filter((t) => t.group === gname).sort((a, b) => b.savings - a.savings);
    const med = gname === 'scratch' ? data.aggregate.scratchMedian : gname === 'academic' ? data.aggregate.academicMedian : data.aggregate.existingMedian;
    const title = `${gname === 'scratch' ? 'Built from scratch' : gname === 'academic' ? 'Academic work' : 'In an existing codebase'} · median −${Math.round(med)}%`;
    const rows = ts.map((t) => {
      const q = `${t.native.quality} → ${t.tokenforge.quality}`;
      const qcell = t.qualityDiff < 0 ? `<span class="qdown" title="lower quality score">${q} ▼</span>` : q;
      const label = full ? `${esc(t.label)}<div class="muted" style="font-size:12px">${esc(t.title)}</div>` : esc(t.label);
      return full
        ? `<tr><td>${label}</td><td>${esc(t.language)}</td><td class="num">${t.runs.native} / ${t.runs.tokenforge}</td><td class="num">${fmtInt(t.native.total)}</td><td class="num">${fmtInt(t.tokenforge.total)}</td><td class="num save">−${Math.round(t.savings)}%<span class="pbar"><span style="width:${t.savings}%"></span></span></td><td class="num">−${Math.round(t.savingsPriceWeighted)}%</td><td class="num">${t.native.requests} → ${t.tokenforge.requests}</td><td class="num">${qcell}</td></tr>`
        : `<tr><td>${label}</td><td class="num">${fmtK(t.native.total)}</td><td class="num">${fmtK(t.tokenforge.total)}</td><td class="num save">−${Math.round(t.savings)}%</td><td class="num">${qcell}</td></tr>`;
    });
    return `${groups.length > 1 ? `<tr class="group"><td colspan="${cols}">${title}</td></tr>` : ''}${rows.join('')}`;
  });
  return `<div class="scroll"><table${full ? ' class="wide"' : ''}><thead><tr>${head}</tr></thead><tbody>${body.join('')}</tbody></table></div>`;
}
