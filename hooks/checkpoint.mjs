// Stop: snapshot the session into chunks under .forge/snapshots/ after every reply, so /clear never loses
// state even when no handoff was written. Deterministic (read from the transcript, not summarized by Claude)
// and incremental: only the transcript bytes added since the last run are parsed. The open chunk is
// rewritten on every reply; it closes after TFORGE_SNAPSHOT_PROMPTS requests or at a compaction, and a new
// session (after /clear) starts its own chunks. session-start.mjs reloads the newest two.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHUNK_PROMPTS = Number(process.env.TFORGE_SNAPSHOT_PROMPTS) || 6;
const KEEP = Number(process.env.TFORGE_SNAPSHOT_KEEP) || 50;
const PROMPT_CHARS = 500;
const MAX_FILES = 40;
const REPLY_CHARS = 1500;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const SNAP_DIR = 'snapshots';
const META_RE = /^<!-- tforge (\{.*\}) -->\n/;

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

const newChunk = (n, ts) => ({ n, start: ts || null, end: ts || null, prompts: [], files: [], reply: '', ctx: 0 });

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
      if (s.chunk && (s.chunk.prompts.length || s.chunk.files.length || s.chunk.reply)) {
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
      if (e.isSidechain) continue;
      const ts = e.timestamp || null;
      s.chunk ||= newChunk(1, ts);
      if (e.type === 'system' && e.subtype === 'compact_boundary') {
        close(ts);
        continue;
      }
      if (e.isMeta) continue;
      if (e.type === 'user') {
        const t = userText(e.message);
        if (!t.trim() || t.trimStart().startsWith('<')) continue;
        if (s.chunk.prompts.length >= CHUNK_PROMPTS) close(ts);
        s.chunk.prompts.push(clip(t, PROMPT_CHARS));
        s.chunk.start ||= ts;
        s.chunk.end = ts || s.chunk.end;
      } else if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
        const text = e.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        if (text.trim()) s.chunk.reply = clip(text, REPLY_CHARS);
        for (const b of e.message.content) {
          const f = b.type === 'tool_use' && EDIT_TOOLS.has(b.name) && (b.input?.file_path || b.input?.notebook_path);
          if (f) s.chunk.files = [...s.chunk.files.filter((x) => x !== f), f].slice(-MAX_FILES);
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
  const meta = { sid, n: c.n, start: c.start, end: c.end, prompts: c.prompts.length, files: c.files.length, ctx: c.ctx };
  const when = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') : '?');
  const out = [
    `<!-- tforge ${JSON.stringify(meta)} -->`,
    `# Snapshot ${c.n} of session ${sid.slice(0, 8)} (${when(c.start)} to ${when(c.end)} UTC)`,
    'Written by tokenforge from the transcript. Raw facts; .forge/HANDOFF.md holds decisions and next steps when present.',
  ];
  if (c.prompts.length) out.push('', '## Requests (oldest first)', ...c.prompts.map((p) => `- ${p.replace(/\n+/g, ' ')}`));
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
      .filter((f) => /^\d{8}-\d{4}-[\w-]+-\d{3}\.md$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

export function ensureIgnored(forgeDir, name) {
  const gi = path.join(forgeDir, '.gitignore');
  let body = '';
  try {
    body = fs.readFileSync(gi, 'utf8');
  } catch {}
  if (!body.split('\n').includes(name)) fs.appendFileSync(gi, (body && !body.endsWith('\n') ? '\n' : '') + name + '\n');
}

function main() {
  if (process.env.TFORGE_CHECKPOINT === '0') return;
  const input = readStdin();
  if (!input.transcript_path || !input.cwd) return;
  const sid = String(input.session_id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '');
  const dir = path.join(os.tmpdir(), `tokenforge-${process.getuid?.() ?? 'u'}`);
  const stateFile = path.join(dir, `${sid}.snap.json`);
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {}
  const s = fold(input.transcript_path, prev);
  const open = s.chunk;
  if (!s.closed.length && !(open && (open.prompts.length || open.files.length || open.reply))) return;
  try {
    const forge = path.join(input.cwd, '.forge');
    const snaps = path.join(forge, SNAP_DIR);
    fs.mkdirSync(snaps, { recursive: true });
    ensureIgnored(forge, `${SNAP_DIR}/`);
    for (const c of [...s.closed, open]) {
      // The start time names the file, so it must not change between runs.
      if (c) c.start ||= new Date().toISOString();
      if (c && (c.prompts.length || c.files.length || c.reply)) fs.writeFileSync(path.join(snaps, chunkName(c, sid)), render(c, sid, input.cwd));
    }
    s.closed = [];
    for (const f of listSnapshots(input.cwd).slice(0, -KEEP)) fs.rmSync(path.join(snaps, f), { force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile, JSON.stringify(s));
  } catch {}
}

// Also imported by session-start.mjs and the dashboard; only run as the hook itself.
if (process.argv[1]?.endsWith('checkpoint.mjs')) main();
