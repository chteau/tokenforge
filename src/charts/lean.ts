// (b) Fixed context per request by lean level (measured; bench/scripts/charts.py FLOOR).
import { data } from '../data';
import { bindTips, esc, fmtInt, mountChart, type Tip } from '../util';

export const LEAN_HIDES: Record<string, string> = {
  off: 'Nothing hidden: what clean Claude Code sends.',
  on: 'Agent-orchestration tools (Workflow, Monitor, Cron*, SendMessage, worktrees, NotebookEdit…).',
  balanced: 'Also Claude Code’s 19 built-in skills (still typeable as slash commands).',
  max: 'Also the Skill tool, subagents, WebFetch/WebSearch and the git instructions.',
  ultra: 'Also Read/Edit/Write: Claude reads and edits files with Bash.',
};

export function leanChart(box: HTMLElement): void {
  const rows = data.lean;
  const off = rows[0]?.tokens ?? 1;
  const draw = (W: number) => {
    const narrow = W < 560;
    const left = narrow ? 86 : 150, right = narrow ? 92 : 120, top = 8, rowH = narrow ? 40 : 46, bh = 18;
    const H = top + rows.length * rowH + 26;
    const span = W - left - right;
    const max = 18000;
    const x = (v: number) => left + (span * v) / max;
    const tips: Tip[] = [];
    const g: string[] = [`<svg class="chart anim" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Fixed context per request by lean level">`];
    for (let v = 0; v <= max; v += narrow ? 6000 : 3000) {
      g.push(`<line class="gridl" x1="${x(v)}" x2="${x(v)}" y1="${top - 4}" y2="${H - 22}"/><text class="tick" x="${x(v)}" y="${H - 6}" text-anchor="middle">${v === 0 ? '0' : `${v / 1000}k`}</text>`);
    }
    rows.forEach((r, i) => {
      const y = top + i * rowH + (rowH - bh) / 2;
      const isOff = r.level === 'off';
      const isDef = r.level === data.defaultLean;
      const cls = isOff ? 'mark-n' : 'mark-t';
      const save = isOff ? '' : `−${Math.round(100 * (1 - r.tokens / off))}%`;
      tips.push({
        title: `${r.level}${isDef ? ' (default)' : ''}: ${LEAN_HIDES[r.level] ?? ''}`,
        rows: [
          { color: isOff ? 'var(--native)' : 'var(--tf)', label: 'tokens per request', value: fmtInt(r.tokens) },
          ...(isOff ? [] : [{ label: 'vs off', value: save }]),
        ],
      });
      g.push(`<rect class="hl" data-for="${i}" x="0" y="${top + i * rowH}" width="${W}" height="${rowH}"/>`);
      g.push(`<text class="t1" x="${left - 12}" y="${y + bh / 2 + 4}" text-anchor="end"${isDef ? ' font-weight="700"' : ''}>${esc(r.level)}${isDef && !narrow ? ' (default)' : ''}</text>`);
      if (isDef && narrow) g.push(`<text x="${left - 12}" y="${y + bh / 2 + 17}" text-anchor="end">default</text>`);
      g.push(`<rect class="${cls} grow-x lift" data-for="${i}" style="--d:${(0.12 * i).toFixed(2)}s" x="${left}" y="${y}" width="${(x(r.tokens) - left).toFixed(1)}" height="${bh}"/>`);
      g.push(`<g class="fade" style="--d:${(0.12 * i + 0.6).toFixed(2)}s"><text class="t1 big" x="${(x(r.tokens) + 8).toFixed(1)}" y="${y + bh / 2 + 5}">${(r.tokens / 1000).toFixed(1)}k</text>`);
      if (save) g.push(`<text class="t2" x="${(x(r.tokens) + (narrow ? 50 : 58)).toFixed(1)}" y="${y + bh / 2 + 5}">${save}</text>`);
      g.push(`</g>`);
      g.push(`<rect class="hit" data-tip="${i}" tabindex="0" x="0" y="${top + i * rowH}" width="${W}" height="${rowH}" aria-label="${esc(r.level)}: ${fmtInt(r.tokens)} tokens per request"/>`);
    });
    g.push(`<line class="base" x1="${left}" x2="${left}" y1="${top - 4}" y2="${H - 22}"/>`);
    g.push('</svg>');
    box.innerHTML = g.join('');
    bindTips(box.querySelector('svg') as SVGSVGElement, tips);
  };
  mountChart(box, draw);
}

export function leanTable(): string {
  const off = data.lean[0]?.tokens ?? 1;
  return `<div class="scroll"><table><thead><tr><th>Level</th><th>Hides</th><th class="num">Tokens per request</th><th class="num">vs off</th></tr></thead><tbody>${data.lean
    .map((r) => `<tr><td><code>${esc(r.level)}</code>${r.level === data.defaultLean ? ' (default)' : ''}</td><td>${esc(LEAN_HIDES[r.level] ?? '')}</td><td class="num">${fmtInt(r.tokens)}</td><td class="num">${r.level === 'off' ? '—' : `−${Math.round(100 * (1 - r.tokens / off))}%`}</td></tr>`)
    .join('')}</tbody></table></div>`;
}
