// Project memory: a keyword-browsable graph of past Claude Code sessions, built from transcripts.
// Nodes: sessions (prompts, commits, last reply), files (edited / read) and keywords; edges link a session to the
// files it touched and the keywords it is about. `tforge recall <words>` returns the few nodes that match, so a
// new session pulls past context on demand instead of having snapshots injected (and re-read on every call).
// Text stays local: the index lives in ~/.cache/tokenforge/memory/ and is rebuilt incrementally.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { terseLevel } from './config.mjs';
import { configDir } from './meter.mjs';
import { cacheBase } from './usage.mjs';

const VERSION = 5;
const TURN_REPLY_CHARS = 2000;
const MAX_TURNS = 40;
const PROMPT_CHARS = 400;
const REPLY_CHARS = 400;
const STOP = new Set(
  ('the a an and or but if then else for to of in on at by with from into onto as is are was were be been being it its this that these those ' +
    'i you we they he she me my our your their please can could would should will shall may might must do does did done not no yes ' +
    'so too very just also only all any some more most such what which who whom whose when where why how there here than out up down ' +
    'over under again once about after before between both each few other own same have has had having get got make made use used ' +
    'file files code run add fix change update new now like want need still one two way thing things work make sure lets let ' +
    // conversational filler: keywords should be topics, not tone
    'possibly perhaps maybe probably actually really already even know think thought feel feels felt something anything everything ' +
    'nothing someone yourself myself ourselves nice good great better best bad worse alright okay yeah yep sure instead rather though ' +
    'although without within while since because around through across along idea ideas useful possible needed reading isn aren doesn ' +
    'don didn won wouldn couldn shouldn hasn haven wasn weren every much many well less more lot lots bit kind sort able going gonna ' +
    'wanna gotta seems seem look looks looking explain explicitely explicitly further heavily quite pretty basically literally simply ' +
    'right left first last next previous another others either neither whether done doing tried try trying give gave take took keep ' +
    'kept put says said tell told ask asked show shows showed see seen saw come came goes went thanks thank please hello hey hi ' +
    'claude project tasks task stuff issue issues problem problems question way ways time times today yesterday tomorrow day days ' +
    'using real').split(' '),
);

export const projectKey = (cwd) => path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
export const transcriptDir = (cwd) => path.join(configDir(), 'projects', projectKey(cwd));
const indexFile = (cwd) => path.join(cacheBase(), 'memory', `${projectKey(cwd)}.json`);

export function words(text) {
  const out = [];
  for (const m of String(text || '').toLowerCase().matchAll(/[a-z_][a-z0-9_]{2,}/g)) {
    const w = m[0].replace(/^_+|_+$/g, '');
    if (w.length >= 3 && !STOP.has(w) && !/^\d/.test(w)) out.push(w);
  }
  return out;
}

const clip = (s, n) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};

function userText(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c) || c.some((b) => b.type === 'tool_result')) return '';
  return c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

const relTo = (cwd, p) => {
  if (!p) return null;
  const abs = path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : null;
};

// Files a Bash command writes: `> f`, `>> f`, `cat > f <<`, `tee f`, `sed -i … f`, python/node open(f,'w').
// A plausible project path: no shell variables or globs, has a letter, looks like a file (extension or folder).
const PLAUSIBLE = (f) => /^[\w./@+-]+$/.test(f) && /[A-Za-z]/.test(f) && (/\.[A-Za-z0-9]{1,8}$/.test(f) || f.includes('/')) && !f.endsWith(':');

function bashWrites(cmd) {
  const out = new Set();
  // redirections, tee and sed -i only in the command part: a heredoc body is data (code with `x > 15`)
  const head = cmd.split(/<<-?\s*['"]?\w+['"]?/)[0];
  for (const m of head.matchAll(/(?:^|[\s;&|])\d?>>?\s*([^\s;&|<>]+)/g)) if (!/^\/dev\/|^&/.test(m[1])) out.add(m[1]);
  for (const m of head.matchAll(/\btee\s+(?:-a\s+)?([^\s;&|<>]+)/g)) out.add(m[1]);
  for (const m of head.matchAll(/\bsed\s+-i\S*\s+(?:'[^']*'|"[^"]*"|\S+)\s+([^\s;&|<>]+)/g)) out.add(m[1]);
  for (const m of cmd.matchAll(/open\(\s*['"]([^'"]+)['"]\s*,\s*['"][wa]/g)) out.add(m[1]);
  for (const m of cmd.matchAll(/\bp\s*=\s*['"]([^'"]+\.[A-Za-z0-9]+)['"]/g)) out.add(m[1]); // p='file'; s=open(p)…write
  return [...out].map((f) => f.replace(/^['"]|['"]$/g, '')).filter(PLAUSIBLE);
}

function bashReads(cmd) {
  const out = new Set();
  for (const seg of cmd.split(/&&|\|\||;|\n/)) {
    const t = seg.trim().split(/\s+/);
    if (['cat', 'sed', 'head', 'tail', 'nl', 'less', 'bat'].includes(t[0]))
      for (const a of t.slice(1)) if (/\.[A-Za-z0-9]{1,6}$/.test(a) && !a.startsWith('-') && !/^\d+,\d+p$/.test(a)) out.add(a.replace(/^['"]|['"]$/g, ''));
  }
  return [...out].filter(PLAUSIBLE);
}

// One transcript -> session record. Incremental: only bytes after `prev.offset` are read.
export function scanSession(file, cwd, prev = null) {
  const s = prev ? { ...prev, edited: new Set(prev.edited), read: new Set(prev.read) } : {
    id: path.basename(file, '.jsonl'), start: null, end: null, prompts: [], commits: [], reply: '', edited: new Set(), read: new Set(), calls: 0, offset: 0,
    turns: [], // [{ q, a, ts, edits, model }]: each prompt with the turn's final answer, whether it changed files, and the model
  };
  s.turns = (prev?.turns || []).map((t) => ({ ...t }));
  const turn = () => s.turns[s.turns.length - 1];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < s.offset) return scanSession(file, cwd, null);
    const buf = Buffer.alloc(size - s.offset);
    fs.readSync(fd, buf, 0, buf.length, s.offset);
    const end = buf.lastIndexOf(10);
    if (end < 0) return s;
    s.offset += end + 1;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (d.isSidechain) continue;
      const ts = d.timestamp || null;
      if (ts) {
        s.start ||= ts;
        s.end = ts;
      }
      if (d.type === 'user' && !d.isMeta) {
        const t = userText(d.message).trim();
        if (t && !t.startsWith('<') && !t.startsWith('Caveat:')) {
          s.prompts.push(clip(t, PROMPT_CHARS));
          s.turns.push({ q: clip(t, PROMPT_CHARS), a: '', ts, edits: 0 });
          if (s.turns.length > MAX_TURNS) s.turns.shift();
        }
      } else if (d.type === 'assistant') {
        s.calls++;
        const m = d.message?.model;
        if (turn() && m && !m.startsWith('<')) turn().model = m;
        for (const c of d.message?.content || []) {
          if (c.type === 'text' && c.text.trim()) {
            s.reply = clip(c.text, REPLY_CHARS);
            if (turn()) turn().a = String(c.text).trim().slice(0, TURN_REPLY_CHARS + 1);
          }
          if (c.type === 'tool_use' && turn() && (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(c.name) ||
              (c.name === 'Bash' && bashWrites(String(c.input?.command || '')).length))) turn().edits++;
          if (c.type !== 'tool_use') continue;
          const inp = c.input || {};
          if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(c.name)) {
            const r = relTo(cwd, inp.file_path);
            if (r) s.edited.add(r);
          } else if (c.name === 'Read') {
            const r = relTo(cwd, inp.file_path);
            if (r) s.read.add(r);
          } else if (c.name === 'Bash') {
            const cmd = String(inp.command || '');
            // `cd DIR && …`: relative paths belong to DIR, which may be outside this project
            const cdm = /^\s*cd\s+(['"]?)([^'"\s;&|]+)\1\s*(?:&&|;)/.exec(cmd);
            const base = cdm ? path.resolve(cwd, cdm[2].replace(/^~(?=\/)/, process.env.HOME || '~')) : cwd;
            for (const f of bashWrites(cmd)) {
              const r = relTo(cwd, path.resolve(base, f));
              if (r) s.edited.add(r);
            }
            for (const f of bashReads(cmd)) {
              const r = relTo(cwd, path.resolve(base, f));
              if (r) s.read.add(r);
            }
            const cm = /git commit[^\n]*?-m\s+(?:"([^"]+)"|'([^']+)'|\$\(cat <<'?EOF'?\n([^\n]+))/.exec(cmd);
            if (cm) s.commits.push(clip(cm[1] || cm[2] || cm[3], 160));
          }
        }
      }
    }
  } catch {
    return s;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return s;
}

const serialize = (s) => ({ ...s, edited: [...s.edited].sort(), read: [...s.read].filter((f) => !s.edited.has(f)).sort() });

export const hasIndex = (cwd) => fs.existsSync(indexFile(cwd));

// Build or refresh the project index. Returns { project, sessions: [...] } with plain arrays.
export function buildIndex(cwd, { exclude = null } = {}) {
  const dir = transcriptDir(cwd);
  const file = indexFile(cwd);
  let idx = { version: VERSION, project: path.resolve(cwd), sessions: {} };
  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (old.version === VERSION) idx = old;
  } catch {}
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {}
  let changed = false;
  for (const n of names) {
    const f = path.join(dir, n);
    const id = n.slice(0, -6);
    const st = fs.statSync(f);
    const prev = idx.sessions[id];
    if (prev && prev.size === st.size) continue;
    const s = serialize(scanSession(f, cwd, prev ? { ...prev, edited: prev.edited, read: [...prev.read, ...prev.edited] } : null));
    s.size = st.size;
    idx.sessions[id] = s;
    changed = true;
  }
  for (const id of Object.keys(idx.sessions)) if (!names.includes(`${id}.jsonl`)) (delete idx.sessions[id], (changed = true));
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(idx));
  }
  const sessions = Object.values(idx.sessions)
    .filter((s) => s.id !== exclude && (s.prompts.length || s.edited.length))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
  return { project: idx.project, sessions };
}

// Graph view of the index: session, file and keyword nodes with typed edges (for the dashboard).
export function graph(cwd, { maxKeywords = 60 } = {}) {
  const { sessions } = buildIndex(cwd);
  const df = new Map();
  const sw = sessions.map((s) => {
    const w = new Set([...words(s.prompts.join(' ')), ...words(s.commits.join(' '))]);
    for (const x of w) df.set(x, (df.get(x) || 0) + 1);
    return w;
  });
  // topics first: words that also name an edited file or appear in a commit rank above words only said in prompts
  const strong = new Set(sessions.flatMap((s) => [...words(s.edited.join(' ').replace(/[/._-]/g, ' ')), ...words(s.commits.join(' '))]));
  const kws = [...df.entries()]
    .filter(([k, n]) => n >= (sessions.length > 3 ? 2 : 1) || strong.has(k))
    .sort((a, b) => (strong.has(b[0]) ? 2 : 1) * b[1] - (strong.has(a[0]) ? 2 : 1) * a[1])
    .slice(0, maxKeywords)
    .map(([k]) => k);
  const kwSet = new Set(kws);
  const nodes = [];
  const links = [];
  const fileIds = new Map();
  sessions.forEach((s, i) => {
    nodes.push({ id: `s:${s.id}`, type: 'session', label: clip(s.prompts[0] || s.commits[0] || s.id, 70), start: s.start, end: s.end, edited: s.edited.length, prompts: s.prompts.length });
    for (const f of s.edited) {
      if (!fileIds.has(f)) (fileIds.set(f, `f:${f}`), nodes.push({ id: `f:${f}`, type: 'file', label: f, edits: 0 }));
      nodes.find((n) => n.id === `f:${f}`).edits++;
      links.push({ source: `s:${s.id}`, target: `f:${f}`, kind: 'edited' });
    }
    for (const k of sw[i]) if (kwSet.has(k)) links.push({ source: `s:${s.id}`, target: `k:${k}`, kind: 'about' });
  });
  for (const k of kws) nodes.push({ id: `k:${k}`, type: 'keyword', label: k, sessions: df.get(k) });
  return { project: path.resolve(cwd), nodes, links };
}

// Ranked recall: sessions and files matching the query words (IDF-weighted, prompt > commits > files > reply).
export function recall(cwd, query, { limit = 5, exclude = null } = {}) {
  const { sessions } = buildIndex(cwd, { exclude });
  const q = [...new Set(words(query))];
  if (!q.length || !sessions.length) return { query: q, sessions: [], files: [], total: sessions.length };
  const fields = (s) => ({
    prompt: s.prompts.join(' ').toLowerCase(),
    commit: s.commits.join(' ').toLowerCase(),
    file: [...s.edited, ...s.read].join(' ').toLowerCase(),
    reply: String(s.reply).toLowerCase(),
  });
  const docs = sessions.map((s) => ({ s, f: fields(s) }));
  const idf = Object.fromEntries(q.map((w) => [w, Math.log(1 + docs.length / (1 + docs.filter((d) => Object.values(d.f).some((t) => t.includes(w))).length))]));
  const W = { prompt: 3, commit: 2.5, file: 2, reply: 1 };
  const scored = docs
    .map(({ s, f }) => ({ s, score: q.reduce((n, w) => n + idf[w] * Object.entries(W).reduce((m, [k, wt]) => m + (f[k].includes(w) ? wt : 0), 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || String(b.s.end).localeCompare(String(a.s.end)))
    .slice(0, limit);
  const fileScore = new Map();
  for (const { s, score } of scored) for (const f of s.edited) fileScore.set(f, (fileScore.get(f) || 0) + score + (q.some((w) => f.toLowerCase().includes(w)) ? 3 : 0));
  return {
    query: q,
    total: sessions.length,
    sessions: scored.map(({ s, score }) => ({ id: s.id, start: s.start, end: s.end, score: Math.round(score * 10) / 10, prompts: s.prompts.slice(0, 3), commits: s.commits.slice(-3), edited: s.edited.slice(0, 12), reply: s.reply })),
    files: [...fileScore.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([f]) => f),
  };
}

// Compact text for Claude: every line is re-read on later calls, so keep it short.
export function formatRecall(r) {
  if (!r.total) return 'tokenforge memory: no earlier sessions in this project.';
  if (!r.sessions.length) return `tokenforge memory: nothing in ${r.total} earlier sessions matches "${r.query.join(' ')}". Try other words (file names, feature names).`;
  const day = (t) => (t ? String(t).slice(0, 16).replace('T', ' ') : '?');
  const out = [`tokenforge memory: ${r.sessions.length} of ${r.total} earlier sessions match "${r.query.join(' ')}" (best first).`];
  for (const s of r.sessions) {
    out.push(`- ${day(s.start)} session ${s.id.slice(0, 8)}: ${s.prompts.map((p) => `"${clip(p, 160)}"`).join(' → ') || '(no prompt)'}`);
    if (s.commits.length) out.push(`  commits: ${s.commits.map((c) => `"${c}"`).join('; ')}`);
    if (s.edited.length) out.push(`  edited: ${s.edited.join(', ')}`);
    if (s.reply) out.push(`  ended with: ${clip(s.reply, 220)}`);
  }
  if (r.files.length) out.push(`files most tied to this: ${r.files.join(', ')}`);
  out.push('Details of one session: tforge recall --session ID. Read the current code before relying on old notes.');
  return out.join('\n');
}

export function sessionDetail(cwd, id) {
  const { sessions } = buildIndex(cwd);
  const s = sessions.find((x) => x.id.startsWith(id));
  if (!s) return `tokenforge memory: no session ${id} in this project.`;
  return [
    `session ${s.id} (${String(s.start).slice(0, 16)} to ${String(s.end).slice(11, 16)}, ${s.calls} calls)`,
    'prompts:', ...s.prompts.map((p, i) => `  ${i + 1}. ${p}`),
    s.commits.length ? `commits: ${s.commits.join('; ')}` : null,
    s.edited.length ? `edited: ${s.edited.join(', ')}` : null,
    s.read.length ? `read: ${s.read.slice(0, 20).join(', ')}${s.read.length > 20 ? ` (+${s.read.length - 20})` : ''}` : null,
    s.reply ? `last reply: ${s.reply}` : null,
  ].filter(Boolean).join('\n');
}

// First user prompt of a transcript, from its first 64 KB (no full scan).
function firstPrompt(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(65536, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString('utf8').split('\n')) {
      try {
        const d = JSON.parse(line);
        if (d.type === 'user' && !d.isMeta && !d.isSidechain) {
          const t = userText(d.message).trim();
          if (t && !t.startsWith('<') && !t.startsWith('Caveat:')) return { text: t, ts: d.timestamp };
        }
      } catch {}
    }
  } catch {
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

// One line for session start. Runs inside a 5 s hook, so it never builds the index: it counts transcripts and
// peeks at the newest. Tells Claude memory exists without spending tokens on its content.
export function memoryHint(cwd, currentSession) {
  const dir = transcriptDir(cwd);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && f !== `${currentSession}.jsonl`)
      .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
  } catch {}
  let latest = null;
  let n = 0;
  for (const { f } of files) {
    const p = firstPrompt(f);
    if (!p) continue; // empty or aborted session
    n++;
    latest ||= p;
  }
  if (!n) return null;
  return `tokenforge memory: ${n} earlier session${n > 1 ? 's' : ''} in this project (latest ${String(latest.ts || '').slice(0, 10)}: "${clip(latest.text, 80)}"). If the task builds on past work, run \`tforge recall <words>\` (feature, file or bug names) before exploring.`;
}

// ---------- repeated questions ----------
const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const contentSet = (t) => new Set(words(t));
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
};


// Requests whose point is a fresh look (review, proofread, verify, "again", "from scratch"): a stored answer is
// exactly what the user does not want, even word for word the same prompt.
const W = '(?<![\\p{L}\\p{N}_])'; // start of a word, accented letters included (\b is ASCII-only)
export const FRESH_LOOK = new RegExp([
  '\\b(re-?read|proof-?read|review|verify|check|audit|double[- ]check|look again|read again|from scratch|fresh|without context|re-?check|confirm|ensure|make sure|validate)',
  W + '(reli[sre]|relecture|v[ée]rifi|contr[ôo]le|corrig|erreurs?|incoh[ée]renc|incorrect|faute|impr[ée]cision|de nouveau|[àa] nouveau|de z[ée]ro|de 0|sans contexte|revoi[rs]|audit|confirme|assure-toi|valide)',
].join('|'), 'iu');

// Never replayed, whatever the wording around them: an action (run, test, build, deploy), a security question, or a
// question about the current state, whose true answer can change while no project file does.
export const NO_REPLAY = new RegExp([
  // run / test / build / deploy, and what running shows (failures, errors, slowness)
  '\\b(run|runs|rerun|running|execute|exec|launch|restart|stop|kill|test|tests|testing|tested|build|builds|building|compile|compiles|lint|bench|benchmarks?|deploy|deploys|deployed|deployment|release|publish|install|installed|upgrade|ship|ci|pipeline|pass|passes|passing|fail|fails|failing|failed|crash|crashes|broken|reproduce|repro|migrate|migration|error|errors|exception|warning|warnings|hang|hangs|slow|timeout|flaky)\\b',
  '\\b(do|does|is|are|did)\\s+(it|this|that|everything|they|\\w+)\\s+(still\\s+)?work',
  W + '(lance[rsz]?|relance|ex[ée]cute[rsz]?|teste[rsz]?|test[ée]|compile[rsz]?|build|d[ée]ploie|d[ée]ploy|install|mise? en prod|mets en prod|publie[rsz]?|[ée]choue|plant(e|é|ent)|migr)',
  '(ça|ca|il|elle|tout)\\s+(marche|fonctionne)|(marche|fonctionne)(nt)?-t?-?(il|elle|ils|elles)',
  // security
  W + "(secur|vulnerab|cve|exploit|inject|xss|csrf|ssrf|rce|authenticat|authoriz|password|passwd|passphrase|secret|credential|api[- ]?keys?|private key|leak|privilege|sanitiz|unsafe|attack|malware|encrypt|decrypt|s[ée]curit|vuln[ée]rab|faille|mot de passe|identifiant|chiffr|attaque|droits? d'acc[eè]s)",
  // current state
  '\\b(now|nowadays|currently|current|latest|newest|status|uptime|outage|online|offline|live|still|anymore|yet|today|this (week|morning)|right now|up[- ]to[- ]date|version|where (are we|do we stand))\\b',
  '\\b(is|are)\\s+(\\S+\\s+){1,3}(up|down)\\b',
  W + "(maintenant|o[uù] en (est|sont|sommes)|tourne|r[ée]pond|en panne|actuel|actuellement|en ce moment|derni[eè]re?s? version|version|[àa] jour|statut|[ée]tat|en ligne|hors ligne|toujours|encore|aujourd'hui|en cours|disponible)",
].join('|'), 'iu');

// Information questions: the only prompts whose answer may be replayed. Anything else (a request, or wording this
// does not recognize) goes to Claude: a missed reuse is cheap, a wrong one is not.
const QUESTION = new RegExp([
  "^(what|what's|whats|which|where|where's|why|how|who|whom|whose|when|does|do|did|is|are|was|were|has|have|should|explain|describe|summari[sz]e|define|tell me|remind me|(can|could|would) you (please )?(tell|explain|describe|remind|summari[sz]e))\\b",
  "^(qu'est[- ]ce|que |qu'|quel|quelle|quels|quelles|o[uù]\\s|pourquoi|comment|qui\\s|quand|combien|est[- ]ce que|lequel|laquelle|lesquel|c'est quoi|[àa] quoi|explique|d[ée]cris|r[ée]sume|d[ée]finis|dis-moi|rappelle-moi|y a-t-il|(peux|pourrais|pouvez|pourriez)[- ](tu|vous) (me dire|m'expliquer|expliquer|me rappeler|r[ée]sumer))",
  '^\\S+-(t-)?(il|elle|ils|elles|on)\\b',
].join('|'), 'i');

// Visible bypass, typed with the prompt: `!nocache` as its first or last word. The prompt goes to Claude as written.
export const BYPASS = /^\s*!nocache(\s|$)|(^|\s)!nocache\s*$/i;

export function replayable(prompt) {
  const p = String(prompt || '').replace(/[’‘]/g, "'").trim();
  if (BYPASS.test(p) || FRESH_LOOK.test(p) || NO_REPLAY.test(p)) return false;
  return QUESTION.test(p);
}

// ---------- what an answer depended on ----------
const sha = (x) => createHash('sha1').update(x).digest('hex');
const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, maxBuffer: 32 << 20 });
  return r.status === 0 ? r.stdout : null;
};
const MAX_DIRTY = 2000;
const BIG = 16 << 20;
const DEP_FILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum', 'go.work', 'pyproject.toml', 'poetry.lock', 'uv.lock', 'Pipfile', 'Pipfile.lock', 'setup.py',
  'setup.cfg', 'Gemfile', 'Gemfile.lock', 'composer.json', 'composer.lock', 'pom.xml', 'build.gradle', 'build.gradle.kts']);

// Content hash of one file; size+mtime+ctime instead for files over 16 MB, 'gone' for a missing one.
function fileHash(f) {
  try {
    const st = fs.statSync(f);
    if (!st.isFile()) return 'dir';
    if (st.size > BIG) return `big:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    return sha(fs.readFileSync(f));
  } catch {
    return 'gone';
  }
}

// Dependency manifests and lockfiles at the repo root and in cwd, by content.
function depsHash(dirs) {
  const out = [];
  for (const d of new Set(dirs.map((x) => path.resolve(x)))) {
    let names = [];
    try {
      names = fs.readdirSync(d).filter((n) => DEP_FILES.has(n) || /^requirements.*\.txt$/.test(n)).sort();
    } catch {}
    for (const n of names) out.push(`${path.join(d, n)}=${fileHash(path.join(d, n))}`);
  }
  return sha(out.join('\n'));
}

// Not a git repo: content hashes of the files a 3-level walk finds (no dot or build folders). Size, mtime, ctime and
// inode only pick which hashes to reuse, and never one taken less than 2 s after the file last changed (an edit in
// the same timestamp tick would look unchanged).
function walkHash(cwd) {
  const files = [];
  const walk = (d, depth) => {
    if (depth > 3 || files.length > 5000) return;
    for (const e of fs.readdirSync(path.join(cwd, d), { withFileTypes: true })) {
      if (e.name.startsWith('.') || ['node_modules', 'target', 'dist', 'build'].includes(e.name)) continue;
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel, depth + 1);
      else files.push(rel);
    }
  };
  walk('.', 0);
  if (files.length > 5000) return null;
  const cacheFile = path.join(cacheBase(), 'memory', `${projectKey(cwd)}.hashes.json`);
  let old = {};
  try {
    old = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {}
  const now = Date.now();
  const next = {};
  const out = [];
  for (const f of files.sort()) {
    let st;
    try {
      st = fs.statSync(path.join(cwd, f));
    } catch {
      continue;
    }
    const stat = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
    const o = old[f];
    const reuse = o && o.stat === stat && o.at - Math.max(st.mtimeMs, st.ctimeMs) > 2000;
    next[f] = reuse ? o : { stat, h: fileHash(path.join(cwd, f)), at: now };
    out.push(`${f}=${next[f].h}`);
  }
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(next));
  } catch {}
  return sha(out.join('\n'));
}

// The state an answer about this project depends on: which repo (top level and remotes, so two clones never share
// answers), HEAD and branch, the working tree by content (git status, which re-reads racily clean files, plus the
// content of every changed or untracked file), the dependency manifests, and the terse level. Null when unknown.
export function stateKey(cwd) {
  try {
    const top = git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
    if (!top) return { repo: `dir:${path.resolve(cwd)}`, head: 'none', tree: walkHash(cwd), deps: depsHash([cwd]), terse: terseLevel() };
    const remotes = git(top, ['config', '--get-regexp', '^remote\\..*\\.url$']) || '';
    const st = git(top, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']);
    if (st == null) return null;
    let oid = null;
    let branch = null;
    const dirty = [];
    const tok = st.split('\0');
    for (let i = 0; i < tok.length; i++) {
      const t = tok[i];
      if (t.startsWith('# branch.oid ')) oid = t.slice(13);
      else if (t.startsWith('# branch.head ')) branch = t.slice(14);
      else if (t[0] === '1') dirty.push(t.split(' ').slice(8).join(' '));
      else if (t[0] === '2') (dirty.push(t.split(' ').slice(9).join(' '), tok[i + 1]), i++);
      else if (t[0] === 'u') dirty.push(t.split(' ').slice(10).join(' '));
      else if (t[0] === '?') dirty.push(t.slice(2));
    }
    if (dirty.length > MAX_DIRTY) return null;
    const tree = sha([st, ...dirty.map((f) => `${f}=${fileHash(path.join(top, f))}`)].join('\n'));
    return { repo: sha(`${top}\n${remotes}`), head: `${branch}@${oid}`, tree, deps: depsHash([top, cwd]), terse: terseLevel() };
  } catch {
    return null;
  }
}

const sameState = (a, b) => !!a && !!b && ['repo', 'head', 'tree', 'deps', 'terse'].every((k) => a[k] != null && a[k] === b[k]);

// The state each replayable question was asked in, per session: an answer is replayed only into the same state.
const askedFile = (cwd) => path.join(cacheBase(), 'memory', `${projectKey(cwd)}.asked.json`);
const qKey = (q) => sha(norm(clip(q, PROMPT_CHARS))).slice(0, 16);
function readAsked(cwd) {
  try {
    return JSON.parse(fs.readFileSync(askedFile(cwd), 'utf8'));
  } catch {
    return [];
  }
}
export function noteAsked(cwd, session, prompt, state) {
  if (!state || !session) return;
  const all = [...readAsked(cwd).slice(-499), { s: String(session), q: qKey(prompt), at: Date.now(), state }];
  try {
    fs.mkdirSync(path.dirname(askedFile(cwd)), { recursive: true });
    fs.writeFileSync(askedFile(cwd), JSON.stringify(all));
  } catch {}
}

// Model of the latest reply in a transcript (UserPromptSubmit input does not carry the model), from its last 256 KB.
export function transcriptModel(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, 262144));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /"type":"assistant"/.test(lines[i]) && /"model":"([^"<]+)"/.exec(lines[i]);
      if (m) return m[1];
    }
  } catch {
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

// An earlier answer to the same question, if one is safe to reuse: both are information questions (replayable),
// the earlier turn changed no files and its answer is short, the model that gave it is the current one (when both
// are known), and the project is in the same state as when it was asked (stateKey). kind 'same' = identical wording
// or the same content words; 'similar' = heavy overlap (shown to Claude as a hint, never instead of asking).
// A question asked before its state was recorded is never reused.
export function earlierAnswer(cwd, prompt, { exclude = null, state, model = null } = {}) {
  const q = norm(prompt);
  const qs = contentSet(prompt);
  if (q.length < 12 || prompt.trim().startsWith('/') || qs.size < 2 || !replayable(prompt)) return null;
  const { sessions } = buildIndex(cwd);
  let best = null;
  for (const s of sessions) {
    for (const t of s.turns || []) {
      if (!t.a || t.edits || t.a.length > TURN_REPLY_CHARS || (s.id === exclude && norm(t.q) === q && t === s.turns[s.turns.length - 1])) continue;
      if (model && t.model && t.model !== model) continue;
      const same = norm(t.q) === q || (qs.size >= 3 && jaccard(qs, contentSet(t.q)) === 1);
      const sim = same ? 1 : jaccard(qs, contentSet(t.q));
      if (sim >= 0.6 && replayable(t.q) && (!best || sim > best.sim || (sim === best.sim && String(t.ts) > String(best.ts))))
        best = { kind: same ? 'same' : 'similar', sim, q: t.q, a: t.a, ts: t.ts, session: s.id };
    }
  }
  if (!best) return null;
  const k = qKey(best.q);
  const then = readAsked(cwd).filter((r) => r.s === best.session && r.q === k).pop();
  return then && sameState(then.state, state === undefined ? stateKey(cwd) : state) ? best : null;
}
