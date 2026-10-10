// Local proxy between Claude Code and the API (ANTHROPIC_BASE_URL=http://127.0.0.1:PORT). It logs the size of
// every request and the usage the API reports, and compresses tool results the first time they are sent.
//
// The prompt cache decides what may change: a request whose earlier content differs from the last one is
// written to the cache again at 1.25x instead of read at 0.1x. So only tool results in the newest message are
// compressed, deterministically, and the compressed text is remembered by tool_use_id: every later request
// sends the same bytes. A result the proxy first passed through unchanged (proxy started mid-session) is never
// touched later, and one Claude Code itself rewrote (cleared old results) no longer matches its hash and passes.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { cacheBase } from './usage.mjs';
import { condense, sha, stripAnsi } from './util.mjs';
import { MARKUP, PROSE, foldPlan, heuristicOutline, outlineText } from './view.mjs';
import { NB_MIN_BYTES } from './docread.mjs';

export const DEFAULT_PORT = 7879;
const OFF = new Set(['0', 'false', 'off', 'no']);
const off = (name) => OFF.has(String(process.env[name] ?? '').toLowerCase());
const num = (name, d) => (process.env[name] !== undefined && !Number.isNaN(Number(process.env[name])) ? Number(process.env[name]) : d);

export const proxyDir = () => path.join(cacheBase(), 'proxy');
const MEMO_DAYS = 14;

// ---------- text compressors (pure, deterministic) ----------

// Progress bars rewrite one line with \r: keep what the terminal finally showed. Runs of the same line
// (polling loops, repeated warnings) keep the first one and a count.
export function cleanText(text, { bash = false } = {}) {
  let t = stripAnsi(text);
  if (bash) t = condense(t);
  const out = [];
  let prev = null, reps = 0;
  const flush = () => {
    if (reps === 1) out.push(prev);
    else if (reps > 1) out.push(`[previous line repeated ${reps} more times]`);
    reps = 0;
  };
  for (let line of t.split('\n')) {
    if (line.includes('\r')) {
      const parts = line.split('\r').filter((p) => p.trim());
      line = parts.length ? parts[parts.length - 1] : '';
    }
    if (line === prev && line.trim()) {
      reps++;
      continue;
    }
    flush();
    out.push(line);
    prev = line;
  }
  flush();
  return out.join('\n');
}

// Keep the head and the (larger) tail of long output; the whole text goes to a file the model can grep.
export function capText(text, cap, saveFull) {
  if (!cap || text.length <= cap) return text;
  const lines = text.split('\n');
  const headMax = Math.floor(cap * 0.35), tailMax = cap - headMax;
  let head = 0, hc = 0;
  while (head < lines.length && hc + lines[head].length + 1 <= headMax) hc += lines[head++].length + 1;
  let tl = lines.length, tc = 0;
  while (tl > head && tc + lines[tl - 1].length + 1 <= tailMax) tc += lines[--tl].length + 1;
  if (tl - head < 5) return text.length > cap * 2 ? text.slice(0, headMax) + `\n… [${text.length - cap} chars cut]\n` + text.slice(-tailMax) : text;
  const file = saveFull(text);
  return [...lines.slice(0, head), `… [${tl - head} lines (${text.length - hc - tc} chars) omitted${file ? `; full output: ${file}` : ''}]`, ...lines.slice(tl)].join('\n');
}

// JSON payloads (API responses, MCP tools): no indentation, and long arrays keep their first items, the ones
// that look like errors, and the last ones.
const ARRAY_KEEP = 6;
function crushValue(v, stats) {
  if (Array.isArray(v)) {
    const items = v.map((x) => crushValue(x, stats));
    if (items.length <= ARRAY_KEEP * 2 + 2) return items;
    const keep = new Set([...Array(ARRAY_KEEP).keys(), items.length - 2, items.length - 1]);
    let errs = 0;
    items.forEach((x, i) => {
      if (errs < ARRAY_KEEP && !keep.has(i) && /error|fail|exception|denied|invalid/i.test(JSON.stringify(x))) keep.add(i), errs++;
    });
    const out = [];
    let gap = 0;
    items.forEach((x, i) => {
      if (keep.has(i)) {
        if (gap) out.push(`… ${gap} items omitted`);
        gap = 0;
        out.push(x);
      } else gap++;
    });
    stats.dropped += items.length - keep.size;
    return out;
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, crushValue(x, stats)]));
  return v;
}

export function crushJson(text, saveFull) {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return null;
  let v;
  try {
    v = JSON.parse(t);
  } catch {
    return null;
  }
  const stats = { dropped: 0 };
  const crushed = JSON.stringify(crushValue(v, stats));
  if (crushed.length >= text.length * 0.9) return null;
  if (!stats.dropped) return crushed;
  const file = saveFull(text);
  return `${crushed}\n[${stats.dropped} array items omitted${file ? `; full JSON: ${file}` : ''}]`;
}

// A whole-file Read ("N\tline" per line, maybe followed by a system reminder): fold long definition bodies,
// keeping every kept line's number. Partial reads (offset/limit) are what Edit works from and stay whole.
const NUMBERED = /^\s*(\d+)(\t|→)(.*)$/;
export const READ_MIN = 12000;
export const READ_FOLD_MIN = 20; // fold only when at least this many lines go

export function foldRead(text, file) {
  const raw = text.split('\n');
  let n = 0;
  while (n < raw.length && NUMBERED.test(raw[n])) n++;
  if (n < 40) return null;
  const nums = raw.slice(0, n).map((l) => NUMBERED.exec(l));
  if (Number(nums[0][1]) !== 1) return null;
  const lines = nums.map((m) => m[3]);
  const items = outlineText(lines.join('\n') + '\n', file);
  const plan = foldPlan(lines, items && items.length ? items : heuristicOutline(lines));
  if (!plan) return null;
  let folded = 0;
  const res = plan.map((e) => {
    if (typeof e === 'number') return raw[e - 1];
    const k = e.to - e.from + 1;
    folded += k;
    return `\t${e.indent}… ${k} lines folded: Read offset=${e.from} limit=${k}`;
  });
  if (folded < READ_FOLD_MIN) return null;
  res.push(`[tokenforge: ${folded} lines of long bodies folded; Read with offset/limit before editing inside one]`);
  return [...res, ...raw.slice(n)].join('\n');
}

// ---------- request transform ----------

const resultText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '');

// One tool result's new content, or null to leave it. `tool` is the matching tool_use block.
export function compressResult(block, tool, { saveFull = () => null, cap = num('TFORGE_PROXY_CAP', 16000), fold = !off('TFORGE_PROXY_FOLD') } = {}) {
  const c = block.content;
  // images and documents pass whole; only plain text (a string, or a single text block) is rewritten
  if (Array.isArray(c) && !(c.length === 1 && c[0] && c[0].type === 'text')) return null;
  const text = resultText(c);
  if (text.length < 2000) return null;
  const name = tool ? tool.name : '';
  const input = (tool && tool.input) || {};
  let out = null;
  if (name === 'Read') {
    const file = String(input.file_path || '');
    if (!fold || block.is_error || input.offset != null || input.limit != null || input.pages) return null;
    if (text.length < READ_MIN || PROSE.test(file) || MARKUP.test(file) || (/\.ipynb$/i.test(file) && text.length > NB_MIN_BYTES)) return null;
    out = foldRead(text, file);
  } else {
    const bash = name === 'Bash';
    out = cleanText(text, { bash });
    if (out.length > 8000) out = crushJson(out, saveFull) ?? out;
    if (!block.is_error) out = capText(out, cap, saveFull);
  }
  if (out == null || out.length >= text.length - 200) return null;
  return typeof c === 'string' ? out : [{ ...c[0], text: out }];
}

// Memo of compressed results: Map id -> { h, c, t }; h = hash of the original content.
export function openMemo(file) {
  const map = new Map();
  const cutoff = Date.now() - MEMO_DAYS * 86400e3;
  let stale = 0;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e.t >= cutoff) map.set(e.id, e);
        else stale++;
      } catch {}
    }
  } catch {}
  if (stale && file) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, [...map.values()].map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
  }
  return {
    get: (id) => map.get(id),
    set(id, e) {
      const entry = { id, ...e };
      map.set(id, entry);
      if (!file) return;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    },
    size: () => map.size,
  };
}

const len = (v) => (v == null ? 0 : typeof v === 'string' ? v.length : JSON.stringify(v).length);

// Rewrite a parsed Messages request in place. Returns stats; `changed` says whether anything differs.
export function transformRequest(body, memo, opts = {}) {
  const st = { results: 0, resultChars: 0, fresh: 0, compressed: 0, memoHits: 0, saved: 0, changed: false };
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const tools = new Map();
  for (const m of msgs) if (m.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b && b.type === 'tool_use') tools.set(b.id, b);
  const last = msgs.length - 1;
  msgs.forEach((m, i) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (!b || b.type !== 'tool_result') continue;
      st.results++;
      const before = len(b.content);
      st.resultChars += before;
      const h = sha(b.content ?? '');
      const hit = memo.get(b.tool_use_id);
      if (hit) {
        if (hit.h === h) {
          b.content = hit.c;
          st.memoHits++;
          st.saved += before - len(hit.c);
          st.changed = true;
        }
        continue;
      }
      if (i !== last || opts.compress === false) continue;
      st.fresh++;
      const c = compressResult(b, tools.get(b.tool_use_id), opts);
      if (c == null) continue;
      memo.set(b.tool_use_id, { h, c, t: Date.now() });
      b.content = c;
      st.compressed++;
      st.saved += before - len(c);
      st.changed = true;
    }
  });
  return st;
}

// ---------- usage from the response ----------

export function usageParser(contentType = '') {
  const u = { in: 0, cr: 0, cw: 0, out: 0 };
  const sse = /event-stream/.test(contentType);
  let buf = '';
  const take = (usage) => {
    if (!usage) return;
    if (usage.input_tokens != null) u.in = usage.input_tokens;
    if (usage.cache_read_input_tokens != null) u.cr = usage.cache_read_input_tokens;
    if (usage.cache_creation_input_tokens != null) u.cw = usage.cache_creation_input_tokens;
    if (usage.output_tokens != null) u.out = usage.output_tokens;
  };
  const line = (l) => {
    if (!l.startsWith('data:')) return;
    try {
      const e = JSON.parse(l.slice(5));
      if (e.type === 'message_start') take(e.message && e.message.usage);
      else if (e.type === 'message_delta') take(e.usage);
    } catch {}
  };
  return {
    feed(chunk) {
      buf += chunk.toString('utf8');
      if (!sse) {
        if (buf.length > 4e6) buf = '';
        return;
      }
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const l of parts) line(l);
    },
    end() {
      if (sse) {
        if (buf) line(buf);
      } else {
        try {
          const j = JSON.parse(buf);
          take(j.usage);
          if (j.input_tokens != null && !j.usage) u.in = j.input_tokens; // count_tokens
        } catch {}
      }
      return u;
    },
  };
}

// ---------- server ----------

const HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'content-length', 'accept-encoding']);

export function resolveUpstream(port) {
  const own = (u) => {
    try {
      const x = new URL(u);
      return ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname) && Number(x.port) === Number(port);
    } catch {
      return true;
    }
  };
  for (const u of [process.env.TFORGE_PROXY_UPSTREAM, process.env.ANTHROPIC_BASE_URL]) if (u && !own(u)) return u.replace(/\/+$/, '');
  return 'https://api.anthropic.com';
}

const today = () => new Date().toISOString().slice(0, 10);

export function startProxy({ port = DEFAULT_PORT, upstream, dir = proxyDir(), log = true } = {}) {
  upstream = (upstream || resolveUpstream(port)).replace(/\/+$/, '');
  const up = new URL(upstream);
  const client = up.protocol === 'https:' ? https : http;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const memo = openMemo(path.join(dir, 'memo.jsonl'));
  const outDir = path.join(dir, 'out');
  try {
    const cutoff = Date.now() - MEMO_DAYS * 86400e3;
    for (const f of fs.readdirSync(outDir)) if (fs.statSync(path.join(outDir, f)).mtimeMs < cutoff) fs.rmSync(path.join(outDir, f), { force: true });
  } catch {}
  const saveFull = (text) => {
    try {
      fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
      const f = path.join(outDir, `${sha(text)}.txt`);
      if (!fs.existsSync(f)) fs.writeFileSync(f, text, { mode: 0o600 });
      return f;
    } catch {
      return null;
    }
  };
  const compress = !off('TFORGE_PROXY_COMPRESS');

  const server = http.createServer((req, res) => {
    // only local clients by name: a web page reaching 127.0.0.1 through DNS rebinding sends its own Host
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host || '')) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('tokenforge proxy: local clients only');
    }
    const t0 = Date.now();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      const pathname = req.url.split('?')[0];
      const isMessages = req.method === 'POST' && /^\/v1\/messages(\/count_tokens)?$/.test(pathname);
      const rec = { t: new Date(t0).toISOString(), ep: pathname };
      if (isMessages) {
        try {
          const j = JSON.parse(body.toString('utf8'));
          rec.model = j.model;
          rec.stream = !!j.stream;
          rec.system = len(j.system);
          rec.tools = len(j.tools);
          rec.nTools = Array.isArray(j.tools) ? j.tools.length : 0;
          rec.nMsgs = Array.isArray(j.messages) ? j.messages.length : 0;
          rec.bytesIn = body.length;
          const st = transformRequest(j, memo, { compress, saveFull });
          Object.assign(rec, { results: st.results, resultChars: st.resultChars, fresh: st.fresh, compressed: st.compressed, memoHits: st.memoHits, saved: st.saved });
          if (st.changed) body = Buffer.from(JSON.stringify(j));
          rec.bytesOut = body.length;
        } catch (e) {
          rec.error = `transform: ${e.message}`; // fail-safe: the original bytes go out
          body = Buffer.concat(chunks);
        }
      }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
      headers['content-length'] = body.length;
      const upReq = client.request(
        { protocol: up.protocol, hostname: up.hostname, port: up.port || undefined, method: req.method, path: up.pathname.replace(/\/$/, '') + req.url, headers },
        (upRes) => {
          const h = {};
          for (const [k, v] of Object.entries(upRes.headers)) if (k !== 'connection' && k !== 'keep-alive' && k !== 'transfer-encoding') h[k] = v;
          res.writeHead(upRes.statusCode, h);
          rec.status = upRes.statusCode;
          const enc = upRes.headers['content-encoding'];
          const parser = isMessages && (!enc || enc === 'identity') ? usageParser(upRes.headers['content-type']) : null;
          upRes.on('data', (c) => {
            res.write(c);
            if (parser) parser.feed(c);
          });
          upRes.on('end', () => {
            res.end();
            if (!isMessages || !log) return;
            if (parser) rec.usage = parser.end();
            rec.ms = Date.now() - t0;
            writeLog(dir, rec);
          });
          upRes.on('error', () => res.destroy());
        },
      );
      res.on('close', () => {
        if (!res.writableFinished) upReq.destroy();
      });
      upReq.on('error', (e) => {
        if (res.headersSent) return res.destroy();
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `tokenforge proxy: upstream ${upstream} unreachable: ${e.message}` } }));
        if (isMessages && log) writeLog(dir, { ...rec, status: 502, ms: Date.now() - t0, error: e.message });
      });
      upReq.end(body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, upstream }));
  });
}

function writeLog(dir, rec) {
  try {
    fs.appendFileSync(path.join(dir, `requests-${today()}.jsonl`), JSON.stringify(rec) + '\n', { mode: 0o600 });
  } catch {}
}

// ---------- report ----------

export function proxyReport({ days = 1, dir = proxyDir() } = {}) {
  const cutoff = new Date(Date.now() - (days - 1) * 86400e3).toISOString().slice(0, 10);
  const r = { requests: 0, errors: 0, in: 0, cr: 0, cw: 0, out: 0, compressed: 0, saved: 0, system: 0, tools: 0, resultChars: 0, bytesIn: 0, models: {} };
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^requests-\d{4}-\d\d-\d\d\.jsonl$/.test(f) && f.slice(9, 19) >= cutoff);
  } catch {}
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.ep !== '/v1/messages') continue;
      r.requests++;
      if (e.error || e.status >= 400) r.errors++;
      const u = e.usage || {};
      r.in += u.in || 0;
      r.cr += u.cr || 0;
      r.cw += u.cw || 0;
      r.out += u.out || 0;
      r.compressed += e.compressed || 0;
      r.saved += e.saved || 0;
      r.system += e.system || 0;
      r.tools += e.tools || 0;
      r.resultChars += e.resultChars || 0;
      r.bytesIn += e.bytesIn || 0;
      if (e.model) r.models[e.model] = (r.models[e.model] || 0) + 1;
    }
  }
  return r;
}

export function formatReport(r, days) {
  const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
  if (!r.requests) return `tforge proxy: no requests logged in the last ${days} day(s)`;
  const ctx = r.in + r.cr + r.cw;
  const avg = (n) => k(Math.round(n / r.requests));
  return [
    `tforge proxy: ${r.requests} requests in the last ${days} day(s)${r.errors ? ` (${r.errors} errors)` : ''}`,
    `  input tokens   ${k(ctx)} (cache read ${k(r.cr)}, cache write ${k(r.cw)}, uncached ${k(r.in)}); output ${k(r.out)}`,
    `  per request    system ${avg(r.system)} chars, tool definitions ${avg(r.tools)} chars, tool results ${avg(r.resultChars)} chars`,
    `  compression    ${r.compressed} tool results compressed; ${k(r.saved)} chars not sent (~${k(Math.round(r.saved / 4))} tokens)`,
    `  models         ${Object.entries(r.models).map(([m, n]) => `${m} ${n}`).join(', ')}`,
  ].join('\n');
}

