import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contextTokens, weighted } from './runner.mjs';
import { FORGE_DIR, fmtTokens, fmtUsd } from './util.mjs';

export function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// One API call can span several transcript lines (one per content block) carrying the same usage; count each message id once.
export function meterTranscript(file) {
  const seen = new Set();
  const s = { file, calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, weighted: 0, peakCtx: 0, firstCtx: 0, lastCtx: 0, start: null, end: null, models: {} };
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const m = r.message;
    if (r.type !== 'assistant' || !m || !m.usage) continue;
    const id = m.id || r.uuid;
    if (seen.has(id)) continue;
    seen.add(id);
    const u = m.usage;
    const ctx = contextTokens(u);
    s.calls++;
    s.input += u.input_tokens || 0;
    s.cacheWrite += u.cache_creation_input_tokens || 0;
    s.cacheRead += u.cache_read_input_tokens || 0;
    s.output += u.output_tokens || 0;
    s.weighted += weighted(u);
    s.peakCtx = Math.max(s.peakCtx, ctx);
    if (!s.firstCtx) s.firstCtx = ctx;
    s.lastCtx = ctx;
    if (m.model) s.models[m.model] = (s.models[m.model] || 0) + 1;
    if (r.timestamp) {
      s.start ??= r.timestamp;
      s.end = r.timestamp;
    }
  }
  s.avgCtx = s.calls ? Math.round((s.input + s.cacheWrite + s.cacheRead) / s.calls) : 0;
  return s;
}

// A session's subagents write their own transcripts under <session>/subagents/.
export function sessionFiles(file) {
  const files = [file];
  const sub = path.join(file.replace(/\.jsonl$/, ''), 'subagents');
  try {
    for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) files.push(path.join(sub, f));
  } catch {}
  return files;
}

export function projectKey(cwd) {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

export function listTranscripts({ cwd, all } = {}) {
  const root = path.join(configDir(), 'projects');
  let dirs = [];
  try {
    dirs = fs.readdirSync(root).map((d) => path.join(root, d));
  } catch {
    return [];
  }
  if (!all && cwd) dirs = dirs.filter((d) => path.basename(d) === projectKey(cwd));
  const out = [];
  for (const d of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(d);
    } catch {}
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(d, f);
      try {
        out.push({ path: p, mtime: fs.statSync(p).mtimeMs });
      } catch {}
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).map((x) => x.path);
}

function merge(stats) {
  const t = { calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, weighted: 0, peakCtx: 0 };
  for (const s of stats) {
    for (const k of ['calls', 'input', 'cacheWrite', 'cacheRead', 'output', 'weighted']) t[k] += s[k];
    t.peakCtx = Math.max(t.peakCtx, s.peakCtx);
  }
  t.avgCtx = t.calls ? Math.round((t.input + t.cacheWrite + t.cacheRead) / t.calls) : 0;
  return t;
}

export function meterSessions(files) {
  return files.map((f) => {
    const parts = sessionFiles(f).map(meterTranscript);
    const total = merge(parts);
    return { file: f, session: path.basename(f, '.jsonl'), subagents: parts.length - 1, start: parts[0].start, end: parts[0].end, ...total };
  });
}

export function meterLedger(root) {
  const file = path.join(root, FORGE_DIR, 'ledger.jsonl');
  if (!fs.existsSync(file)) return null;
  const t = { attempts: 0, turns: 0, costUsd: 0, weighted: 0, peakCtx: 0, ctxSum: 0, tasks: new Set(), passes: 0 };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    t.attempts++;
    t.turns += r.turns || 0;
    t.costUsd += r.costUsd || 0;
    t.weighted += weighted(r.usage);
    t.peakCtx = Math.max(t.peakCtx, contextTokens(r.usage));
    t.tasks.add(r.task);
    if (r.outcome === 'pass') t.passes++;
  }
  return { ...t, tasks: t.tasks.size };
}

export function formatSessions(rows) {
  const head = 'session   calls  avg ctx  peak ctx   input  cache-w  cache-r  output  input-equiv';
  const lines = rows.map((r) =>
    [
      r.session.slice(0, 8),
      String(r.calls).padStart(6),
      fmtTokens(r.avgCtx).padStart(8),
      fmtTokens(r.peakCtx).padStart(9),
      fmtTokens(r.input).padStart(7),
      fmtTokens(r.cacheWrite).padStart(8),
      fmtTokens(r.cacheRead).padStart(8),
      fmtTokens(r.output).padStart(7),
      fmtTokens(Math.round(r.weighted)).padStart(12),
    ].join(' ') + (r.subagents ? `  (+${r.subagents} subagents)` : ''),
  );
  const t = merge(rows);
  lines.push(
    ['TOTAL   ', String(t.calls).padStart(6), fmtTokens(t.avgCtx).padStart(8), fmtTokens(t.peakCtx).padStart(9), fmtTokens(t.input).padStart(7), fmtTokens(t.cacheWrite).padStart(8), fmtTokens(t.cacheRead).padStart(8), fmtTokens(t.output).padStart(7), fmtTokens(Math.round(t.weighted)).padStart(12)].join(' '),
  );
  return [head, ...lines, 'input-equiv = input + 1.25 x cache-write + 0.1 x cache-read + 5 x output (relative price weights)'].join('\n');
}

export function formatLedger(l) {
  return `forge workers: ${l.tasks} task(s), ${l.attempts} attempt(s), ${l.passes} passed, ${l.turns} turns, peak ctx ${fmtTokens(l.peakCtx)}, ${fmtTokens(Math.round(l.weighted))} input-equiv tokens, ${fmtUsd(l.costUsd)} (CLI-reported)`;
}
