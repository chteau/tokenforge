// Incremental token-usage scanner over Claude Code transcripts.
// Transcripts only grow, so each file is read from where the last scan stopped; results persist in a cache file.
// Only numbers leave this module: no message text is kept.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir } from './meter.mjs';

const CACHE_VERSION = 2;
const CHUNK = 4 << 20;
const BLOCK_MS = 5 * 3600 * 1000;

// Call record: [epochSeconds, input, cacheWrite, cacheRead, output, modelIndex]
export const weightedOf = (c) => c[1] + 1.25 * c[2] + 0.1 * c[3] + 5 * c[4];
export const contextOf = (c) => c[1] + c[2] + c[3];

export function cacheBase() {
  const base = process.env.XDG_CACHE_HOME || (process.platform === 'win32' ? process.env.LOCALAPPDATA : null) || path.join(os.homedir(), '.cache');
  return path.join(base, 'tokenforge');
}

const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/;

// Agent worktrees (<repo>/.claude/worktrees/<name>) belong to their repo.
export const projectOf = (cwd) => (cwd ? cwd.split(/[\\/]\.claude[\\/]worktrees[\\/]/)[0] : null);
const ID_RE = /"message":\{[^]*?"id":"([^"]+)"/;

function listFiles(root) {
  const out = [];
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const pdir = path.join(root, d.name);
    let entries = [];
    try {
      entries = fs.readdirSync(pdir, { withFileTypes: true });
    } catch {}
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.join(pdir, e.name));
      else if (e.isDirectory()) {
        const sub = path.join(pdir, e.name, 'subagents');
        try {
          for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) out.push(path.join(sub, f));
        } catch {}
      }
    }
  }
  return out;
}

export class UsageStore {
  constructor({ root = path.join(configDir(), 'projects'), cacheFile = path.join(cacheBase(), `usage-v${CACHE_VERSION}.json`) } = {}) {
    this.root = root;
    this.cacheFile = cacheFile;
    this.models = [];
    this.modelIndex = new Map();
    this.files = {};
    this.progress = { done: 0, total: 0, scanning: false };
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c.version === CACHE_VERSION) {
        this.files = c.files;
        this.models = c.models;
        this.models.forEach((m, i) => this.modelIndex.set(m, i));
      }
    } catch {}
  }

  model(name) {
    let i = this.modelIndex.get(name);
    if (i === undefined) {
      i = this.models.push(name) - 1;
      this.modelIndex.set(name, i);
    }
    return i;
  }

  // Parse new bytes of one transcript into its entry. Returns true if anything changed.
  scanFile(file) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return false;
    }
    let e = this.files[file];
    if (e && e.size === st.size && e.mtime === st.mtimeMs) return false;
    if (!e || st.size < e.offset) {
      const sub = file.includes(`${path.sep}subagents${path.sep}`);
      const session = sub ? path.basename(path.dirname(path.dirname(file))) : path.basename(file, '.jsonl');
      e = this.files[file] = { size: 0, mtime: 0, offset: 0, lastId: null, project: null, session, sub: sub ? 1 : 0, calls: [] };
    }
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(CHUNK);
      let pos = e.offset;
      let carry = '';
      while (pos < st.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - pos), pos);
        if (n <= 0) break;
        pos += n;
        const text = carry + buf.toString('utf8', 0, n);
        const lines = text.split('\n');
        carry = lines.pop();
        for (const line of lines) this.ingest(e, line);
        e.offset = pos - Buffer.byteLength(carry);
      }
    } finally {
      fs.closeSync(fd);
    }
    e.size = st.size;
    e.mtime = st.mtimeMs;
    return true;
  }

  ingest(e, line) {
    if (!e.project && line.includes('"cwd"')) {
      const m = CWD_RE.exec(line);
      if (m) {
        try {
          e.project = projectOf(JSON.parse(`"${m[1]}"`));
        } catch {}
      }
    }
    if (!line.includes('"usage"') || !line.includes('"type":"assistant"')) return;
    // Content blocks of one API response share an id and its usage: count each response once.
    const idm = ID_RE.exec(line.slice(0, 600));
    if (idm && idm[1] === e.lastId) return;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      return;
    }
    const m = r.message;
    const u = m && m.usage;
    if (!u) return;
    if (m.id && m.id === e.lastId) return;
    e.lastId = m.id || null;
    const ts = Math.round(Date.parse(r.timestamp) / 1000) || 0;
    e.calls.push([ts, u.input_tokens || 0, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0, u.output_tokens || 0, this.model(m.model || '?')]);
  }

  // Scan all transcripts; yields to the event loop between files so the server stays responsive.
  async refresh() {
    if (this.progress.scanning) return false;
    this.progress = { done: 0, total: 0, scanning: true };
    let changed = false;
    try {
      const files = listFiles(this.root);
      this.progress.total = files.length;
      const live = new Set(files);
      for (const f of Object.keys(this.files)) if (!live.has(f)) {
        delete this.files[f];
        changed = true;
      }
      for (const f of files) {
        if (this.scanFile(f)) changed = true;
        this.progress.done++;
        if (this.progress.done % 25 === 0) await new Promise((r) => setImmediate(r));
      }
      // Subagent transcripts inherit the project of their parent session.
      const byId = new Map(Object.values(this.files).filter((e) => !e.sub).map((e) => [e.session, e.project]));
      for (const e of Object.values(this.files)) if (e.sub && !e.project) e.project = byId.get(e.session) || null;
      if (changed) this.save();
    } finally {
      this.progress.scanning = false;
      this.lastRefresh = Date.now();
    }
    return changed;
  }

  save() {
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    const tmp = `${this.cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, models: this.models, files: this.files }));
    fs.renameSync(tmp, this.cacheFile);
  }

  // Every call with its file's project/session/sub flag, optionally filtered.
  *calls(filter = {}) {
    for (const e of Object.values(this.files)) {
      if (filter.project && e.project !== filter.project) continue;
      if (filter.session && e.session !== filter.session) continue;
      for (const c of e.calls) yield { c, e };
    }
  }
}

const zero = () => ({ calls: 0, input: 0, cw: 0, cr: 0, out: 0, weq: 0 });
function add(t, c) {
  t.calls++;
  t.input += c[1];
  t.cw += c[2];
  t.cr += c[3];
  t.out += c[4];
  t.weq += weightedOf(c);
}

const dayKey = (ts) => {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Claude subscription windows: 5 hours from the first message after the previous window ended.
// The start is floored to the hour, matching how the window is commonly observed. This is an estimate.
export function blocks(sortedTs) {
  const out = [];
  let cur = null;
  for (const ts of sortedTs) {
    const ms = ts * 1000;
    if (!cur || ms >= cur.end) {
      const start = Math.floor(ms / 3.6e6) * 3.6e6;
      cur = { start, end: start + BLOCK_MS, n: 0 };
      out.push(cur);
    }
    cur.n++;
  }
  return out;
}

export function overview(store, now = Date.now()) {
  const nowS = now / 1000;
  const today = dayKey(nowS);
  const totals = { today: zero(), d7: zero(), d30: zero(), all: zero() };
  const days = new Map();
  const hours = new Map();
  const models = new Map();
  const all = [];
  for (const { c } of store.calls()) {
    add(totals.all, c);
    const age = nowS - c[0];
    if (age <= 30 * 86400) {
      add(totals.d30, c);
      const k = dayKey(c[0]);
      if (!days.has(k)) days.set(k, zero());
      add(days.get(k), c);
      const mk = store.models[c[5]] || '?';
      if (!models.has(mk)) models.set(mk, zero());
      add(models.get(mk), c);
    }
    if (age <= 7 * 86400) add(totals.d7, c);
    if (dayKey(c[0]) === today) add(totals.today, c);
    if (age <= 48 * 3600) {
      const h = Math.floor(c[0] / 3600) * 3600;
      if (!hours.has(h)) hours.set(h, zero());
      add(hours.get(h), c);
    }
    all.push(c);
  }
  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const k = dayKey(nowS - i * 86400);
    daily.push({ day: k, ...(days.get(k) || zero()) });
  }
  const hourly = [];
  const h0 = Math.floor(nowS / 3600) * 3600;
  for (let i = 47; i >= 0; i--) hourly.push({ hour: h0 - i * 3600, ...(hours.get(h0 - i * 3600) || zero()) });
  all.sort((a, b) => a[0] - b[0]);
  const bl = blocks(all.map((c) => c[0]));
  // Attach usage per block for the last 7 days.
  const recent = bl.filter((b) => b.end > now - 7 * 86400e3);
  for (const b of recent) b.weq = 0;
  let bi = 0;
  for (const c of all) {
    const ms = c[0] * 1000;
    while (bi < recent.length && ms >= recent[bi].end) bi++;
    if (bi < recent.length && ms >= recent[bi].start) recent[bi].weq += weightedOf(c);
  }
  const active = recent.find((b) => b.start <= now && now < b.end) || null;
  return {
    totals,
    daily,
    hourly,
    models: [...models.entries()].map(([model, t]) => ({ model, ...t })).sort((a, b) => b.weq - a.weq),
    blocks: recent.map((b) => ({ start: b.start, end: b.end, calls: b.n, weq: Math.round(b.weq) })),
    activeBlock: active && { start: active.start, end: active.end, calls: active.n, weq: Math.round(active.weq) },
  };
}

export function projects(store) {
  const map = new Map();
  for (const e of Object.values(store.files)) {
    const key = e.project || '(unknown)';
    if (!map.has(key)) map.set(key, { project: key, sessions: new Set(), ...zero(), subWeq: 0, last: 0 });
    const p = map.get(key);
    p.sessions.add(e.session);
    for (const c of e.calls) {
      add(p, c);
      if (e.sub) p.subWeq += weightedOf(c);
      if (c[0] > p.last) p.last = c[0];
    }
  }
  return [...map.values()].map((p) => ({ ...p, sessions: p.sessions.size })).filter((p) => p.calls > 0).sort((a, b) => b.last - a.last);
}

export function sessions(store, project) {
  const map = new Map();
  for (const e of Object.values(store.files)) {
    if (project && e.project !== project) continue;
    if (!map.has(e.session)) map.set(e.session, { session: e.session, project: e.project, ...zero(), subCalls: 0, subWeq: 0, subagents: 0, start: Infinity, end: 0, ctxSum: 0, peakCtx: 0 });
    const s = map.get(e.session);
    if (e.sub) s.subagents++;
    for (const c of e.calls) {
      add(s, c);
      if (e.sub) {
        s.subCalls++;
        s.subWeq += weightedOf(c);
      } else {
        s.ctxSum += contextOf(c);
        s.peakCtx = Math.max(s.peakCtx, contextOf(c));
      }
      s.start = Math.min(s.start, c[0]);
      s.end = Math.max(s.end, c[0]);
    }
  }
  return [...map.values()]
    .filter((s) => s.calls > 0)
    .map(({ ctxSum, ...s }) => ({ ...s, avgCtx: s.calls - s.subCalls ? Math.round(ctxSum / (s.calls - s.subCalls)) : 0 }))
    .sort((a, b) => b.end - a.end);
}

// Context size per main-thread call (the curve that drives cost), plus per-subagent totals.
export function sessionDetail(store, id) {
  const main = [];
  const subs = [];
  for (const e of Object.values(store.files)) {
    if (e.session !== id) continue;
    if (e.sub) {
      const t = zero();
      let peak = 0;
      for (const c of e.calls) {
        add(t, c);
        peak = Math.max(peak, contextOf(c));
      }
      subs.push({ ...t, peakCtx: peak, avgCtx: t.calls ? Math.round((t.input + t.cw + t.cr) / t.calls) : 0 });
    } else {
      for (const c of e.calls) main.push({ ts: c[0], ctx: contextOf(c), weq: Math.round(weightedOf(c)), out: c[4], cw: c[2] });
    }
  }
  main.sort((a, b) => a.ts - b.ts);
  return { session: id, main, subagents: subs.sort((a, b) => b.weq - a.weq) };
}
