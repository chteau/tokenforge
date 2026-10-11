// Stale-context pruning for the proxy. Every request re-sends the whole history, so content the conversation itself
// has made redundant is paid again on every later call. Only content whose information is still in the context, or
// was replaced by something newer, goes:
//   - a file's earlier read (Read, `cat FILE`, `tview FILE`) once the file was read again over the same lines, or
//     rewritten whole (Write, `cat > FILE <<EOF`);
//   - the content of a Write or heredoc, and the strings of a large Edit, once the file was read whole or
//     rewritten later;
//   - the output of a shell command that ran again later, word for word;
//   - thinking blocks of earlier turns (before the last prompt the user typed): never those of the current turn,
//     which the API needs back while tools run.
// Each one leaves a one-line stub saying what went and why, so the model can read again what it needs.
//
// Cache: removing old content means the requests after it re-write everything from that point to the cache.
// Decisions are batched and remembered (the proxy memo), so each item changes once and every later request sends
// the same bytes. TFORGE_PROXY_PRUNE picks when a batch goes:
//   tokens (default) as soon as at least TFORGE_PROXY_PRUNE_MIN chars (8000) are stale: fewest tokens;
//   cost   only when it is cheaper in dollars: the cache already expired (the gap passed its TTL), or the stale
//          content sits near the end, so what is written again costs less than the reads saved;
//   off    never (earlier decisions are still replayed, so a conversation's cache holds).
import { sha } from './util.mjs';

const OFF = new Set(['0', 'false', 'off', 'no']);
export function pruneMode(v = process.env.TFORGE_PROXY_PRUNE) {
  const s = String(v ?? '').trim().toLowerCase();
  return OFF.has(s) ? 'off' : s === 'cost' ? 'cost' : 'tokens';
}
export const pruneMin = () => (Number.isFinite(Number(process.env.TFORGE_PROXY_PRUNE_MIN)) && process.env.TFORGE_PROXY_PRUNE_MIN !== '' ? Number(process.env.TFORGE_PROXY_PRUNE_MIN) : 8000);
// Smaller items are not worth a stub.
export const ITEM_MIN = 1000;
// USD per million tokens relative to a cache read: writes cost 1.25x (5m) or 2x (1h) the base input, reads 0.1x.
const WRITE_OVER_READ = { '5m': 25, '1h': 40 };

const len = (v) => (v == null ? 0 : typeof v === 'string' ? v.length : JSON.stringify(v).length);
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '');
const lineCount = (s) => String(s).split('\n').length;

export function samePath(a, b) {
  if (!a || !b) return false;
  a = String(a).replace(/^\.\//, '');
  b = String(b).replace(/^\.\//, '');
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
}

// Shell commands. A read is a chain (`;`, `&&`) of plain file prints: `cat [-n] FILES`, `tview FILE`,
// `sed -n 'A,Bp[;C,Dp]' FILE`, `head [-n N] FILE`; anything else (a pipe, a grep, a pattern range) makes it an
// ordinary command. A write is `cat > FILE <<EOF` (or `>>`, which appends), possibly after `mkdir -p … &&`.
const HEREDOC = /^([^\n]*?(?:&&|;)[ \t]*)?cat[ \t]*(>>?)[ \t]*(['"]?)([^\s'"|;&<>]+)\3[ \t]*<<-?[ \t]*(['"]?)(\w+)\5[ \t]*\n/;
const PATH = /^[^\s'"|;&<>$`()]+$/;
const unquote = (w) => w.replace(/^(['"])(.*)\1$/, '$2');
// one level of brace expansion, as in `src/{a,b}.ts`
const braces = (w) => {
  const m = /^([^{}]*)\{([^{}]*,[^{}]*)\}([^{}]*)$/.exec(w);
  return m ? m[2].split(',').map((x) => m[1] + x + m[3]) : [w];
};
function shellRead(seg) {
  const words = seg.replace(/\s+2>\s*\/dev\/null\s*$/, '').trim().split(/\s+/).map(unquote);
  const [cmd, ...args] = words;
  const files = (ws) => (ws.length && ws.every((w) => PATH.test(w)) ? ws.flatMap(braces) : null);
  if (cmd === 'cat' || cmd === 'tview') {
    const f = files(args.filter((w) => !(cmd === 'cat' && w === '-n')));
    return f && f.map((file) => ({ file, from: 1, to: Infinity }));
  }
  if (cmd === 'sed' && args[0] === '-n' && args.length === 3) {
    const f = files([args[2]]);
    const parts = args[1].split(';').map((r) => /^(\d+)(?:,(\d+))?p$/.exec(r));
    if (!f || f.length !== 1 || parts.some((m) => !m)) return null;
    return parts.map((m) => ({ file: f[0], from: Number(m[1]), to: Number(m[2] ?? m[1]) }));
  }
  if (cmd === 'head') {
    let n = 10;
    let rest = args;
    if (/^-\d+$/.test(rest[0] || '')) [n, rest] = [Number(rest[0].slice(1)), rest.slice(1)];
    else if (rest[0] === '-n' && /^\d+$/.test(rest[1] || '')) [n, rest] = [Number(rest[1]), rest.slice(2)];
    const f = files(rest);
    return f && f.length === 1 ? [{ file: f[0], from: 1, to: n }] : null;
  }
  return null;
}
function shellReads(command) {
  if (/[\n|<>`$]/.test(command.replace(/\s+2>\s*\/dev\/null/g, ''))) return null;
  const out = [];
  // split on ; and && outside quotes
  const segs = command.match(/(?:'[^']*'|"[^"]*"|[^;&'"])+/g) || [];
  if (/(?<!&)&(?!&)/.test(command.replace(/'[^']*'|"[^"]*"/g, ''))) return null; // a lone & backgrounds
  for (const seg of segs.map((x) => x.trim()).filter(Boolean)) {
    const r = shellRead(seg);
    if (!r) return null;
    out.push(...r);
  }
  return out.length ? out : null;
}
// Test and build runs: once the code changed and the same run went again, the earlier output is history, even when
// the two runs filtered their output differently (`npm test 2>&1 | grep FAIL`).
const RUNNER = /^(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:npm (?:run )?test|pnpm (?:run )?test|yarn (?:run )?test|npx (?:vitest|jest|tsc)|pytest|python3? -m pytest|cargo (?:test|build|check|clippy)|go (?:test|build|vet)|make|tkit test|node --test|tsc|mvn|gradle|\.\/gradlew)\b/;
const runCore = (cmd) => cmd.split(/\s*\|\s*/)[0].replace(/\s*2>&1\s*$/, '').trim();

// One operation per tool call, in conversation order.
function operations(msgs) {
  const results = new Map();
  msgs.forEach((m, mi) => {
    if (m.role === 'user' && Array.isArray(m.content)) for (const b of m.content) if (b && b.type === 'tool_result') results.set(b.tool_use_id, { b, mi });
  });
  const ops = [];
  msgs.forEach((m, mi) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return;
    for (const u of m.content) {
      if (!u || u.type !== 'tool_use') continue;
      const r = results.get(u.id);
      const input = u.input || {};
      const op = { mi, u, r: r?.b, rmi: r?.mi, ok: !!r && !r.b.is_error };
      if (u.name === 'Read' && !input.pages) {
        const from = Number(input.offset) || 1;
        // Claude Code's Read without a limit shows the first 2000 lines
        Object.assign(op, { kind: 'read', ranges: [{ file: input.file_path, from, to: input.limit != null ? from + Number(input.limit) - 1 : from + 1999 }] });
      } else if (u.name === 'Write') Object.assign(op, { kind: 'write', file: input.file_path });
      else if (u.name === 'Edit' || u.name === 'MultiEdit') Object.assign(op, { kind: 'edit', file: input.file_path });
      else if (u.name === 'Bash' && typeof input.command === 'string') {
        const command = input.command.trim();
        const hd = HEREDOC.exec(input.command);
        const rd = !hd && shellReads(command);
        if (hd) Object.assign(op, { kind: 'write', file: hd[4], heredoc: hd, append: hd[2] === '>>' });
        else if (rd) Object.assign(op, { kind: 'read', ranges: rd });
        else Object.assign(op, { kind: 'cmd', cmd: command, run: RUNNER.test(command) ? runCore(command) : null });
      } else continue;
      ops.push(op);
    }
  });
  return ops;
}

// Is `range` shown again whole by `o`, or replaced by its full rewrite?
const covers = (o, range) =>
  o.kind === 'write' ? !o.append && samePath(o.file, range.file) : o.kind === 'read' && o.ranges.some((x) => samePath(x.file, range.file) && x.from <= range.from && x.to >= range.to);

// Why `op` is stale, from what came after it; null when it is not.
function staleBecause(op, later) {
  const after = later.filter((o) => o.mi > op.mi && o.ok);
  if (op.kind === 'cmd') {
    if (after.some((o) => o.kind === 'cmd' && o.cmd === op.cmd)) return 'the same command ran again later';
    if (!op.run) return null;
    // a later run with something changed before it: a write, an edit, or a command that is neither a read nor a run
    let changed = false;
    for (const o of after) {
      if (o.kind === 'cmd' && o.run === op.run && changed) return `\`${op.run}\` ran again after changes`;
      if (o.kind === 'write' || o.kind === 'edit' || (o.kind === 'cmd' && !o.run)) changed = true;
    }
    return null;
  }
  if (op.kind === 'read') {
    const why = op.ranges.map((r) => after.find((o) => covers(o, r)));
    if (why.some((o) => !o)) return null;
    const files = [...new Set(op.ranges.map((r) => r.file))];
    const name = files.length === 1 ? files[0] : `${files.length} files`;
    return why.every((o) => o.kind === 'write') ? `${name} ${files.length === 1 ? 'was' : 'were'} rewritten later` : `${name} ${files.length === 1 ? 'was' : 'were'} read again later`;
  }
  // a write's or an edit's text: once the file is shown whole again, or rewritten
  const whole = { file: op.file, from: 1, to: 2000 };
  const o = after.find((x) => covers(x, whole));
  return o ? (o.kind === 'write' ? `${op.file} was rewritten later` : `${op.file} was read again later`) : null;
}

const stub = (what, n, why) => `[tokenforge: ${what} removed (${n} chars): ${why}]`;

// Everything that may go, with the memo key it is remembered under and what replaces it.
export function candidates(msgs) {
  const out = [];
  const ops = operations(msgs);
  for (const op of ops) {
    const why = staleBecause(op, ops);
    if (!why) continue;
    const input = op.u.input || {};
    if ((op.kind === 'read' || op.kind === 'cmd') && op.r && !op.r.cache_control) {
      const c = op.r.content;
      // images and documents pass whole
      if (Array.isArray(c) && !c.every((b) => b && b.type === 'text')) continue;
      const n = len(textOf(c));
      if (n >= ITEM_MIN) out.push({ type: 'result', key: op.u.id, mi: op.rmi, chars: n, block: op.r, h: sha(c ?? ''), c: stub(op.kind === 'cmd' ? 'stale output' : 'stale file content', n, why) });
    }
    if (op.u.cache_control) continue;
    let next = null;
    if (op.kind === 'write' && op.heredoc && op.u.input.command.length >= ITEM_MIN) {
      const cmd = input.command;
      const end = cmd.indexOf(`\n${op.heredoc[6]}`, op.heredoc[0].length - 1);
      if (end > 0) next = { ...input, command: `${op.heredoc[0]}${stub(`${lineCount(cmd.slice(op.heredoc[0].length, end))} written lines`, end - op.heredoc[0].length, why)}${cmd.slice(end)}` };
    } else if (op.kind === 'write' && !op.heredoc && len(input.content) >= ITEM_MIN) {
      next = { ...input, content: stub(`${lineCount(input.content)} written lines`, len(input.content), why) };
    } else if (op.kind === 'edit' && len(input) >= ITEM_MIN) {
      const s = stub('edit text', len(input), why);
      next = Array.isArray(input.edits) ? { ...input, edits: [{ old_string: s, new_string: s }] } : { ...input, old_string: s, new_string: s };
    }
    if (next) out.push({ type: 'input', key: `in:${op.u.id}`, mi: op.mi, chars: len(input) - len(next), block: op.u, h: sha(JSON.stringify(input)), c: JSON.stringify(next) });
  }
  // thinking of turns before the last prompt the user typed
  let lastPrompt = -1;
  msgs.forEach((m, i) => {
    if (m.role === 'user' && (typeof m.content === 'string' || (Array.isArray(m.content) && m.content.some((b) => b && b.type !== 'tool_result')))) lastPrompt = i;
  });
  for (let i = 0; i < lastPrompt; i++) {
    const m = msgs[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content) || m.content.every((b) => b && /thinking$/.test(b.type))) continue;
    for (const b of m.content) {
      if (!b || !/^(redacted_)?thinking$/.test(b.type) || b.cache_control) continue;
      const k = thinkingKey(b);
      out.push({ type: 'thinking', key: k, mi: i, chars: len(b.thinking ?? b.data), block: b, h: k, c: '' });
    }
  }
  return out;
}

const thinkingKey = (b) => `th:${sha(b.signature || b.data || b.thinking || '').slice(0, 24)}`;

// Should the pending batch go now? `pending.after` is the history size from the first pending item to the end,
// `requests` how many model calls the conversation made so far (a guess at how many are still to come).
export function shouldCommit(pending, { mode, min, cold, requests, ttl = '1h' }) {
  if (mode === 'off' || !pending.length) return false;
  const chars = pending.reduce((s, p) => s + p.chars, 0);
  if (cold) return true;
  if (mode === 'tokens') return chars >= min;
  // cost: what is written again (from the first stale item to the end, minus what goes) against the reads saved
  const after = Math.max(0, pending.after - chars);
  return chars * Math.max(1, requests) > after * (WRITE_OVER_READ[ttl] || 40);
}

// Apply earlier decisions and, when shouldCommit says so, take the pending ones. Mutates `body`.
export function pruneRequest(body, memo, { mode = pruneMode(), min = pruneMin(), cold = false, ttl = '1h' } = {}) {
  const st = { pruned: 0, prunedChars: 0, committed: 0, changed: false };
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  if (!msgs.length) return st;
  const all = candidates(msgs);
  const pending = all.filter((c) => !memo.get(c.key)?.p);
  if (pending.length) {
    const sizes = msgs.map(len);
    const first = Math.min(...pending.map((p) => p.mi));
    pending.after = sizes.slice(first).reduce((a, b) => a + b, 0);
    const requests = msgs.filter((m) => m.role === 'assistant').length;
    if (shouldCommit(pending, { mode, min, cold, requests, ttl })) {
      const t = Date.now();
      for (const p of pending) memo.set(p.key, { h: p.h, c: p.c, t, p: 1 });
      st.committed = pending.length;
    }
  }
  // replay every decision, old and new
  for (const c of all) {
    const e = memo.get(c.key);
    if (!e?.p || e.h !== c.h) continue;
    if (c.type === 'result') c.block.content = e.c;
    else if (c.type === 'input') c.block.input = JSON.parse(e.c);
    else c.block.drop = true;
    st.pruned++;
    st.prunedChars += c.chars;
    st.changed = true;
  }
  for (const m of msgs) if (Array.isArray(m.content) && m.content.some((b) => b?.drop)) m.content = m.content.filter((b) => !b?.drop);
  return st;
}
