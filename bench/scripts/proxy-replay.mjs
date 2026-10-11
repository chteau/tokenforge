#!/usr/bin/env node
// Offline estimate of what the proxy's compression would have saved on real sessions: replays Claude Code
// transcripts (~/.claude/projects/**/*.jsonl) through the proxy's compressResult, without calling the API.
// Prints aggregates only (counts, chars, tokens), never content.
//
//   node bench/scripts/proxy-replay.mjs [--days 30] [--exclude regex] [--json]
//
// Model: a result compressed by S chars is first written to the cache (1.25x) by the next request, then read
// (0.1x) by every later request until the next /compact. Input cost units = uncached + 1.25 x cache writes +
// 0.1 x cache reads, from the transcripts' real usage. Overestimates a little: Claude Code clears some old tool
// results itself. Cannot measure behavior changes (an Edit that misses because the Read was folded); it counts
// how often a folded Read was followed by an Edit of that file, which is the exposure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { compressResult } from '../../lib/proxy.mjs';

const argv = process.argv.slice(2);
const opt = (name, d) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : d);
const days = Number(opt('--days', 30));
const exclude = new RegExp(opt('--exclude', 'benchmarks-results|bench-runs|tforge-test'));
const root = path.join(os.homedir(), '.claude', 'projects');
const since = Date.now() - days * 86400e3;

function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(f);
    else if (e.name.endsWith('.jsonl') && fs.statSync(f).mtimeMs >= since) yield f;
  }
}

const tot = { sessions: 0, requests: 0, units: 0, results: 0, resultChars: 0, compressed: 0, saved: 0, savedUnits: 0, byTool: {}, foldedReads: 0, foldedThenEdited: 0, editErrors: 0, edits: 0 };
const noSave = () => null; // capped output keeps its full text in a file; nothing is written here

async function replay(file) {
  const tools = new Map();
  const usageById = new Map();
  let requests = 0;
  let pending = []; // { units, at } per compressed result in the current segment
  const folded = new Set();
  const close = () => {
    for (const p of pending) {
      const after = requests - p.at;
      if (after >= 1) tot.savedUnits += (p.chars / 4) * (1.25 + 0.1 * (after - 1));
    }
    pending = [];
  };
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      close();
      continue;
    }
    const m = e.message;
    if (!m || !Array.isArray(m.content)) continue;
    if (e.type === 'assistant') {
      if (m.id && !usageById.has(m.id)) requests++;
      if (m.id && m.usage) usageById.set(m.id, m.usage);
      for (const b of m.content) {
        if (b?.type !== 'tool_use') continue;
        tools.set(b.id, b);
        if (/^(Edit|MultiEdit)$/.test(b.name)) {
          tot.edits++;
          if (folded.has(String(b.input?.file_path))) tot.foldedThenEdited++;
        }
      }
    } else if (e.type === 'user') {
      for (const b of m.content) {
        if (b?.type !== 'tool_result') continue;
        const t = tools.get(b.tool_use_id);
        if (t && /^(Edit|MultiEdit)$/.test(t.name) && b.is_error) tot.editErrors++;
        const before = typeof b.content === 'string' ? b.content.length : JSON.stringify(b.content ?? '').length;
        tot.results++;
        tot.resultChars += before;
        let c = null;
        try {
          c = compressResult(b, t, { saveFull: noSave });
        } catch {}
        if (c == null) continue;
        const chars = before - (typeof c === 'string' ? c.length : JSON.stringify(c).length);
        const name = t?.name?.startsWith('mcp__') ? 'mcp' : t?.name || '?';
        const bt = (tot.byTool[name] ||= { n: 0, saved: 0 });
        bt.n++;
        bt.saved += chars;
        tot.compressed++;
        tot.saved += chars;
        pending.push({ chars, at: requests });
        if (t?.name === 'Read') {
          tot.foldedReads++;
          folded.add(String(t.input?.file_path));
        }
      }
    }
  }
  close();
  for (const u of usageById.values()) tot.units += (u.input_tokens || 0) + 1.25 * (u.cache_creation_input_tokens || 0) + 0.1 * (u.cache_read_input_tokens || 0);
  tot.requests += requests;
  if (requests) tot.sessions++;
}

for (const f of files(root)) if (!exclude.test(f)) await replay(f);

if (argv.includes('--json')) console.log(JSON.stringify(tot, null, 2));
else {
  const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
  console.log(`proxy replay, last ${days} days: ${tot.sessions} transcripts, ${tot.requests} requests`);
  console.log(`  tool results   ${tot.results} (${k(tot.resultChars)} chars); ${tot.compressed} would be compressed, ${k(tot.saved)} chars less`);
  console.log(`  input cost     ${k(tot.units)} units (uncached + 1.25 x writes + 0.1 x reads); saved ~${k(tot.savedUnits)} (${((100 * tot.savedUnits) / (tot.units || 1)).toFixed(1)}%)`);
  console.log(`  by tool        ${Object.entries(tot.byTool).sort((a, b) => b[1].saved - a[1].saved).map(([n, b]) => `${n} ${b.n}x ${k(b.saved)}`).join(', ')}`);
  console.log(`  folded Reads   ${tot.foldedReads}; ${tot.foldedThenEdited} later Edits of a folded file (exposure); real Edit error rate ${tot.edits ? ((100 * tot.editErrors) / tot.edits).toFixed(1) : 0}%`);
}
