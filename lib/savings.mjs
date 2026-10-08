// Tokens kept out of context by `tkit` tools. Each call appends one line to savings.jsonl:
// {"t":epochSeconds,"tool":"check","cwd":"/repo","raw":tokens,"out":tokens}
// raw = what the model would have read without the tool (full build log, whole diff, page, file);
// out = what the tool printed. Only measured inputs count: no estimate for turns or reply length.
import fs from 'node:fs';
import path from 'node:path';
import { cacheBase, projectOf } from './usage.mjs';

export const ledgerPath = () => path.join(cacheBase(), 'savings.jsonl');

let cache = { key: '', rows: [] };

export function readLedger(file = ledgerPath()) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return [];
  }
  const key = `${file}:${st.size}:${st.mtimeMs}`;
  if (cache.key === key) return cache.rows;
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (Number.isFinite(r.t) && typeof r.tool === 'string') rows.push({ t: r.t, tool: r.tool, cwd: r.cwd || '', raw: Math.max(0, r.raw | 0), out: Math.max(0, r.out | 0) });
    } catch {}
  }
  cache = { key, rows };
  return rows;
}

const dayOf = (sec) => {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const empty = () => ({ calls: 0, raw: 0, out: 0, saved: 0 });
const add = (acc, r) => {
  acc.calls++;
  acc.raw += r.raw;
  acc.out += r.out;
  acc.saved += Math.max(0, r.raw - r.out);
  return acc;
};

export function savings(rows = readLedger(), now = Date.now()) {
  const nowS = now / 1000;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const todayS = start.getTime() / 1000;
  const totals = { today: empty(), d7: empty(), d30: empty(), all: empty() };
  const tools = new Map();
  const projects = new Map();
  const days = new Map();
  for (let i = 29; i >= 0; i--) days.set(dayOf(nowS - i * 86400), { day: dayOf(nowS - i * 86400), saved: 0, calls: 0 });
  for (const r of rows) {
    add(totals.all, r);
    if (r.t < nowS - 30 * 86400) continue;
    add(totals.d30, r);
    if (r.t >= nowS - 7 * 86400) add(totals.d7, r);
    if (r.t >= todayS) add(totals.today, r);
    add(tools.get(r.tool) || tools.set(r.tool, { tool: r.tool, ...empty() }).get(r.tool), r);
    const p = projectOf(r.cwd) || '(unknown)';
    add(projects.get(p) || projects.set(p, { project: p, ...empty() }).get(p), r);
    const d = days.get(dayOf(r.t));
    if (d) {
      d.saved += Math.max(0, r.raw - r.out);
      d.calls++;
    }
  }
  const bySaved = (a, b) => b.saved - a.saved;
  return { totals, tools: [...tools.values()].sort(bySaved), projects: [...projects.values()].sort(bySaved).slice(0, 10), daily: [...days.values()] };
}
