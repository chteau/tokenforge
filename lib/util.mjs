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
    if (skipping && /^(error|warning)(\[\w+\])?:/.test(l)) skipping = false;
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

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// Run a process; resolve with { code, stdout, stderr, ms, timedOut }. Never rejects.
export function run(cmd, args, { cwd, input, timeoutMs = 0, env, shell = false } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let stdout = '', stderr = '', timedOut = false, timer;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env || process.env, shell, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e.message, ms: 0, timedOut: false });
      return;
    }
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => (stderr += e.message));
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, timeoutMs);
    }
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, ms: Date.now() - t0, timedOut });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

export function runShell(command, opts) {
  return process.platform === 'win32'
    ? run('cmd.exe', ['/d', '/s', '/c', command], opts)
    : run('/bin/sh', ['-c', command], opts);
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
