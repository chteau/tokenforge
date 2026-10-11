// Stop: snapshot the session into chunks under .forge/snapshots/ after every reply, so /clear never loses
// state even when no handoff was written. Deterministic (read from the transcript, not summarized by Claude)
// and incremental: only the transcript bytes added since the last run are parsed. The open chunk is
// rewritten on every reply; it closes after TFORGE_SNAPSHOT_PROMPTS requests or at a compaction, and a new
// session (after /clear) starts its own chunks. session-start.mjs reloads the newest two. Subagents' transcripts
// (<transcript dir>/<session>/subagents/) are folded in too: each chunk lists the agents it ran, the files they
// changed, their commands and the start of their report. pruneSnapshots forgets chunks by activation (age, loads,
// files still present, superseded); staleHandoff archives spent automatic handoffs to .forge/handoffs/.
import fs from 'node:fs';
import path from 'node:path';

import { maybeGc } from '../lib/gc.mjs';
import { stateDir } from '../lib/hookutil.mjs';
import { projectRoot, readJson, writeJsonAtomic } from '../lib/util.mjs';

const CHUNK_PROMPTS = Number(process.env.TFORGE_SNAPSHOT_PROMPTS) || 6;
const KEEP = Number(process.env.TFORGE_SNAPSHOT_KEEP) || 50;
// Wall-clock cap on loading a handoff (14 days). Before it, an automatic handoff stays until a later session
// that was given it did some work (see staleHandoff): a resume after a weekend still finds it.
export const HANDOFF_MAX_H = Number(process.env.TFORGE_HANDOFF_MAX_AGE_H) || 336;
export const HANDOFF_ARCHIVE = 'handoffs';
const ARCHIVE_KEEP = 10;
const PROTECT = 6; // newest chunks never pruned
const FORGET = -3; // activation below which a chunk is pruned
const PROMPT_CHARS = 500;
const MAX_FILES = 40;
const REPLY_CHARS = 1500;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const AGENT_SAY = 400;
const AGENTS_PER_CHUNK = 20;
export const SNAP_DIR = 'snapshots';
export const AUTO_MARK = '<!-- tforge auto-handoff -->';
const LOADS = 'loads.json';
const META_RE = /^<!-- tforge (\{.*\}) -->\n/;
const NAME_RE = /^\d{8}-\d{4}-([\w-]+)-(\d{3})\.md$/;

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

function clip(s, n) {
  s = s.trim();
  return s.length > n ? s.slice(0, n) + ' […]' : s;
}

function userText(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c) || c.some((b) => b.type === 'tool_result')) return '';
  return c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

const newChunk = (n, ts) => ({ n, start: ts || null, end: ts || null, prompts: [], files: [], reply: '', ctx: 0, turns: [], ids: {}, agents: [], uses: {} });
const hasContent = (c) => !!(c && (c.prompts.length || c.files.length || c.reply || c.agents?.length));
const TURN_LIST = 25;
const TURN_SAY = 700;
const add = (list, x) => (x && !list.includes(x) && list.length < TURN_LIST ? list.push(x) : null);
const SCRATCH = /^\/tmp\/claude-\d+\//;
const FILE = /[\w@%+=.\/~-]+\.\w{1,8}\b/;

// What a shell command did, in terms of the graph: files written, files read, searches, and the action itself.
export function analyzeBash(cmd) {
  const r = { edits: [], reads: [], searched: [], ran: '' };
  if (/<<-?\s*['"]?\w+/.test(cmd) || cmd.includes('tkit edit')) {
    for (const m of cmd.matchAll(/^@@\s+(\S+)/gm)) add(r.edits, m[1]);
    for (const m of cmd.matchAll(/\bcat\s+>>?\s*(\S+)/g)) add(r.edits, m[1]);
    for (const m of cmd.matchAll(/\bopen\(\s*(?:p|path|f)?\s*,?\s*['"]w['"]/g)) void m;
    for (const m of cmd.matchAll(/\b(?:p|path|f|fn)\s*=\s*['"]([^'"]+)['"]/g)) if (/open\(\w+,\s*['"]w/.test(cmd)) add(r.edits, m[1]);
    for (const m of cmd.matchAll(/\bopen\(\s*['"]([^'"]+)['"]\s*,\s*['"]w/g)) add(r.edits, m[1]);
  }
  for (const m of cmd.matchAll(/\bsed\s+(?:-[a-z]*i[a-z]*\S*\s+)(?:'[^']*'|"[^"]*")\s+(\S+)/g)) add(r.edits, m[1]);
  for (const m of cmd.matchAll(/\btee\s+(?:-a\s+)?(\S+)/g)) add(r.edits, m[1]);
  for (const m of cmd.matchAll(/\bsed\s+-n\s+['"]?(\d+),(\d+)p['"]?\s+(\S+?)[;&|\s]/g)) add(r.reads, `${m[3]}:${m[1]}-${m[2]}`);
  for (const m of cmd.matchAll(/(?:^|[;&|]\s*)(?:cat|head|tail)\s+(?:-\w+\s+\d*\s*)*([\w@%+=.\/~-]+\.\w{1,8})\s*(?=[;&|]|$)/gm)) add(r.reads, m[1]);
  for (const m of cmd.matchAll(/\b(?:tread|tview)\s+([^;&|\n]+)/g)) for (const a of m[1].split(/\s+/)) if (FILE.test(a)) add(r.reads, a.replace(/^["']|["']$/g, ''));
  for (const m of cmd.matchAll(/(?:^|[;&]\s*)(?:grep|rg)\s+([^|;&\n]+)/g)) {
    const w = (m[1].match(/'[^']*'|"[^"]*"|\S+/g) || []).filter((x) => !x.startsWith('-'));
    const [pat, ...where] = w.map((x) => x.replace(/^["']|["']$/g, ''));
    if (pat) add(r.searched, clip(pat + (where.length ? ' in ' + where.filter((x) => /[\/.]/.test(x) && !x.includes('>')).slice(0, 2).join(' ') : ''), 60).replace(/ in $/, ''));
  }
  const ACT = /^(git|gh|cargo|npm|pnpm|yarn|go|make|docker|kubectl|tkit|pytest|curl|ssh)\b/;
  const acts = cmd.split(/\s*(?:&&|\|\||;|\n)\s*/).map((x) => x.replace(/^(cd\s+\S+\s*&&\s*)+/, '').replace(/^\w+=\S+\s+/, '').trim()).filter((x) => ACT.test(x));
  r.ran = clip(acts.map((x) => x.replace(/\s+-m\s+\d+/, '').split(/\s+/).slice(0, 4).join(' ')).filter((x, i, l) => l.indexOf(x) === i).join('; '), 90);
  return r;
}

// One tool call of an assistant message: files edited (also the chunk's file list), files read, searches, commands.
// `turn` is null for subagent lines (only the chunk's file list is kept then).
function noteTool(b, turn, chunk, ids = true) {
  if (b.type !== 'tool_use') return;
  const touch = (x) => (chunk.files = [...chunk.files.filter((y) => y !== x), x].slice(-MAX_FILES));
  const f = b.input?.file_path || b.input?.notebook_path;
  if (EDIT_TOOLS.has(b.name) && f) {
    touch(f);
    if (turn) add(turn.edits, f);
  } else if (turn && b.name === 'Read') add(SCRATCH.test(f || '') ? (turn.images = turn.images || []) : turn.reads, f);
  else if (b.name === 'Bash') {
    const a = analyzeBash(String(b.input?.command || ''));
    for (const x of a.edits) {
      touch(x);
      if (turn) add(turn.edits, x);
    }
    if (!turn) return a.ran;
    for (const x of a.reads) add(turn.reads, x);
    for (const x of a.searched) add(turn.searched, x);
    if (a.ran && turn.ran.length < TURN_LIST && !turn.ran.includes(a.ran)) {
      turn.ran.push(a.ran);
      if (ids) (chunk.ids ||= {})[b.id] = [chunk.turns.length - 1, turn.ran.length - 1];
    }
  }
}

// Subagent transcripts of this session (Claude Code 2.1.x: <dir of transcript>/<session>/subagents/agent-<id>.jsonl,
// with agent-<id>.meta.json holding its type, description and the Agent call's id). Read incrementally like the main
// transcript; each agent is listed on the chunk whose request launched it (else the open chunk).
export function foldAgents(transcript, sessionId, s) {
  const dir = path.join(path.dirname(transcript), sessionId, 'subagents');
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => /^agent-[\w-]+\.jsonl$/.test(f));
  } catch {
    return s;
  }
  s.agentOffsets ||= {};
  for (const name of names) {
    const id = name.slice(6, -6);
    const file = path.join(dir, name);
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    const from = s.agentOffsets[id] || 0;
    if (size <= from) continue;
    let text;
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
      const end = buf.lastIndexOf(10);
      if (end < 0) continue;
      s.agentOffsets[id] = from + end + 1;
      text = buf.subarray(0, end).toString('utf8');
    } catch {
      continue;
    }
    const meta = readJson(path.join(dir, `agent-${id}.meta.json`), {});
    s.chunk ||= newChunk(1, null);
    const chunk = [...s.closed, s.chunk].find((c) => c.uses?.[meta.toolUseId]) || s.chunk;
    chunk.agents ||= [];
    let a = chunk.agents.find((x) => x.id === id);
    if (!a) {
      if (chunk.agents.length >= AGENTS_PER_CHUNK) continue;
      a = { id, type: meta.agentType || '?', desc: clip(String(meta.description || ''), 80), use: meta.toolUseId, edits: [], ran: [], said: '' };
      chunk.agents.push(a);
    }
    for (const line of text.split('\n')) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
      for (const b of e.message.content) {
        if (b.type === 'text' && b.text.trim()) a.said = clip(b.text.replace(/\s+/g, ' '), AGENT_SAY);
        if (b.type !== 'tool_use') continue;
        const f = EDIT_TOOLS.has(b.name) && (b.input?.file_path || b.input?.notebook_path);
        if (f) add(a.edits, f);
        if (b.name === 'Bash') for (const x of analyzeBash(String(b.input?.command || '')).edits) add(a.edits, x);
        const ran = noteTool(b, null, chunk);
        if (ran && a.ran.length < TURN_LIST && !a.ran.includes(ran)) a.ran.push(ran);
      }
    }
  }
  return s;
}

// Fold the transcript lines added since `state.offset` into state. Closed chunks go to state.closed
// (the caller writes them once, then clears the list). Returns the new state.
export function fold(file, state) {
  const s = { offset: 0, chunk: null, closed: [], ...state };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < s.offset) Object.assign(s, { offset: 0, chunk: null, closed: [] });
    const buf = Buffer.alloc(size - s.offset);
    fs.readSync(fd, buf, 0, buf.length, s.offset);
    const end = buf.lastIndexOf(10); // only whole lines; a partial last line is read next time
    if (end < 0) return s;
    s.offset += end + 1;
    const close = (ts) => {
      if (hasContent(s.chunk)) {
        s.closed.push(s.chunk);
        s.chunk = newChunk(s.chunk.n + 1, ts);
      }
    };
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      // Old Claude Code versions wrote subagent lines into the main transcript: keep the files they changed.
      if (e.isSidechain) {
        s.chunk ||= newChunk(1, e.timestamp);
        if (e.type === 'assistant' && Array.isArray(e.message?.content)) for (const b of e.message.content) noteTool(b, null, s.chunk);
        continue;
      }
      const ts = e.timestamp || null;
      s.chunk ||= newChunk(1, ts);
      if (e.type === 'system' && e.subtype === 'compact_boundary') {
        close(ts);
        continue;
      }
      if (e.isMeta) continue;
      if (e.type === 'user') {
        for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
          const at = b.type === 'tool_result' && b.is_error && s.chunk.ids?.[b.tool_use_id];
          if (at && s.chunk.turns[at[0]]) s.chunk.turns[at[0]].ran[at[1]] += ' (failed)';
          // a foreground agent's report comes back as its tool result (background ones: "Async agent launched")
          if (b.type === 'tool_result' && s.chunk.uses?.[b.tool_use_id] && e.toolUseResult?.status !== 'async_launched') {
            const text = (typeof b.content === 'string' ? b.content : (b.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n')).trim();
            if (text) (s.chunk.reports ||= {})[b.tool_use_id] = clip(text.replace(/\s+/g, ' '), AGENT_SAY);
          }
        }
        const t = userText(e.message);
        if (!t.trim() || t.trimStart().startsWith('<')) continue;
        if (s.chunk.prompts.length >= CHUNK_PROMPTS) close(ts);
        s.chunk.prompts.push(clip(t, PROMPT_CHARS));
        (s.chunk.turns ||= []).push({ p: clip(t.replace(/\s+/g, ' '), 300), edits: [], reads: [], searched: [], ran: [], said: '' });
        s.chunk.start ||= ts;
        s.chunk.end = ts || s.chunk.end;
      } else if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
        const text = e.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        const turn = s.chunk.turns?.at(-1);
        if (text.trim()) {
          s.chunk.reply = clip(text, REPLY_CHARS);
          if (turn) turn.said = clip(text.replace(/\s+/g, ' '), TURN_SAY);
        }
        for (const b of e.message.content) {
          noteTool(b, turn, s.chunk);
          if (turn && b.type === 'tool_use' && AGENT_TOOLS.has(b.name)) {
            add((turn.delegated ||= []), clip(`${b.input?.subagent_type || 'agent'}: ${b.input?.description || ''}`, 80));
            (s.chunk.uses ||= {})[b.id] = 1;
          }
        }
        const u = e.message.usage;
        if (u) s.chunk.ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        s.chunk.end = ts || s.chunk.end;
      }
    }
  } catch {
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return s;
}

const stamp = (iso) => (iso ? new Date(iso) : new Date()).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

export function chunkName(c, sid) {
  return `${stamp(c.start)}-${sid.slice(0, 8)}-${String(c.n).padStart(3, '0')}.md`;
}

export function render(c, sid, cwd) {
  const rel = (f) => (path.isAbsolute(f) && f.startsWith(cwd + path.sep) ? path.relative(cwd, f) : f);
  const meta = { sid, n: c.n, start: c.start, end: c.end, prompts: c.prompts.length, files: c.files.length, ctx: c.ctx, ...(c.agents?.length ? { agents: c.agents.length } : {}) };
  const when = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') : '?');
  const out = [
    `<!-- tforge ${JSON.stringify(meta)} -->`,
    `# Snapshot ${c.n} of session ${sid.slice(0, 8)} (${when(c.start)} to ${when(c.end)} UTC)`,
    'Written by tokenforge from the transcript. Raw facts; .forge/HANDOFF.md holds decisions and next steps when present.',
  ];
  if (c.prompts.length) out.push('', '## Requests (oldest first)', ...c.prompts.map((p) => `- ${p.replace(/\n+/g, ' ')}`));
  if (c.turns?.length) {
    // one node per request, linked to the files it edited and read, the commands it ran and what was said
    const line = (k, a) => (a?.length ? [`  - ${k}: ${a.map(rel).join(', ')}`] : []);
    out.push(
      '',
      '## Graph (each request -> what it changed, read, searched, ran and concluded)',
      ...c.turns.flatMap((t, i) => [
        `- R${i + 1} "${t.p}"`,
        ...line('edited', t.edits),
        ...line('read', t.reads),
        ...(t.images?.length ? [`  - viewed: ${t.images.length} image(s)`] : []),
        ...line('searched', t.searched),
        ...line('ran', t.ran),
        ...line('delegated', t.delegated),
        ...(t.said ? [`  - said: ${t.said}`] : []),
      ]),
    );
  }
  if (c.agents?.length) {
    const line = (k, a) => (a?.length ? [`  - ${k}: ${a.map(rel).join(', ')}`] : []);
    out.push(
      '',
      '## Subagents (type "task" -> what it changed, ran and reported)',
      ...c.agents.flatMap((a) => [
        `- ${a.type} "${a.desc}"`,
        ...line('edited', a.edits),
        ...line('ran', a.ran),
        ...((a.said || c.reports?.[a.use]) ? [`  - reported: ${c.reports?.[a.use] || a.said}`] : []),
      ]),
    );
  }
  if (c.files.length) out.push('', '## Files changed', ...c.files.map((f) => `- ${rel(f)}`));
  if (c.reply) out.push('', '## Last reply', c.reply);
  return out.join('\n') + '\n';
}

// Snapshot body and its metadata line, split.
export function parseSnapshot(text) {
  const m = META_RE.exec(text);
  if (!m) return { meta: null, body: text };
  try {
    return { meta: JSON.parse(m[1]), body: text.slice(m[0].length) };
  } catch {
    return { meta: null, body: text.slice(m[0].length) };
  }
}

// Snapshot file names of a project, oldest first (names start with the chunk's start time).
export function listSnapshots(cwd) {
  try {
    return fs
      .readdirSync(path.join(cwd, '.forge', SNAP_DIR))
      .filter((f) => NAME_RE.test(f))
      .sort();
  } catch {
    return [];
  }
}

export function ensureIgnored(forgeDir, ...names) {
  const gi = path.join(forgeDir, '.gitignore');
  let body = '';
  try {
    body = fs.readFileSync(gi, 'utf8');
  } catch {}
  const have = body.split(/\r?\n/);
  const add = names.filter((n) => !have.includes(n));
  if (add.length) fs.appendFileSync(gi, (body && !body.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n');
}

// Remember when snapshot chunks were read back into a session; pruneSnapshots counts each load as a use.
export function noteLoad(cwd, names, now = Date.now()) {
  if (!names.length) return;
  const file = path.join(cwd, '.forge', SNAP_DIR, LOADS);
  try {
    const loads = readJson(file, {});
    for (const n of names) loads[n] = [...(loads[n] || []), now].slice(-20);
    writeJsonAtomic(file, loads);
  } catch {}
}

const readSnapshot = (dir, name) => {
  try {
    return fs.readFileSync(path.join(dir, name), 'utf8');
  } catch {
    return '';
  }
};

// Forget the chunks no session will need again, by ACT-R base-level activation over a chunk's uses (its
// creation and every load back into a session): A = ln sum (hours since use + 1)^-0.5, plus ln(0.5 + 0.5 f)
// where f is the share of the files it changed that still exist, minus 1 when a newer chunk changed at least
// 80% of the same files. An unread chunk lasts ~17 days, ~4 once its files are gone, ~2 once superseded.
// The newest PROTECT chunks always stay; below FORGET a chunk goes, then the weakest until KEEP remain.
// Returns the removed (with dryRun, the doomed) names.
export function pruneSnapshots(cwd, { now = Date.now(), dryRun = false } = {}) {
  const dir = path.join(cwd, '.forge', SNAP_DIR);
  let loads = {};
  try {
    loads = readJson(path.join(dir, LOADS), {});
  } catch {}
  const chunks = listSnapshots(cwd).map((name) => {
    const text = readSnapshot(dir, name);
    const listed = /\n## Files changed\n((?:- .*\n)*)/.exec(text)?.[1].split('\n').filter(Boolean).map((l) => l.slice(2)) || [];
    const edited = [...text.matchAll(/^ {2}- edited: (.+)$/gm)].flatMap((m) => m[1].split(', '));
    const files = new Set([...listed, ...edited].map((f) => path.resolve(cwd, f.replace(/:\d+(-\d+)?$/, ''))));
    const { meta } = parseSnapshot(text);
    const born = Date.parse(meta?.end || meta?.start) || fs.statSync(path.join(dir, name), { throwIfNoEntry: false })?.mtimeMs || now;
    return { name, files, uses: [born, ...(loads[name] || [])] };
  });
  const covered = (c, d) => [...c.files].filter((f) => d.files.has(f)).length >= 0.8 * c.files.size;
  const scored = chunks.slice(0, -PROTECT).map((c, i) => {
    const base = Math.log(c.uses.reduce((sum, t) => sum + (Math.max(0, now - t) / 3600e3 + 1) ** -0.5, 0));
    const present = c.files.size ? [...c.files].filter((f) => fs.existsSync(f)).length / c.files.size : 1;
    const superseded = c.files.size > 0 && chunks.slice(i + 1).some((d) => covered(c, d));
    return { name: c.name, a: base + Math.log(0.5 + 0.5 * present) - (superseded ? 1 : 0) };
  });
  const gone = scored.filter((c) => c.a < FORGET);
  const rest = scored.filter((c) => c.a >= FORGET).sort((x, y) => x.a - y.a);
  gone.push(...rest.slice(0, Math.max(0, chunks.length - gone.length - KEEP)));
  const names = gone.map((c) => c.name);
  if (dryRun || !names.length) return names;
  for (const n of names) fs.rmSync(path.join(dir, n), { force: true });
  const left = new Set(listSnapshots(cwd));
  try {
    writeJsonAtomic(path.join(dir, LOADS), Object.fromEntries(Object.entries(loads).filter(([n]) => left.has(n))));
  } catch {}
  return names;
}

// Sessions that were given the current HANDOFF.md (session-start.mjs records them, keyed by the file's mtime).
const GIVEN = 'handoff-given.json';
export function noteHandoffGiven(cwd, sessionId, mtime) {
  const file = path.join(cwd, '.forge', SNAP_DIR, GIVEN);
  try {
    const g = readJson(file, {});
    const sids = g.mtime === mtime ? g.sids || [] : [];
    const sid8 = String(sessionId || '').slice(0, 8);
    if (!sid8 || sids.includes(sid8)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, { mtime, sids: [...sids, sid8].slice(-20) });
  } catch {}
}

// An automatic handoff (AUTO_MARK) has done its job once a session other than its writer was given it and then did
// some work (it has a snapshot), or once it is older than maxH hours. Elapsed time alone (a weekend) does not spend
// it, and it is moved to .forge/handoffs/ (newest ARCHIVE_KEEP kept), not deleted. A handoff the user wrote is never
// touched. Returns true when archived (with dryRun: would be).
export function staleHandoff(cwd, maxH, { now = Date.now(), dryRun = false } = {}) {
  const file = path.join(cwd, '.forge', 'HANDOFF.md');
  let head, mtime;
  try {
    head = fs.readFileSync(file, 'utf8').slice(0, 400);
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return false;
  }
  if (!head.startsWith(AUTO_MARK)) return false;
  const writer = /session ([\w-]+)/.exec(head)?.[1]?.slice(0, 8);
  const given = readJson(path.join(cwd, '.forge', SNAP_DIR, GIVEN), {});
  const worked = new Set(listSnapshots(cwd).map((f) => NAME_RE.exec(f)[1]));
  const spent = given.mtime === mtime && (given.sids || []).some((x) => x !== writer && worked.has(x));
  if (now - mtime <= maxH * 3600e3 && !spent) return false;
  if (!dryRun) archiveHandoff(cwd, file, mtime, writer);
  return true;
}

function archiveHandoff(cwd, file, mtime, writer) {
  const forge = path.join(cwd, '.forge');
  const dir = path.join(forge, HANDOFF_ARCHIVE);
  try {
    fs.mkdirSync(dir, { recursive: true });
    ensureIgnored(forge, `${HANDOFF_ARCHIVE}/`);
    fs.renameSync(file, path.join(dir, `${stamp(new Date(mtime).toISOString())}-${writer || 'auto'}.md`));
    const all = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    for (const f of all.slice(0, -ARCHIVE_KEEP)) fs.rmSync(path.join(dir, f), { force: true });
  } catch {
    fs.rmSync(file, { force: true });
  }
}

function main() {
  const input = readStdin();
  if (!input.cwd) return;
  input.cwd = projectRoot(input.cwd);
  maybeGc(input.cwd, input.session_id);
  if (process.env.TFORGE_CHECKPOINT === '0' || !input.transcript_path) return;
  const sid = String(input.session_id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '');
  const dir = stateDir();
  const stateFile = path.join(dir, `${sid}.snap.json`);
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {}
  const s = foldAgents(input.transcript_path, sid, fold(input.transcript_path, prev));
  const open = s.chunk;
  if (!s.closed.length && !hasContent(open)) return;
  try {
    const forge = path.join(input.cwd, '.forge');
    const snaps = path.join(forge, SNAP_DIR);
    fs.mkdirSync(snaps, { recursive: true });
    // The .gitignore ignores itself: a .forge holding only automatic files stays out of git status, `git add -A` and
    // the clean check of `git worktree remove` (SpecAudit audits in a worktree it removes after the merge).
    ensureIgnored(forge, '.gitignore', `${SNAP_DIR}/`, 'HANDOFF.md');
    for (const c of [...s.closed, open]) {
      // The start time names the file, so it must not change between runs.
      if (c) c.start ||= new Date().toISOString();
      if (hasContent(c)) fs.writeFileSync(path.join(snaps, chunkName(c, sid)), render(c, sid, input.cwd));
    }
    const closed = s.closed.length;
    s.closed = [];
    if (closed) pruneSnapshots(input.cwd);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile, JSON.stringify(s));
  } catch {}
}

// Also imported by session-start.mjs and the dashboard; only run as the hook itself.
if (process.argv[1]?.endsWith('checkpoint.mjs')) main();
