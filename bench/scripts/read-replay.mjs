#!/usr/bin/env node
// Replays recorded benchmark sessions (no API calls) to see what code reads through Bash cost, and whether folding
// them would pay: for each `cat`, `sed -n`, `head`/`tail` and Read of a file, the size of its result, how many later
// requests re-sent it, and whether the same lines were read again later in the session (what a fold would force).
//
//   node bench/scripts/read-replay.mjs [--since 2026-10-10] [--agent token-forge+proxy] [--lean ultra] [--json]
//
// A read counts as re-read when a later read of the same file covers at least half of its lines; an Edit or Write of
// that file in between is reported apart (reading it again after changing it is expected).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i < 0 ? d : args[i + 1];
};
const SINCE = opt('since', '2026-10-10');
const AGENT = opt('agent', 'token-forge+proxy');
const LEAN = opt('lean', null);
const JSON_OUT = args.includes('--json');
const BUCKETS = [2000, 4000, 8000, 16000, Infinity];

// Shell words of one simple command; quotes removed. Good enough for the read commands this looks for.
function words(s) {
  const out = [];
  let cur = '', q = null, any = false;
  for (const c of s) {
    if (q) {
      if (c === q) q = null;
      else cur += c;
    } else if (c === '"' || c === "'") (q = c), (any = true);
    else if (/\s/.test(c)) {
      if (cur || any) out.push(cur);
      cur = '';
      any = false;
    } else cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}

// The reads in a Bash command: [{ kind, file, from, to }] (to = Infinity for a whole file or a tail).
export function bashReads(cmd, cwd) {
  if (/<<-?\s*['"]?\w/.test(cmd)) return []; // heredoc bodies are writes
  const reads = [];
  for (const seg of cmd.split(/&&|\|\||;|\n/)) {
    const stages = seg.split('|');
    const w = words(stages[0].trim().replace(/^(\w+=\S*\s+)+/, ''));
    if (!w.length || /[<>]/.test(stages[0])) continue;
    const abs = (f) => path.resolve(cwd || '/', f);
    const files = (xs) => xs.filter((x) => !x.startsWith('-') && !/[*?]/.test(x));
    if (w[0] === 'cat') for (const f of files(w.slice(1))) reads.push({ kind: 'cat', file: abs(f), from: 1, to: Infinity });
    else if (w[0] === 'sed' && w[1] === '-n') {
      const m = /^(\d+)(?:,(\d+|\$))?p$/.exec(w[2] || '');
      if (m) for (const f of files(w.slice(3))) reads.push({ kind: 'sed -n', file: abs(f), from: +m[1], to: m[2] === '$' ? Infinity : +(m[2] || m[1]) });
    } else if (w[0] === 'nl' && stages[1] && /sed -n/.test(stages[1])) {
      const m = /(\d+),(\d+)p/.exec(stages[1]);
      if (m) for (const f of files(w.slice(1))) reads.push({ kind: 'sed -n', file: abs(f), from: +m[1], to: +m[2] });
    } else if (w[0] === 'head' || w[0] === 'tail') {
      const n = Number((w.find((x) => /^-n?\d+$/.test(x)) || '-10').replace(/^-n?/, '')) || 10;
      const i = w.indexOf('-n');
      const count = i >= 0 ? Number(w[i + 1]) || n : n;
      for (const f of files(w.slice(1)).filter((x) => x !== String(count))) reads.push({ kind: w[0], file: abs(f), from: w[0] === 'head' ? 1 : -count, to: w[0] === 'head' ? count : Infinity });
    }
  }
  return reads;
}

// Files a Bash command writes: `tkit edit` blocks (`@@ path`), `cat > FILE <<EOF` (or >>), `sed -i … FILE`, `tee FILE`.
export function bashEdits(cmd, cwd) {
  const abs = (f) => path.resolve(cwd || '/', f.replace(/^['"]|['"]$/g, ''));
  const out = [];
  if (/\btkit\s+edit\b/.test(cmd)) for (const m of cmd.matchAll(/^@@\s+([^\s:]+(?::(?!\d)[^\s]*)?)/gm)) out.push(abs(m[1]));
  for (const m of cmd.matchAll(/\bcat\s*>>?\s*(['"]?[^\s'"|;&<>]+['"]?)\s*<</g)) out.push(abs(m[1]));
  for (const m of cmd.matchAll(/\bsed\s+-i\S*\s+(?:-e\s+)?(?:'[^']*'|"[^"]*"|\S+)\s+([^\s;&|]+)/g)) out.push(abs(m[1]));
  for (const m of cmd.matchAll(/\btee\s+(?:-a\s+)?([^\s;&|]+)/g)) out.push(abs(m[1]));
  return [...new Set(out)];
}

const len = (c) => (typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((s, x) => s + (x.text?.length || 0), 0) : 0);

// One session: its reads in order, each with result size, requests after it, and whether it was read again.
export function replaySession(events) {
  const calls = new Map(); // tool_use id -> { reads, req }
  const reads = [];
  const edits = []; // { file, req }
  let req = 0, cwd = null;
  for (const e of events) {
    if (e.type === 'system' && e.cwd) cwd = e.cwd;
    if (e.type === 'assistant') {
      req++;
      for (const c of e.message?.content || []) {
        if (c.type !== 'tool_use') continue;
        const i = c.input || {};
        if (c.name === 'Bash') {
          calls.set(c.id, { reads: bashReads(String(i.command || ''), cwd), req });
          for (const file of bashEdits(String(i.command || ''), cwd)) edits.push({ file, req });
        }
        else if (c.name === 'Read' && i.file_path) {
          const from = i.offset || 1;
          calls.set(c.id, { reads: [{ kind: 'Read', file: i.file_path, from, to: i.limit ? from + i.limit - 1 : Infinity }], req });
        } else if (['Edit', 'Write', 'MultiEdit'].includes(c.name) && i.file_path) edits.push({ file: i.file_path, req });
      }
    }
    if (e.type === 'user')
      for (const c of Array.isArray(e.message?.content) ? e.message.content : []) {
        const call = c.type === 'tool_result' && calls.get(c.tool_use_id);
        if (!call || !call.reads.length) continue;
        const size = len(c.content);
        // a compound command's result is shared by its reads
        for (const r of call.reads) reads.push({ ...r, chars: Math.round(size / call.reads.length), req: call.req, alone: call.reads.length === 1 });
      }
  }
  const total = req;
  for (const [i, r] of reads.entries()) {
    r.after = total - r.req;
    const span = (x) => (x.to === Infinity || x.from < 0 ? null : [x.from, x.to]);
    const again = reads.slice(i + 1).find((x) => {
      if (x.file !== r.file || x.req === r.req) return false;
      const a = span(r), b = span(x);
      if (!a || !b) return true; // a whole file or a tail on either side: same lines
      const overlap = Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]) + 1);
      return overlap >= (a[1] - a[0] + 1) / 2;
    });
    r.reread = !!again;
    r.editedBefore = !!again && edits.some((ed) => ed.file === r.file && ed.req >= r.req && ed.req <= again.req);
    // After the first edit of the file that follows this read: what the session did with the file next. 'none'
    // means the read only cost re-sends from then on; 'edit' means a later edit leaned on it (or on memory).
    const ed = edits.find((x) => x.file === r.file && x.req > r.req);
    if (ed) {
      r.editReq = ed.req;
      r.afterEdit = total - ed.req;
      const nextRead = reads.find((x, j) => j > i && x.file === r.file && x.req > ed.req);
      const nextEdit = edits.find((x) => x.file === r.file && x.req > ed.req);
      r.useAfterEdit = nextRead && (!nextEdit || nextRead.req <= nextEdit.req) ? 'read' : nextEdit ? 'edit' : 'none';
    }
  }
  return reads;
}

function sessions() {
  const out = [];
  for (const s of fs.readdirSync(path.join(BENCH, 'runs')).filter((d) => d >= SINCE).sort()) {
    const sdir = path.join(BENCH, 'runs', s);
    for (const task of fs.readdirSync(sdir).filter((t) => fs.statSync(path.join(sdir, t)).isDirectory())) {
      for (const run of fs.readdirSync(path.join(sdir, task)).filter((r) => r.startsWith(`${AGENT}-r`))) {
        const dir = path.join(sdir, task, run);
        const stream = path.join(dir, 'stream.jsonl');
        if (!fs.existsSync(stream)) continue;
        if (LEAN) {
          try {
            if (JSON.parse(fs.readFileSync(path.join(dir, 'environment_manifest.json'), 'utf8')).token_forge_lean !== LEAN) continue;
          } catch {
            continue;
          }
        }
        const events = fs.readFileSync(stream, 'utf8').split('\n').filter(Boolean).map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return {};
          }
        });
        out.push({ id: `${s}/${task}/${run}`, task, reads: replaySession(events), results: events.flatMap((e) => (e.type === 'user' && Array.isArray(e.message?.content) ? e.message.content.filter((c) => c.type === 'tool_result').map((c) => len(c.content)) : [])) });
      }
    }
  }
  return out;
}

function report(all) {
  const reads = all.flatMap((s) => s.reads);
  const allChars = all.reduce((t, s) => t + s.results.reduce((a, b) => a + b, 0), 0);
  const kinds = [...new Set(reads.map((r) => r.kind))];
  const rows = kinds.map((k) => {
    const xs = reads.filter((r) => r.kind === k);
    const chars = xs.reduce((t, r) => t + r.chars, 0);
    const resent = xs.reduce((t, r) => t + r.chars * r.after, 0);
    const bucket = BUCKETS.map((b, i) => xs.filter((r) => r.chars < b && r.chars >= (BUCKETS[i - 1] || 0)).length);
    const big = xs.filter((r) => r.chars >= 4000);
    const rr = (ys) => (ys.length ? ys.filter((r) => r.reread && !r.editedBefore).length / ys.length : 0);
    return { kind: k, reads: xs.length, chars, share: allChars ? chars / allChars : 0, resent, bucket, rereadAll: rr(xs), rereadBig: rr(big), big: big.length, bigChars: big.reduce((t, r) => t + r.chars, 0), bigNoReread: big.filter((r) => !r.reread).length };
  });
  // reads whose file was edited later in the session: what pruning them after that edit (same turn) would touch
  const ed = reads.filter((r) => r.editReq);
  const by = (u) => ed.filter((r) => r.useAfterEdit === u);
  const afterEdit = Object.fromEntries(['none', 'read', 'edit'].map((u) => [u, { reads: by(u).length, chars: by(u).reduce((t, r) => t + r.chars, 0), resent: by(u).reduce((t, r) => t + r.chars * r.afterEdit, 0) }]));
  return { sessions: all.length, tasks: [...new Set(all.map((s) => s.task))].length, allChars, rows: rows.sort((a, b) => b.chars - a.chars), afterEdit };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const r = report(sessions());
  if (JSON_OUT) console.log(JSON.stringify(r, null, 2));
  else {
    const pct = (x) => `${(100 * x).toFixed(0)}%`;
    const k = (n) => `${(n / 1000).toFixed(0)}k`;
    console.log(`${r.sessions} sessions (${AGENT}${LEAN ? `, lean ${LEAN}` : ''}, since ${SINCE}), ${r.tasks} tasks, ${k(r.allChars)} chars of tool results\n`);
    console.log('| read | reads | chars | share of tool results | chars x later requests | <2k / 2-4k / 4-8k / 8-16k / 16k+ | read again (no edit between) | 4k+ reads, read again | 4k+ never read again |');
    console.log('|---|---|---|---|---|---|---|---|---|');
    for (const x of r.rows)
      console.log(`| ${x.kind} | ${x.reads} | ${k(x.chars)} | ${pct(x.share)} | ${k(x.resent)} | ${x.bucket.join(' / ')} | ${pct(x.rereadAll)} | ${pct(x.rereadBig)} of ${x.big} | ${x.bigNoReread} (${k(x.bigChars)} chars in all 4k+) |`);
    console.log('\nReads of a file edited later in the session, by what came next after that edit:\n');
    console.log('| next use of the file | reads | chars | chars x requests after the edit |');
    console.log('|---|---|---|---|');
    const label = { none: 'none (never read or edited again)', read: 'read again first', edit: 'edited again without reading' };
    for (const [u, x] of Object.entries(r.afterEdit)) console.log(`| ${label[u]} | ${x.reads} | ${k(x.chars)} | ${k(x.resent)} |`);
  }
}
