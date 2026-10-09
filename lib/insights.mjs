// Dashboard insights computed on demand from transcripts (never cached; text stays local):
//  - health(): is tokenforge actually loaded in the sessions you are running?
//  - sessionCost(): which tool results cost the most once re-reads are counted.
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './meter.mjs';
import { BUILTIN_SKILLS, leanStatus } from './lean.mjs';
import { terseLevel } from './config.mjs';
import { exeName } from './hookutil.mjs';
import { fileURLToPath } from 'node:url';

const TAIL = 512 * 1024;
const HERE = path.dirname(fileURLToPath(import.meta.url)); // not URL.pathname: that gives /C:/... on Windows
export const PLUGIN_VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;

// Session-start hook errors sit at the top of a transcript, hook runs at the bottom: read both ends.
function endLines(file) {
  const head = headLines(file);
  const tail = tailLines(file);
  return head.length && tail.length && head[head.length - 1] === tail[0] ? head : [...head, ...tail];
}

function headLines(file, bytes = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(bytes, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString('utf8');
    return text.slice(0, text.lastIndexOf('\n')).split('\n').filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function tailLines(file, bytes = TAIL) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return (len < size ? text.slice(text.indexOf('\n') + 1) : text).split('\n').filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// One recent main-session transcript: does it run tokenforge's hooks, which build, and are any hooks dead?
export function sessionHealth(file) {
  const out = { file, session: path.basename(file, '.jsonl'), cwd: null, cc: null, tokenforge: null, deadPlugins: [], lastTs: null };
  for (const l of endLines(file)) {
    let d;
    try {
      d = JSON.parse(l);
    } catch {
      continue;
    }
    out.cwd = d.cwd || out.cwd;
    out.cc = d.version || out.cc;
    out.lastTs = d.timestamp || out.lastTs;
    const cmds = [];
    if (d.subtype === 'stop_hook_summary') for (const h of d.hookInfos || []) cmds.push(String(h.command || ''));
    const a = d.attachment;
    if (a && String(a.type || '').startsWith('hook')) {
      cmds.push(String(a.command || ''));
      const dead = /Plugin directory does not exist: \S+ \(([^)@\s]+)@/.exec(String(a.stderr || ''));
      if (dead && !out.deadPlugins.includes(dead[1])) out.deadPlugins.push(dead[1]);
    }
    for (const c of cmds) {
      const m = /tokenforge[\\/]tokenforge[\\/]([\d.]+)[\\/]/.exec(c) || (/tokenforge/.test(c) && /checkpoint\.mjs|kit-router\.mjs/.test(c) ? [null, 'dev'] : null);
      if (m) out.tokenforge = m[1];
    }
  }
  return out;
}

export function health(store, { hours = 24, now = Date.now() } = {}) {
  const recent = Object.entries(store.files)
    .filter(([, e]) => !e.sub && e.mtime && now - e.mtime < hours * 3600e3)
    .sort((a, b) => b[1].mtime - a[1].mtime)
    .slice(0, 40)
    .map(([f]) => sessionHealth(f));
  const ccVersions = [...new Set(recent.map((s) => s.cc).filter(Boolean))].sort();
  const newestCc = ccVersions[ccVersions.length - 1] || null;
  const issues = [];
  const without = recent.filter((s) => !s.tokenforge);
  if (without.length)
    issues.push({ level: 'warn', text: `${without.length} of ${recent.length} recent sessions ran without tokenforge's hooks: they started before it was installed or enabled. Restart them (plugins load when Claude Code starts; /clear does not reload them).`, sessions: without.map((s) => s.session) });
  const old = recent.filter((s) => s.tokenforge && s.tokenforge !== 'dev' && s.tokenforge !== PLUGIN_VERSION);
  if (old.length) issues.push({ level: 'info', text: `${old.length} sessions run an older tokenforge build (${[...new Set(old.map((s) => s.tokenforge))].join(', ')}); restart them to load ${PLUGIN_VERSION}.`, sessions: old.map((s) => s.session) });
  const dead = [...new Set(recent.flatMap((s) => s.deadPlugins))];
  if (dead.length) issues.push({ level: 'warn', text: `Hooks of removed plugins still fire in running sessions: ${dead.join(', ')}. Restart those sessions.`, sessions: recent.filter((s) => s.deadPlugins.length).map((s) => s.session) });
  const lean = safe(() => leanStatus(), { on: false, level: 'off', active: [] });
  if (!lean.on) issues.push({ level: 'tip', text: 'Lean tools are off: every request carries ~7k tokens of tool and skill definitions you probably never use. "balanced" (the default) hides agent-orchestration tools and built-in skills (still typeable): 16.9k down to 9.7k per request.' });
  return { pluginVersion: PLUGIN_VERSION, claudeCodeVersions: ccVersions, newestClaudeCode: newestCc, sessions: recent, issues, lean: { on: lean.on, level: lean.level, active: lean.active.length, skillsKeep: lean.skillsKeep || [] }, builtinSkills: BUILTIN_SKILLS, terse: terseLevel() };
}

const safe = (f, d) => {
  try {
    return f();
  } catch {
    return d;
  }
};

const resultText = (c) =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.type === 'text' ? x.text : '')).join('\n') : '';

// Tool results ranked by what they cost the session: chars / 4 x the number of later requests that re-read them.
export function sessionCost(file, top = 15) {
  const uses = new Map();
  const items = [];
  const seen = new Set();
  let req = 0;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { error: 'transcript not found' };
  }
  for (const l of text.split('\n')) {
    if (!l) continue;
    let d;
    try {
      d = JSON.parse(l);
    } catch {
      continue;
    }
    if (d.type === 'assistant') {
      const key = d.requestId || d.message?.id;
      if (key && !seen.has(key)) {
        seen.add(key);
        req++;
      }
      for (const c of d.message?.content || [])
        if (c.type === 'tool_use') uses.set(c.id, { tool: c.name, what: String(c.input?.command || c.input?.file_path || c.input?.pattern || c.input?.description || '').slice(0, 160) });
    } else if (d.type === 'user' && Array.isArray(d.message?.content)) {
      for (const c of d.message.content)
        if (c.type === 'tool_result') items.push({ req, chars: resultText(c.content).length, ...(uses.get(c.tool_use_id) || { tool: '?', what: '' }) });
    }
  }
  const total = req;
  for (const it of items) {
    it.rereads = Math.max(0, total - it.req);
    it.estTokens = Math.round((it.chars / 4) * it.rereads);
  }
  const sum = items.reduce((n, it) => n + it.estTokens, 0);
  return {
    requests: total,
    toolResults: items.length,
    estTokensFromResults: sum,
    method: 'estimated: characters / 4 x later requests that re-read the result',
    top: items.sort((a, b) => b.estTokens - a.estTokens).slice(0, top).map((it) => ({ ...it, share: sum ? Math.round((1000 * it.estTokens) / sum) / 10 : 0 })),
  };
}

export const transcriptOf = (store, id) =>
  Object.entries(store.files).find(([, e]) => e.session === id && !e.sub)?.[0] || path.join(configDir(), 'projects', '?', `${id}.jsonl`);

const SUBCMD = new Set(['git', 'gh', 'cargo', 'npm', 'pnpm', 'yarn', 'docker', 'go', 'kubectl', 'tkit', 'tforge', 'tmap', 'claude', 'pip', 'pip3', 'uv',
  'make', 'node', 'python', 'python3', 'brew', 'systemctl']);
const INTERP = new Set(['node', 'python', 'python3']);
// prefixes that run the command after them (their options and durations skipped)
const WRAP = new Set(['time', 'timeout', 'nice', 'env', 'sudo', 'command', 'exec', 'xargs', 'nohup', 'stdbuf', 'if', 'elif', 'while', 'until', 'then', 'else', 'do', '!']);
// glue that prints little: the next command in the line is the one that cost
const GLUE = new Set(['cd', 'export', 'set', 'source', '.', 'true', 'false', 'echo', 'printf', 'sleep', 'unset', 'pushd', 'popd', 'local', 'shopt', 'trap', 'wait',
  'mkdir', 'read', '[', '[[', 'test', 'fi', 'done', 'esac', '{', '}']);
const QUOTED = '\u0000';

// What a Bash call is about, to attribute its cost: `cd x && FOO=1 timeout 60 cargo test -p a` -> `cargo test`,
// `for f in *; do wc -l $f; done` -> `wc`, `python3 - <<'EOF'` -> `python3 -`. Heredoc bodies and quoted text are skipped.
export function mainCommand(cmd) {
  const kept = [];
  let end;
  for (const l of String(cmd).split('\n')) {
    if (end) {
      if (l.trim() === end) end = undefined;
      continue;
    }
    kept.push(l);
    end = /(?<!<)<<-?\s*(['"]?)([\w.-]+)\1/.exec(l)?.[2];
  }
  const text = kept
    .join('\n')
    .replace(/\$\([^()]*\)?|`[^`]*`?/g, '_') // a substitution's output is captured, not printed
    .replace(/'[^']*'?|"(?:\\.|[^"\\])*"?/g, (q) => QUOTED + q.slice(1).replace(/["']$/, '').replace(/[\s;&|()<>]/g, '_'));
  let first;
  for (const seg of text.split(/&&|\|\||[;&|\n()]/)) {
    const t = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    for (;;) {
      while (/^\w+=/.test(t[i] || '')) i++;
      if (!WRAP.has(t[i])) break;
      for (i++; /^-|^\d+(\.\d+)?[smhd]?$/.test(t[i] || ''); i++);
    }
    if (i >= t.length || ['for', 'case', 'select'].includes(t[i])) continue;
    const exe = exeName(t[i].replace(QUOTED, ''));
    first ??= exe;
    // stdout sent to a file (`cat > f <<EOF`) prints nothing
    if (GLUE.has(exe) || t.some((x) => /^(1?>>?|&>>?)(?!&)/.test(x))) continue;
    if (INTERP.has(exe)) {
      for (const [j, a] of t.entries()) {
        if (j <= i) continue;
        if (/^-[cem]?$/.test(a)) return `${exe} ${a === '-m' && t[j + 1] ? `-m ${t[j + 1]}` : a}`;
        if (!a.startsWith('-')) return `${exe} *${path.extname(a.replace(QUOTED, ''))}`;
      }
      return exe;
    }
    // the subcommand is the word right after the program (git: after its global options; cargo: after +toolchain)
    let j = i + 1;
    while (/^\+/.test(t[j] || '') || (exe === 'git' && /^-/.test(t[j] || ''))) j += exe === 'git' && /^-[Cc]$/.test(t[j]) ? 2 : 1;
    return SUBCMD.has(exe) && /^[a-z][\w:-]*$/.test(t[j] || '') ? `${exe} ${t[j]}` : exe;
  }
  return first || '?';
}

// Bash commands ranked by what their results cost across sessions (same estimate as sessionCost), to pick what to route next.
export function commandCosts(files, top = 15) {
  const by = new Map();
  for (const f of files) {
    const r = sessionCost(f, Infinity);
    for (const it of r.top || []) {
      if (it.tool !== 'Bash') continue;
      const key = mainCommand(it.what);
      const e = by.get(key) || { cmd: key, calls: 0, tokens: 0, chars: 0 };
      e.calls++;
      e.tokens += it.estTokens;
      e.chars += it.chars;
      by.set(key, e);
    }
  }
  return [...by.values()].sort((a, b) => b.tokens - a.tokens).slice(0, top).map((e) => ({ cmd: e.cmd, calls: e.calls, estTokens: e.tokens, avgResultTokens: Math.round(e.chars / 4 / e.calls) }));
}
