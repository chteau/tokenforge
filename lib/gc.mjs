// Disk garbage collector: rules, no model. Claude Code keeps each session's scratch (scratchpad, task output,
// images) in /tmp/claude-<uid>/<project>/<session>/ and never deletes it, so a few heavy sessions fill the disk
// until transcript writes fail (ENOSPC). gc() frees what no live session can still use:
// - a session dir is live while Claude Code's registry (~/.claude/sessions) lists its process as running, while a
//   process has its cwd or an open file inside it, or when it is the calling session; live dirs are never walked.
// - dead dirs idle >= 12h (1h on a nearly full disk) share one budget, Greedy-Dual-Size: value = e^(-idle/1 day)
//   per byte, lowest evicted first until at most 2 GiB stays and free space is back above twice the low-water
//   mark. Dirs idle over 7 days always go.
// - tokenforge's own leftovers (hook state, test dirs, old binaries, caches) expire by age.
// maybeGc() is the hook trigger: a stat or two, at most every 6h (10 min on a nearly full disk), run detached.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOff, stateDir, unattended } from './hookutil.mjs';
import { configDir } from './meter.mjs';
import { EXE, tmapVersion } from './tmapbin.mjs';
import { cacheBase } from './usage.mjs';
import { writeJsonAtomic } from './util.mjs';

const H = 3600e3;
const D = 24 * H;
const GiB = 2 ** 30;
const MIN_IDLE = 12 * H;
const MIN_IDLE_PRESSED = H;
const MAX_IDLE = 7 * D;
const KEEP = 2 * GiB;
const EVERY = 6 * H;
const EVERY_PRESSED = 10 * 60e3;
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/;

const ls = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};
const lstat = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};
const mtime = (p) => lstat(p)?.mtimeMs || 0;

export const fmtBytes = (n) => (n >= GiB ? `${(n / GiB).toFixed(1)}G` : n >= 2 ** 20 ? `${(n / 2 ** 20).toFixed(1)}M` : `${Math.ceil(n / 1024)}K`);

// Claude Code's scratch root is under /tmp (or CLAUDE_CODE_TMPDIR), not os.tmpdir(); Windows has none.
export const scratchRoot = () => (process.getuid ? path.join(process.env.CLAUDE_CODE_TMPDIR || '/tmp', `claude-${process.getuid()}`) : null);

// Free space of the filesystem holding p; below `low` (5% of it, within 2-10 GiB) the disk is nearly full.
export function diskSpace(p) {
  try {
    const s = fs.statfsSync(p);
    const free = s.bavail * s.bsize;
    const size = s.blocks * s.bsize;
    const low = Math.min(10 * GiB, Math.max(2 * GiB, 0.05 * size));
    return { free, size, low, pressure: free < low };
  } catch {
    return null;
  }
}

// The pid runs and is still the process that registered (a reused pid has another start time).
function pidAlive(pid, procStart) {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return false;
  }
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return procStart == null || st.slice(st.lastIndexOf(')') + 2).split(' ')[19] === String(procStart);
  } catch {
    return true;
  }
}

// Session ids of running Claude Code processes; null when the registry is unreadable (then no scratch is evicted).
// A process in another pid namespace can't be checked from here, so it counts as running.
function registryLive(cfg) {
  const dir = path.join(cfg, 'sessions');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let ns = null;
  try {
    ns = fs.readlinkSync('/proc/self/ns/pid');
  } catch {}
  const live = new Set();
  for (const n of names.filter((n) => n.endsWith('.json'))) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      const foreign = ns && r.pidDomain && !r.pidDomain.endsWith(ns);
      if (r.sessionId && (foreign || pidAlive(Number(r.pid), r.procStart))) live.add(r.sessionId);
    } catch {}
  }
  return live;
}

// <project>/<session> dirs under root that a process works in: its cwd, executable or an open file (Linux /proc,
// elsewhere lsof). null when that can't be told (then no scratch is evicted).
function heldDirs(root) {
  const held = new Set();
  let real;
  try {
    real = fs.realpathSync(root) + path.sep;
  } catch {
    return held;
  }
  const add = (p) => p.startsWith(real) && held.add(p.slice(real.length).split(path.sep).slice(0, 2).join(path.sep));
  const note = (link) => {
    try {
      add(fs.readlinkSync(link));
    } catch {}
  };
  const pids = ls('/proc').filter((p) => /^\d+$/.test(p));
  for (const pid of pids) {
    note(`/proc/${pid}/cwd`);
    note(`/proc/${pid}/exe`);
    for (const fd of ls(`/proc/${pid}/fd`)) note(`/proc/${pid}/fd/${fd}`);
  }
  if (pids.length) return held;
  let out;
  try {
    out = execFileSync('lsof', ['-n', '-P', '-w', '-F', 'n', '-u', String(process.getuid())], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 2 ** 28, timeout: 60e3 });
  } catch (e) {
    // lsof exits 1 when some files can't be read; a timeout or a missing lsof leaves no answer
    if (e.signal || !e.stdout) return null;
    out = e.stdout;
  }
  for (const line of out.split('\n')) if (line[0] === 'n') add(line.slice(1));
  return held;
}

// Every entry under p, lstat'ed: symlinks are not followed.
function* walk(p) {
  const stack = [p];
  while (stack.length) {
    const q = stack.pop();
    const st = lstat(q);
    if (!st) continue;
    yield [q, st];
    if (st.isDirectory()) for (const n of ls(q)) stack.push(path.join(q, n));
  }
}

function treeStat(p) {
  let bytes = 0;
  let newest = 0;
  for (const [, st] of walk(p)) {
    bytes += st.blocks * 512 || st.size;
    newest = Math.max(newest, st.mtimeMs);
  }
  return { bytes, newest };
}

function rmTree(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (e) {
    if (e.code !== 'EACCES' && e.code !== 'EPERM') throw e;
    // read-only dirs (a Go module cache) can't be emptied until they are writable
    for (const [q, st] of walk(p))
      if (st.isDirectory())
        try {
          fs.chmodSync(q, 0o700);
        } catch {}
    fs.rmSync(p, { recursive: true, force: true });
  }
}

const value = (d) => Math.exp(-d.idle / D) / Math.max(d.bytes, 4096);
const total = (xs) => xs.reduce((s, d) => s + d.bytes, 0);

// Dead session dirs to evict from Claude Code's scratch root.
function scratchVictims({ root, cfg, live, now, space }) {
  const held = heldDirs(root);
  if (!held) return [];
  const minIdle = space?.pressure ? MIN_IDLE_PRESSED : MIN_IDLE;
  const dead = [];
  for (const p of ls(root).filter((n) => n.startsWith('-'))) {
    for (const sid of ls(path.join(root, p))) {
      if (sid.length !== 36 || !UUID.test(sid) || live.has(sid) || held.has(path.join(p, sid))) continue;
      // the transcript first: a session that wrote to it lately is not walked at all
      const used = mtime(path.join(cfg, 'projects', p, `${sid}.jsonl`));
      if (now - used < minIdle) continue;
      const dir = path.join(root, p, sid);
      const { bytes, newest } = treeStat(dir);
      const idle = now - Math.max(used, newest);
      if (idle >= minIdle) dead.push({ kind: 'session scratch', path: dir, bytes, idle });
    }
  }
  const doomed = dead.filter((d) => d.idle > MAX_IDLE);
  const rest = dead.filter((d) => d.idle <= MAX_IDLE).sort((a, b) => value(a) - value(b));
  const deficit = space ? Math.max(0, 2 * space.low - space.free - total(doomed)) : 0;
  let kept = total(rest);
  const budget = Math.max(0, Math.min(KEEP, kept - deficit));
  for (const d of rest) if (kept > budget) (doomed.push(d), (kept -= d.bytes));
  return doomed;
}

// tokenforge's own leftovers, by age; atime counts too where files are only read (binaries, caches).
function leftovers({ cfg, cache, tmp, live, now }) {
  const out = [];
  const uid = process.getuid?.();
  const aged = (kind, dir, maxAge, match = () => true, atime = false) => {
    for (const n of ls(dir)) {
      const p = path.join(dir, n);
      const st = match(n) && lstat(p);
      if (!st || (uid !== undefined && st.uid !== uid)) continue;
      const age = now - Math.max(st.mtimeMs, atime ? st.atimeMs : 0);
      if (age > (typeof maxAge === 'function' ? maxAge(n) : maxAge)) out.push({ kind, path: p, bytes: treeStat(p).bytes });
    }
  };
  // per-session state lives as long as session scratch; any other name is test residue
  aged('hook state', stateDir(tmp), (n) => (UUID.test(n) ? MAX_IDLE : H), (n) => !live.has(n.slice(0, 36)));
  aged('temp dir', tmp, D, (n) => /^(tforge-|tmap-test-|tmap-edit-)/.test(n) && !n.startsWith('tforge-ssh-'));
  let current = null;
  try {
    current = `tmap-${tmapVersion()}${EXE}`;
  } catch {}
  if (current) aged('old tmap binary', path.join(cache, 'bin'), MAX_IDLE, (n) => n.startsWith('tmap-') && n !== current, true);
  for (const d of ['', ...ls(cache)]) aged('partial write', path.join(cache, d), H, (n) => n.endsWith('.tmp'));
  aged('run log', path.join(cache, 'run'), MAX_IDLE);
  aged('web cache', path.join(cache, 'web'), D);
  aged('doc cache', path.join(cache, 'docs'), 30 * D, undefined, true);
  aged('instructions cache', path.join(cache, 'instr'), 30 * D, undefined, true);
  aged('code map', path.join(cache, 'tmap'), 30 * D, (n) => n.endsWith('.bin'), true);
  aged('recall index', path.join(cache, 'memory'), H, (n) => n.endsWith('.json') && !fs.existsSync(path.join(cfg, 'projects', n.slice(0, -5))));
  return out;
}

// One gc at a time; a lock older than 10 minutes belongs to a gc that died.
function takeLock(file) {
  for (let i = 0; i < 2; i++) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.closeSync(fs.openSync(file, 'wx'));
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST' || Date.now() - mtime(file) < 10 * 60e3) return false;
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}

export function gc({ root = scratchRoot(), cfg = configDir(), cache = cacheBase(), tmp = os.tmpdir(), now = Date.now(), sessionId = process.env.CLAUDE_CODE_SESSION_ID, dryRun = false, space } = {}) {
  space ??= (root && diskSpace(root)) || diskSpace(cfg);
  const lock = path.join(cache, 'gc.lock');
  if (!dryRun && !takeLock(lock)) return { busy: true };
  try {
    const registry = registryLive(cfg);
    const live = new Set([...(registry || []), ...(sessionId ? [sessionId] : [])]);
    const doomed = [...(root && registry ? scratchVictims({ root, cfg, live, now, space }) : []), ...leftovers({ cfg, cache, tmp, live, now })];
    let errors = 0;
    const removed = dryRun
      ? doomed
      : doomed.filter((d) => {
          try {
            rmTree(d.path);
          } catch {
            errors++;
            return false;
          }
          if (d.kind === 'session scratch')
            try {
              fs.rmdirSync(path.dirname(d.path));
            } catch {}
          return true;
        });
    const r = { dryRun, free: space?.free ?? null, size: space?.size ?? null, pressure: !!space?.pressure, removed, freed: total(removed), errors };
    if (!dryRun) writeJsonAtomic(path.join(cache, 'gc.json'), { at: new Date(now).toISOString(), freed: r.freed, removed: removed.length, errors });
    return r;
  } finally {
    if (!dryRun) fs.rmSync(lock, { force: true });
  }
}

// Hook trigger: when a gc is due, run `tforge gc --auto` detached so the hook returns at once.
export function maybeGc(cwd, sessionId, now = Date.now()) {
  if (isOff('TFORGE_GC') || unattended()) return;
  try {
    const mark = path.join(cacheBase(), 'gc.json');
    const age = now - mtime(mark);
    if (age < EVERY_PRESSED || (age < EVERY && ![configDir(), scratchRoot()].some((p) => p && diskSpace(p)?.pressure))) return;
    fs.mkdirSync(path.dirname(mark), { recursive: true });
    fs.closeSync(fs.openSync(mark, 'a'));
    fs.utimesSync(mark, now / 1e3, now / 1e3);
    const tforge = fileURLToPath(new URL('../bin/tforge', import.meta.url));
    const child = spawn(process.execPath, [tforge, 'gc', '--auto', ...(sessionId ? ['--session', sessionId] : [])], { cwd, detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

export function formatGc(r, snapshots = [], handoff = false) {
  const kinds = new Map();
  for (const d of r.removed) {
    const k = kinds.get(d.kind) || { n: 0, bytes: 0 };
    kinds.set(d.kind, { n: k.n + 1, bytes: k.bytes + d.bytes });
  }
  const disk = r.free == null ? 'disk space unknown' : `disk ${fmtBytes(r.free)} free of ${fmtBytes(r.size)}${r.dryRun ? '' : ' before'}${r.pressure ? ' (nearly full)' : ''}`;
  const lines = [`tforge gc${r.dryRun ? ' --dry-run' : ''}: ${r.dryRun ? 'would free' : 'freed'} ${fmtBytes(r.freed)}${r.errors ? `, ${r.errors} could not be removed` : ''}; ${disk}`];
  for (const [k, v] of kinds) lines.push(`  ${k.padEnd(20)}${String(v.n).padStart(6)}${fmtBytes(v.bytes).padStart(9)}`);
  const big = [...r.removed].sort((a, b) => b.bytes - a.bytes);
  for (const d of big.slice(0, 30)) lines.push(`  ${fmtBytes(d.bytes).padStart(7)}  ${d.path}${d.idle ? `  (idle ${(d.idle / D).toFixed(1)} days)` : ''}`);
  if (big.length > 30) lines.push(`  … ${big.length - 30} more`);
  if (snapshots.length) lines.push(`snapshots ${r.dryRun ? 'to forget' : 'forgotten'}: ${snapshots.join(', ')}`);
  if (handoff) lines.push(`.forge/HANDOFF.md: automatic handoff already used; ${r.dryRun ? 'would be removed' : 'removed'}`);
  return lines.join('\n');
}
