// `tread`: read several pieces of code in ONE call. A lookup that needs `grep -n` first and `sed -n` second costs a
// round trip, and every round trip re-reads the whole context (measured: ~37k tokens at the median follow-up call,
// about two such pairs per session). Specs, any mix:
//   NAME | Type.method     the definition(s) of a symbol, located with the code index (regex fallback otherwise)
//   path:40-80 | path:40   those lines (one line: with 5 lines around it)
//   path:/regex/           the definition enclosing each match, or 5 lines around it
//   path                   the whole file (long bodies folded when large, like tview)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existingBinary } from './tmapbin.mjs';
import { heuristicOutline, outline, view } from './view.mjs';

export const MAX_LINES = Number(process.env.TFORGE_READ_MAX_LINES) || 600;
const AROUND = 5;

const readLines = (f) => {
  const t = fs.readFileSync(f, 'utf8');
  const l = t.split('\n');
  if (t.endsWith('\n')) l.pop();
  return l;
};

// Definition ranges of a file, from tmap's outline or the language-agnostic fallback.
function defs(file, lines) {
  const items = outline(file);
  return items && items.length ? items : heuristicOutline(lines);
}

function enclosing(file, lines, ln) {
  const d = defs(file, lines).filter((it) => it.a <= ln && ln <= it.b && it.b - it.a < 400);
  if (d.length) {
    const best = d.reduce((x, y) => (y.b - y.a < x.b - x.a ? y : x)); // innermost
    return [best.a, best.b];
  }
  return [Math.max(1, ln - AROUND), Math.min(lines.length, ln + AROUND)];
}

const SOURCE = /\.(rs|ts|tsx|js|jsx|mjs|cjs|py|go|lua|luau|rb|java|kt|kts|cs|c|cc|cpp|h|hpp|php|swift|scala|ex|exs|dart|zig)$/;

function listFiles(root) {
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  if (r.status === 0) return r.stdout.split('\n').filter((f) => SOURCE.test(f));
  const out = [];
  const walk = (d, depth) => {
    if (depth > 8 || out.length > 5000) return;
    for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      if (e.name.startsWith('.') || ['node_modules', 'target', 'dist', 'build', 'vendor'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (SOURCE.test(e.name)) out.push(p);
    }
  };
  walk('.', 0);
  return out;
}

// Symbol -> [{file, a, b}]: tmap's index first, then a definition-shaped regex over source files.
export function locate(name, root) {
  const bin = existingBinary();
  const short = name.split(/[.:#]+/).pop();
  if (bin) {
    const r = spawnSync(bin, ['slice', short, '-C', root], { cwd: root, encoding: 'utf8', timeout: 20000 });
    const hits = (r.stdout || '').split('\n').map((l) => /^(.+):(\d+)-(\d+)$/.exec(l.trim())).filter(Boolean)
      .map((m) => ({ file: m[1], a: Number(m[2]), b: Number(m[3]) }));
    const owner = name.includes('.') || name.includes('::') ? name.split(/[.:#]+/).slice(-2, -1)[0] : null;
    const inRoot = hits.filter((h) => fs.existsSync(path.resolve(root, h.file)));
    if (inRoot.length) {
      // Type.method: prefer definitions whose receiver/class (within 40 lines above) names the owner
      const ofOwner = owner ? inRoot.filter((h) => readLines(path.resolve(root, h.file)).slice(Math.max(0, h.a - 40), h.a).join('\n').includes(owner)) : [];
      return (ofOwner.length ? ofOwner : inRoot).slice(0, 6);
    }
  }
  const esc = short.replace(/[$]/g, '\\$');
  const re = new RegExp(`(?:\\b(?:function|def|fn|func|fun|sub|class|struct|enum|interface|trait|type|impl|module)\\s+(?:[\\w.:]+[.:])?${esc}\\b)|(?:\\b${esc}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]+)?=>))`);
  const out = [];
  for (const f of listFiles(root)) {
    let lines;
    try {
      lines = readLines(path.join(root, f));
    } catch {
      continue;
    }
    lines.forEach((l, i) => {
      if (out.length < 6 && re.test(l)) {
        const [a, b] = enclosing(path.join(root, f), lines, i + 1);
        out.push({ file: f, a: Math.min(a, i + 1), b });
      }
    });
  }
  return out;
}

export function parseSpec(spec, root) {
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(spec);
  if (m && fs.existsSync(path.resolve(root, m[1]))) return { kind: 'range', file: m[1], a: Number(m[2]), b: m[3] ? Number(m[3]) : null };
  const r = /^(.+?):\/(.+)\/([i]?)$/.exec(spec);
  if (r && fs.existsSync(path.resolve(root, r[1]))) return { kind: 'regex', file: r[1], re: new RegExp(r[2], r[3]) };
  if (fs.existsSync(path.resolve(root, spec)) && fs.statSync(path.resolve(root, spec)).isFile()) return { kind: 'file', file: spec };
  if (/^[A-Za-z_$][\w$]*(?:(?:\.|::|#)[A-Za-z_$][\w$]*)*$/.test(spec)) return { kind: 'symbol', name: spec };
  return { kind: 'unknown', spec };
}

// Merge overlapping/adjacent ranges per file so nothing prints twice.
function merge(ranges) {
  const by = new Map();
  for (const r of ranges) by.set(r.file, [...(by.get(r.file) || []), r]);
  const out = [];
  for (const rs of by.values()) {
    rs.sort((x, y) => x.a - y.a);
    let cur = null;
    for (const r of rs) {
      if (cur && r.a <= cur.b + 2) (cur.b = Math.max(cur.b, r.b), (cur.why = [...new Set([...cur.why, ...r.why])]));
      else (cur && out.push(cur), (cur = { ...r, why: [...r.why] }));
    }
    if (cur) out.push(cur);
  }
  return out;
}

export function read(specs, root = process.cwd()) {
  const ranges = [];
  const notes = [];
  const wholeFiles = [];
  for (const spec of specs) {
    const s = parseSpec(spec, root);
    if (s.kind === 'file') wholeFiles.push(s.file);
    else if (s.kind === 'range') {
      const n = readLines(path.resolve(root, s.file)).length;
      const [a, b] = s.b ? [s.a, s.b] : [Math.max(1, s.a - AROUND), s.a + AROUND];
      ranges.push({ file: s.file, a: Math.max(1, a), b: Math.min(n, b), why: [spec] });
    } else if (s.kind === 'regex') {
      const f = path.resolve(root, s.file);
      const lines = readLines(f);
      let hits = 0;
      lines.forEach((l, i) => {
        if (hits < 12 && s.re.test(l)) {
          hits++;
          const [a, b] = enclosing(f, lines, i + 1);
          ranges.push({ file: s.file, a, b, why: [spec] });
        }
      });
      if (!hits) notes.push(`${spec}: no match`);
    } else if (s.kind === 'symbol') {
      const hits = locate(s.name, root);
      if (!hits.length) notes.push(`${spec}: no definition found`);
      for (const h of hits) ranges.push({ ...h, why: [spec] });
    } else notes.push(`${spec}: not a file, file:range, file:/regex/ or symbol name`);
  }
  const parts = [];
  let budget = MAX_LINES;
  for (const r of merge(ranges)) {
    if (budget <= 0) {
      notes.push(`more ranges omitted after ${MAX_LINES} lines (TFORGE_READ_MAX_LINES)`);
      break;
    }
    const lines = readLines(path.resolve(root, r.file));
    const b = Math.min(r.b, r.a + budget - 1);
    parts.push(`==> ${r.file}:${r.a}-${b} <==\n${lines.slice(r.a - 1, b).join('\n')}\n`);
    if (b < r.b) notes.push(`${r.file}:${b + 1}-${r.b} not shown (line budget)`);
    budget -= b - r.a + 1;
  }
  if (wholeFiles.length) parts.push(view(wholeFiles.map((f) => path.resolve(root, f))).replaceAll(path.resolve(root) + path.sep, ''));
  if (notes.length) parts.push(`[${notes.join('; ')}]\n`);
  return parts.join('');
}
