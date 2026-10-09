// Shared helpers for the hooks: stdin JSON, on/off switches, the "identical repeat goes through"
// escape hatch, and a small POSIX-shell tokenizer/quoter for the Bash router.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

const OFF = new Set(['0', 'off', 'false', 'no']);
export const isOff = (name) => OFF.has(String(process.env[name] ?? '').toLowerCase());

// The kit hooks (Bash router, prompt router, MCP distill, kit policy text) are on by default.
// TFORGE_KIT_HOOKS=0 turns all of them off; `own` is the hook's own switch.
export const kitHookOff = (own) => isOff('TFORGE_KIT_HOOKS') || (own ? isOff(own) : false);

// No one at the keyboard: SDK runs, CI, or sessions Claude Code marks unattended.
export const unattended = () => /^sdk/.test(process.env.CLAUDE_CODE_ENTRYPOINT || '') || process.env.CLAUDE_CODE_SESSION_ATTENDED === '0' || !!process.env.CI;

// Per-user dir of small hook state files, named after the session id.
export const stateDir = (base = os.tmpdir()) => path.join(base, `tokenforge-${process.getuid?.() ?? 'u'}`);

// First call is redirected; an identical second call in the same session is let through.
export function seenBefore(sessionId, key, tag = 'redirect') {
  const dir = stateDir();
  const file = path.join(dir, `${String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '')}-${tag}.json`);
  let seen = [];
  try {
    seen = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  const h = createHash('sha1').update(key).digest('hex').slice(0, 16);
  if (seen.includes(h)) return true;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify([...seen.slice(-200), h]));
  } catch {}
  return false;
}

export function deny(event, reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: reason } }));
}

// Run the tmap binary with a hard timeout; stdout on success, else null.
export function runTmap(bin, args, { cwd, input, timeout = 8000, env } = {}) {
  try {
    const r = spawnSync(bin, args, { cwd, input, encoding: 'utf8', timeout, env: env ? { ...process.env, ...env } : process.env, maxBuffer: 8 << 20 });
    return r.status === 0 && r.stdout ? r.stdout : null;
  } catch {
    return null;
  }
}

// Keep at most `lines` lines and `chars` characters.
export function cap(text, lines, chars = 24000) {
  let out = String(text || '').replace(/\s+$/, '');
  const all = out.split('\n');
  if (all.length > lines) out = all.slice(0, lines).join('\n') + `\n[+${all.length - lines} more lines]`;
  if (out.length > chars) out = out.slice(0, chars) + '\n[truncated]';
  return out;
}

// Split a command line on ; && || and newlines outside quotes. Returns [[text, sep], ...],
// or null when unsure (unbalanced quotes, subshells, backticks).
export function splitSegments(cmd) {
  const out = [];
  let buf = '';
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      buf += c;
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < cmd.length) buf += cmd[++i];
    } else if (c === "'" || c === '"') {
      q = c;
      buf += c;
    } else if (c === '\\' && i + 1 < cmd.length) {
      buf += c + cmd[++i];
    } else if (cmd.startsWith('&&', i) || cmd.startsWith('||', i)) {
      out.push([buf, cmd.slice(i, i + 2)]);
      buf = '';
      i++;
    } else if (c === ';' || c === '\n') {
      out.push([buf, c]);
      buf = '';
    } else if (cmd.startsWith('$(', i) || c === '`') {
      return null;
    } else buf += c;
  }
  if (q) return null;
  out.push([buf, '']);
  return out;
}

// Split one segment on single `|` outside quotes.
export function splitPipes(seg) {
  const out = [];
  let buf = '';
  let q = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === "'" || c === '"') q = c;
    else if (c === '\\') {
      buf += c + (seg[++i] ?? '');
      continue;
    } else if (c === '|') {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out;
}

// shlex.split-like tokenizer (POSIX rules for quotes and backslashes). Null on unbalanced quotes.
export function tokenize(s) {
  const out = [];
  let cur = '';
  let has = false;
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") {
      if (c === "'") q = null;
      else cur += c;
    } else if (q === '"') {
      if (c === '"') q = null;
      else if (c === '\\' && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else cur += c;
  }
  if (q) return null;
  if (has || cur) out.push(cur);
  return out;
}

// Quote for a POSIX shell (bash, also Git Bash on Windows).
export const shq = (x) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, `'\\''`)}'`);

// Command name without directory or Windows extension: C:\x\cargo.exe -> cargo, npm.cmd -> npm.
export const exeName = (t) => String(t || '').split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '');

// True when the module at `metaUrl` is the script node was started with (hooks are also imported by tests).
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(metaUrl));
  } catch {
    return false;
  }
}
