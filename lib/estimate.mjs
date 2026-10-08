// Savings estimate for the status line and the dashboard: "~X% fewer tokens today".
// Runs on every status-line refresh, so everything is incremental: each transcript the status line has been handed is
// read from where the last run stopped, savings.jsonl and answers.jsonl likewise, and the state persists in
// statusline-v1.json. Only numbers are kept.
//
// saved = fixed + tools + answers, all in tokens processed (input + cache write + cache read + output):
// - fixed:   (16929 - fixed tokens of the session's lean level) x API calls (deduplicated by requestId). A session that
//            started before the last lean change counts 0 (its level is unknown). The level is read when the session
//            is first seen; tool definitions are re-sent (mostly as cache reads) on every call.
// - tools:   tkit/tread savings (raw - printed, already in tokens in savings.jsonl). Each result stays in context and is
//            re-sent on every later call until the next compaction, so a saving is multiplied by the session's calls
//            from then until the next compaction, but only when it can be tied to a session (same project, and a
//            tkit/tread/tview/tmap Bash call in that transcript in the 30 min before). Otherwise it counts once, and
//            not at all for a project with no counted session (its usage is not counted either).
// - answers: prompts the answer cache answered with 0 tokens; each counts as one call at the session's context size
//            just before (the least that prompt would have cost).
// pct = saved / (used + saved). Subagent transcripts are not counted (neither used nor saved).
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './config.mjs';
import { FIXED_TOKENS, fixedTokensOf, leanStatus } from './lean.mjs';
import { cacheBase, projectOf } from './usage.mjs';

export const stateFile = () => path.join(cacheBase(), 'statusline-v1.json');
export const answersFile = () => path.join(cacheBase(), 'answers.jsonl');
const ledgerFile = () => path.join(cacheBase(), 'savings.jsonl');

const KEEP_S = 2 * 86400; // rows and idle sessions older than this are dropped from the state
const TIE_S = 1800; // a kit call this long before a ledger row ties the row to that session
const KIT_RE = /"name":"Bash"[^]*?"command":"[^"]*\b(?:tkit|tread|tview|tmap)\b/;
const REQ_RE = /"requestId":"([^"]+)"/;

export const midnight = (now = Date.now()) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
};

// Read complete lines appended since `off`. Returns the new offset; a shrunk file is read from the start.
function readNew(file, off, onLine) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return off;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < off) off = 0;
    if (size === off) return off;
    const buf = Buffer.alloc(size - off);
    fs.readSync(fd, buf, 0, buf.length, off);
    const end = buf.lastIndexOf(10);
    if (end < 0) return off;
    for (const line of buf.toString('utf8', 0, end).split('\n')) if (line) onLine(line);
    return off + end + 1;
  } finally {
    fs.closeSync(fd);
  }
}

// One transcript line into a session entry {cwd, start, lastReq, calls: [[ts, tokens, context]], compacts, kits}.
export function ingestLine(s, line) {
  const tsm = /"timestamp":"([^"]+)"/.exec(line);
  const ts = tsm ? Math.round(Date.parse(tsm[1]) / 1000) || 0 : 0;
  if (!s.start && ts) s.start = ts;
  if (!s.cwd) {
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line);
    if (m) {
      try {
        s.cwd = JSON.parse(`"${m[1]}"`);
      } catch {}
    }
  }
  if (line.includes('"compact_boundary"') && line.includes('"type":"system"')) return void s.compacts.push(ts);
  if (!line.includes('"type":"assistant"')) return;
  if (KIT_RE.test(line)) s.kits.push(ts);
  if (!line.includes('"usage"')) return;
  // Content blocks of one API response are separate lines sharing a requestId and its usage: count it once.
  const rid = REQ_RE.exec(line)?.[1] || /"id":"(msg_[^"]+)"/.exec(line)?.[1] || null;
  if (rid && rid === s.lastReq) return;
  let u;
  try {
    u = JSON.parse(line).message?.usage;
  } catch {
    return;
  }
  if (!u) return;
  s.lastReq = rid;
  const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  s.calls.push([ts, ctx + (u.output_tokens || 0), ctx]);
}

const inProject = (rowCwd, cwd) => {
  const p = projectOf(cwd);
  return !!p && (rowCwd === p || rowCwd.startsWith(p + '/') || rowCwd.startsWith(p + '\\'));
};

// Pure math. sessions: [{id, cwd, calls, compacts, kits, saving}] where saving = fixed tokens saved per call.
// rows: savings.jsonl rows {t, cwd, raw, out}; answers: {t, session}. Counts only events at or after `since`
// (and, with `only`, only that session and the rows/answers tied to it).
export function computeSavings({ sessions, rows = [], answers = [], since = 0, only = null }) {
  const r = { calls: 0, used: 0, fixed: 0, tools: 0, toolsReread: 0, answers: 0, answerHits: 0 };
  for (const s of sessions) {
    if (only && s.id !== only) continue;
    for (const c of s.calls) {
      if (c[0] < since) continue;
      r.calls++;
      r.used += c[1];
      r.fixed += s.saving || 0;
    }
  }
  // Rows count only for projects with a counted session in the window: usage elsewhere (headless runs, sessions the
  // status line never saw) is not in `used` either.
  const active = sessions.filter((s) => s.calls.some((c) => c[0] >= since));
  for (const row of rows) {
    if (row.t < since) continue;
    const per = Math.max(0, row.raw - row.out);
    if (!per || !active.some((s) => inProject(row.cwd, s.cwd))) continue;
    // Tie the row to the session with the nearest preceding kit call in the same project.
    let best = null;
    let gap = Infinity;
    for (const s of active) {
      if (!inProject(row.cwd, s.cwd)) continue;
      for (const k of s.kits) if (k <= row.t + 5 && row.t - k <= TIE_S && row.t - k < gap) (gap = row.t - k), (best = s);
    }
    if (only && best?.id !== only) continue;
    let n = 1;
    if (best) {
      const until = Math.min(...best.compacts.filter((c) => c >= row.t), Infinity);
      n = Math.max(1, best.calls.filter((c) => c[0] >= row.t && c[0] < until).length);
      r.toolsReread++;
    }
    r.tools += per * n;
  }
  for (const a of answers) {
    if (a.t < since || (only && a.session !== only)) continue;
    const s = sessions.find((x) => x.id === a.session);
    const before = s ? s.calls.filter((c) => c[0] <= a.t) : [];
    r.answers += before.length ? before[before.length - 1][2] : s ? FIXED_TOKENS.off - (s.saving || 0) : 0;
    r.answerHits++;
  }
  r.saved = r.fixed + r.tools + r.answers;
  r.pct = r.used + r.saved > 0 ? r.saved / (r.used + r.saved) : 0;
  return r;
}

function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && s.v === 1) return s;
  } catch {}
  return { v: 1, sessions: {}, ledger: { off: 0, rows: [] }, answers: { off: 0, rows: [] } };
}

// Per-call fixed saving of a session, decided once: 0 when lean changed after (or within a minute before) it started,
// since a change only takes effect in sessions started later and the first transcript line can trail the startup hook.
function sessionSaving(start) {
  try {
    const changed = (readConfig().leanChangedAt || 0) / 1000;
    if (changed > start - 60) return 0;
    return FIXED_TOKENS.off - fixedTokensOf(leanStatus());
  } catch {
    return 0;
  }
}

// Update the state with the current status-line input and return {session, today}.
export function refresh(input = {}, { now = Date.now(), file = stateFile(), ledger = ledgerFile(), answers = answersFile() } = {}) {
  const st = loadState(file);
  const nowS = now / 1000;
  const tp = input.transcript_path;
  if (tp && !st.sessions[tp]) st.sessions[tp] = { id: input.session_id || path.basename(tp, '.jsonl'), off: 0, cwd: input.cwd || '', start: 0, lastReq: null, calls: [], compacts: [], kits: [], saving: null, seen: nowS };
  for (const [p, s] of Object.entries(st.sessions)) {
    s.off = readNew(p, s.off, (l) => ingestLine(s, l));
    if (p === tp) s.seen = nowS;
    if (s.saving === null && s.start) s.saving = sessionSaving(s.start);
    const last = Math.max(s.seen || 0, s.calls.length ? s.calls[s.calls.length - 1][0] : 0);
    if (p !== tp && last < nowS - KEEP_S) delete st.sessions[p];
  }
  const keep = (rows) => rows.filter((x) => x.t >= nowS - KEEP_S);
  st.ledger.off = readNew(ledger, st.ledger.off, (l) => {
    try {
      const x = JSON.parse(l);
      if (Number.isFinite(x.t)) st.ledger.rows.push({ t: x.t, cwd: x.cwd || '', raw: Math.max(0, x.raw | 0), out: Math.max(0, x.out | 0) });
    } catch {}
  });
  st.ledger.rows = keep(st.ledger.rows);
  st.answers.off = readNew(answers, st.answers.off, (l) => {
    try {
      const x = JSON.parse(l);
      if (Number.isFinite(x.t)) st.answers.rows.push({ t: x.t, session: x.session || null });
    } catch {}
  });
  st.answers.rows = keep(st.answers.rows);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, file);
  } catch {}
  const sessions = Object.values(st.sessions);
  const base = { sessions, rows: st.ledger.rows, answers: st.answers.rows };
  const id = tp ? st.sessions[tp].id : null;
  return {
    session: id ? computeSavings({ ...base, only: id }) : null,
    today: computeSavings({ ...base, since: midnight(now) }),
  };
}

export function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}

// Terminals that may not render U+2212: TFORGE_ASCII=1, a non-UTF-8 locale, or the legacy Windows console.
export function asciiOnly(env = process.env, platform = process.platform) {
  if (env.TFORGE_ASCII) return env.TFORGE_ASCII !== '0';
  if (platform === 'win32') return !(env.WT_SESSION || env.TERM_PROGRAM || /utf-?8/i.test(env.LANG || ''));
  const loc = env.LC_ALL || env.LC_CTYPE || env.LANG;
  return !!loc && !/utf-?8/i.test(loc);
}

// "TF −45% today (~1.2M saved)"; empty until something was saved today, so a wrapped status line is left untouched.
export function formatSegment(r, ascii = asciiOnly()) {
  if (!r || r.saved <= 0) return '';
  const pct = Math.round(r.pct * 100);
  return `TF ${ascii ? '-' : '−'}${pct}% today (~${fmtTokens(r.saved)} saved)`;
}

export function statuslineSegment(input, opts) {
  try {
    return formatSegment(refresh(input, opts).today, opts?.ascii);
  } catch {
    return '';
  }
}
