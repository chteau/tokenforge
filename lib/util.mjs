import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const FORGE_DIR = '.forge';

// Nearest ancestor holding .git (a dir, or a file in worktrees and submodules); cwd itself outside a repo.
export function projectRoot(cwd) {
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return path.resolve(cwd);
  }
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(s) {
  return String(s).replace(ANSI, '');
}

// Stack frames inside runtimes and dependencies say nothing a worker can act on.
const NOISE = /^\s+at .*(\(node:|\(internal\/|node_modules[\\/])|^\s+at (async )?process\.processTicksAndRejections\b|^\s*at [^/\\(]*\(native\)/;

// When a compiler reports errors, its warning blocks (rustc/cargo style: "warning: ..." up to a blank line) are noise.
function dropWarnings(lines) {
  if (!lines.some((l) => /^error(\[E\d+\])?:/.test(l))) return lines;
  const out = [];
  let skipping = false, warnings = 0;
  for (const l of lines) {
    if (/^warning(\[\w+\])?:/.test(l) && !/generated \d+ warning/.test(l)) {
      skipping = true;
      warnings++;
      continue;
    }
    // a block's own lines are indented, numbered (`2 |`) or help/note; any other line at column 0 (a test runner's
    // FAILED line, a summary) is not part of it and must survive
    if (skipping && (/^(error|warning)(\[\w+\])?:/.test(l) || (/^[A-Za-z]/.test(l) && !/^(help|note)\b/.test(l)))) skipping = false;
    if (skipping) {
      if (l.trim() === '') skipping = false;
      continue;
    }
    out.push(l);
  }
  if (warnings) out.push(`[${warnings} compiler warning block(s) dropped]`);
  return out;
}

export function condense(text) {
  const out = [];
  let dropped = 0;
  for (const line of dropWarnings(stripAnsi(text).split('\n'))) {
    if (NOISE.test(line)) {
      dropped++;
      continue;
    }
    if (dropped) {
      out.push(`    [${dropped} runtime frames]`);
      dropped = 0;
    }
    out.push(line);
  }
  if (dropped) out.push(`    [${dropped} runtime frames]`);
  return out.join('\n');
}

// Keep the end of long output: failures and summaries live there.
export function tail(text, maxLines = 80, maxChars = 6000) {
  let lines = condense(text).split('\n');
  const dropped = Math.max(0, lines.length - maxLines);
  lines = lines.slice(-maxLines);
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(-maxChars);
  return dropped ? `[... ${dropped} earlier lines dropped]\n${out}` : out;
}

export function sha(...parts) {
  const h = createHash('sha256');
  for (const p of parts) h.update(typeof p === 'string' ? p : JSON.stringify(p));
  return h.digest('hex').slice(0, 16);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined && e.code === 'ENOENT') return fallback;
    throw new Error(`${file}: ${e.message}`);
  }
}

// "<bytes>:<hash>" of a file's first 4 KB. An append-only file (a transcript) was replaced, not appended to, when
// sameHead() fails: its first bytes, as many as the stored head covered, changed.
export function headHash(file, max = 4096) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return `${n}:${createHash('sha1').update(buf.subarray(0, n)).digest('hex').slice(0, 16)}`;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
export const sameHead = (file, head) => !head || headHash(file, Number(head.split(':')[0])) === head;

// Readers see the old file or the new one, never a torn write: a crash leaves at most a stray .tmp beside it.
export function writeFileAtomic(file, text, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export function writeJsonAtomic(file, data) {
  writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n');
}

export function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// Where a bare command name resolves on PATH, trying PATHEXT on Windows. Null when not found.
export function findOnPath(name, { platform = process.platform, env = process.env } = {}) {
  const win = platform === 'win32';
  const exts = win ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean)] : [''];
  const dirs = /[\\/]/.test(name) ? [''] : (env.PATH ?? env.Path ?? '').split(win ? ';' : ':').filter(Boolean);
  for (const d of dirs) {
    for (const x of exts) {
      const f = d ? path.join(d, name + x) : name + x;
      try {
        if (fs.statSync(f).isFile() && (!win || x || /\.(exe|com)$/i.test(f))) return f;
      } catch {}
    }
  }
  return null;
}

// cmd.exe quoting, as cross-spawn does it: quote for the program's argv parser, then ^-escape cmd metacharacters
// (twice for node_modules/.bin shims, which cmd parses again).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function cmdArg(arg, twice) {
  let a = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  a = `"${a}"`.replace(CMD_META, '^$1');
  return twice ? a.replace(CMD_META, '^$1') : a;
}

// How to spawn `cmd args` without a shell. On Windows, Node runs .exe files only; a .cmd/.bat (npm's `claude.cmd`)
// goes through cmd.exe with every argument escaped, so prompts and paths with spaces or quotes arrive intact.
export function spawnable(cmd, args, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return { cmd, args, opts: {} };
  const file = findOnPath(cmd, { platform, env });
  if (!file || !/\.(cmd|bat)$/i.test(file)) return { cmd: file || cmd, args, opts: {} };
  const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file);
  const line = [file.replace(CMD_META, '^$1'), ...args.map((a) => cmdArg(a, twice))].join(' ');
  return { cmd: env.comspec || env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], opts: { windowsVerbatimArguments: true } };
}

// Process groups of running checks: killed with the driver, so a Ctrl+C or an exit leaves no check behind.
const groups = new Set();
function killTree(child, signal) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-child.pid, signal);
  } catch {}
}
let reaper = false;
function trackGroup(child) {
  groups.add(child);
  if (reaper) return;
  reaper = true;
  process.on('exit', () => groups.forEach((c) => killTree(c, 'SIGKILL')));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => {
      groups.forEach((c) => killTree(c, 'SIGKILL'));
      if (!process.listenerCount(sig)) process.kill(process.pid, sig);
    });
  }
}

// Run a process; resolve with { code, stdout, stderr, ms, timedOut }. Never rejects. With `group`, the process
// leads its own process group and the timeout kills the whole tree: a check's `sh -c` would otherwise leave its
// children running, holding the output pipes open past the timeout.
export function run(cmd, args, { cwd, input, timeoutMs = 0, env, shell = false, group = false } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let stdout = '', stderr = '', timedOut = false, timer, done = false;
    let child;
    try {
      const sp = shell ? { cmd, args, opts: {} } : spawnable(cmd, args, { env: env || process.env });
      child = spawn(sp.cmd, sp.args, { cwd, env: env || process.env, shell, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: group && process.platform !== 'win32', ...sp.opts });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e.message, ms: 0, timedOut: false });
      return;
    }
    if (group) trackGroup(child);
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      groups.delete(child);
      resolve({ code: code ?? -1, stdout, stderr, ms: Date.now() - t0, timedOut });
    };
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => (stderr += e.message));
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        if (group) killTree(child, 'SIGTERM');
        else child.kill('SIGTERM');
        setTimeout(() => {
          if (group) killTree(child, 'SIGKILL');
          else child.kill('SIGKILL');
          // a grandchild outside the group (setsid, a daemon) may still hold the pipes: stop waiting for them
          setTimeout(() => {
            child.stdout.destroy();
            child.stderr.destroy();
            finish(null);
          }, 2000).unref();
        }, 5000).unref();
      }, timeoutMs);
    }
    child.on('close', finish);
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

export function runShell(command, opts) {
  return process.platform === 'win32'
    ? run('cmd.exe', ['/d', '/s', '/c', command], { group: true, ...opts })
    : run('/bin/sh', ['-c', command], { group: true, ...opts });
}

const SKIP_DIRS = new Set(['node_modules', '.git', FORGE_DIR, 'dist', 'build', '.next', 'coverage', 'target', '.venv', '__pycache__', '.cache']);

// path -> "mtimeMs:size" for every file under root, skipping vendor/build dirs.
export function snapshot(root) {
  const out = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(p);
          out.set(path.relative(root, p).split(path.sep).join('/'), `${st.mtimeMs}:${st.size}`);
        } catch {}
      }
    }
  };
  walk(root);
  return out;
}

export function changedFiles(before, after) {
  const changed = [];
  for (const [p, v] of after) if (before.get(p) !== v) changed.push(p);
  for (const p of before.keys()) if (!after.has(p)) changed.push(p);
  return changed;
}

export function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

export function fmtUsd(n) {
  return '$' + (n || 0).toFixed(n >= 10 ? 2 : 3);
}
