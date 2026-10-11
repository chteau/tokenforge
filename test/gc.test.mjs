import './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AUTO_MARK, chunkName, listSnapshots, noteHandoffGiven, noteLoad, pruneSnapshots, render, staleHandoff } from '../hooks/checkpoint.mjs';
import { formatGc, gc } from '../lib/gc.mjs';
import { stateDir } from '../lib/hookutil.mjs';
import { EXE, tmapVersion } from '../lib/tmapbin.mjs';

const H = 3600e3;
const D = 24 * H;
const GiB = 2 ** 30;
const now = Date.now();
const ROOMY = { free: 100 * GiB, size: 1000 * GiB, low: 10 * GiB, pressure: false };
const FULL = { free: GiB, size: 100 * GiB, low: 5 * GiB, pressure: true };
const uuid = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`;
const tmpdir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const paths = (r) => r.removed.map((d) => d.path).sort();

// A file last written `age` ms ago, in a directory as old.
function make(file, age, text = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const t = (now - age) / 1e3;
  fs.utimesSync(file, t, t);
  fs.utimesSync(path.dirname(file), t, t);
  return file;
}

// Claude Code scratch of six sessions and tokenforge's leftovers: gc's options, the paths by role, the expected victims.
function machine() {
  const base = tmpdir('gc-');
  const [root, cfg, cache, tmp] = ['scratch', 'cfg', 'cache', 'tmp'].map((d) => path.join(base, d));
  const session = (n, age) => path.dirname(make(path.join(root, '-proj', uuid(n), 'out.txt'), age));
  const state = (name, age) => make(path.join(stateDir(tmp), name), age);
  const p = {
    old: session(1, 8 * D),
    idle: session(2, 2 * D),
    live: session(3, 8 * D),
    used: session(4, 8 * D),
    caller: session(5, 8 * D),
    fresh: session(6, 30 * 60e3),
    tools: path.dirname(make(path.join(root, 'xwin-tools', 'bin', 'clang'), 30 * D)),
    odd: path.dirname(make(path.join(root, '-proj', 'notes', 'f'), 30 * D)),
    deadState: state(`${uuid(1)}-main-instr.json`, 8 * D),
    liveState: state(`${uuid(3)}-main-instr.json`, 8 * D),
    recentState: state(`${uuid(2)}-main-instr.json`, 2 * D),
    stray: state('stray.json', 2 * H),
    testDir: path.dirname(make(path.join(tmp, 'tforge-old', 'f'), 2 * D)),
    newTestDir: path.dirname(make(path.join(tmp, 'tforge-new', 'f'), H)),
    ssh: path.dirname(make(path.join(tmp, 'tforge-ssh-x', 'sock'), 2 * D)),
    oldBin: make(path.join(cache, 'bin', 'tmap-0.0.1'), 8 * D),
    bin: make(path.join(cache, 'bin', `tmap-${tmapVersion()}${EXE}`), 30 * D),
    oldLog: make(path.join(cache, 'run', '1.log'), 8 * D),
    log: make(path.join(cache, 'run', '2.log'), D),
    partial: make(path.join(cache, 'x.tmp'), 2 * H),
    goneIndex: make(path.join(cache, 'memory', '-gone.json'), 2 * H),
    index: make(path.join(cache, 'memory', '-proj.json'), 2 * H),
  };
  make(path.join(cfg, 'projects', '-proj', `${uuid(4)}.jsonl`), 0);
  make(path.join(cfg, 'sessions', '1.json'), 0, JSON.stringify({ sessionId: uuid(3), pid: process.pid }));
  make(path.join(cfg, 'sessions', '2.json'), 0, JSON.stringify({ sessionId: uuid(1), pid: 2 ** 22 + 1 }));
  const victims = [p.old, p.deadState, p.stray, p.testDir, p.oldBin, p.oldLog, p.partial, p.goneIndex].sort();
  return { opts: { root, cfg, cache, tmp, now, sessionId: uuid(5) }, p, victims };
}

test('gc frees what no live session can use; a dry run only lists it', () => {
  const { opts, p, victims } = machine();
  const dry = gc({ ...opts, dryRun: true, space: ROOMY });
  assert.deepEqual(paths(dry), victims);
  assert.ok(Object.values(p).every((f) => fs.existsSync(f)));
  assert.match(formatGc(dry).split('\n')[0], /^tforge gc --dry-run: would free \d+K; disk 100\.0G free of 1000\.0G$/);
  const r = gc({ ...opts, space: ROOMY });
  assert.deepEqual([paths(r), r.errors], [victims, 0]);
  for (const [k, f] of Object.entries(p)) assert.equal(fs.existsSync(f), !victims.includes(f), k);
  assert.equal(JSON.parse(fs.readFileSync(path.join(opts.cache, 'gc.json'), 'utf8')).removed, victims.length);
});

test('gc on a nearly full disk also takes sessions idle for hours, never live ones', () => {
  const { opts, p, victims } = machine();
  assert.deepEqual(paths(gc({ ...opts, dryRun: true, space: FULL })), [...victims, p.idle].sort());
});

test('gc spares a session dir a process works in, all of them without the registry, and runs once at a time', () => {
  const { opts, p } = machine();
  const here = process.cwd();
  process.chdir(p.old);
  try {
    assert.ok(!paths(gc({ ...opts, dryRun: true, space: FULL })).includes(p.old));
  } finally {
    process.chdir(here);
  }
  fs.rmSync(path.join(opts.cfg, 'sessions'), { recursive: true });
  assert.ok(!gc({ ...opts, dryRun: true, space: FULL }).removed.some((d) => d.kind === 'session scratch'));
  fs.writeFileSync(path.join(opts.cache, 'gc.lock'), '');
  assert.deepEqual(gc({ ...opts, space: FULL }), { busy: true });
});

// A snapshot chunk as checkpoint.mjs writes it, started `age` ms ago.
function snapshot(cwd, sessionId, n, age, files = []) {
  const at = new Date(now - age).toISOString();
  const c = { n, start: at, end: at, prompts: ['go'], files: files.map((f) => path.join(cwd, f)), reply: 'done', ctx: 0, turns: [] };
  make(path.join(cwd, '.forge', 'snapshots', chunkName(c, sessionId)), age, render(c, sessionId, cwd));
  return chunkName(c, sessionId);
}

test('pruneSnapshots forgets chunks by use, missing files and newer chunks; the newest six stay', () => {
  const cwd = tmpdir('snap-');
  for (const f of ['a.js', 'b.js', 'c.js']) fs.writeFileSync(path.join(cwd, f), '');
  const chunk = (n, days, files) => snapshot(cwd, uuid(7), n, days * D, files);
  const stale = chunk(1, 25, ['a.js']); // unread since, and later chunks changed its file
  const reread = chunk(2, 25, ['b.js']); // as old, but read back an hour ago
  const orphan = chunk(3, 6, ['gone.js']);
  const kept = chunk(4, 6, ['c.js']);
  const replaced = chunk(5, 4, ['a.js']);
  const newest = [6, 7, 8, 9, 10, 11].map((n) => chunk(n, 3.5 - n / 5, n === 6 ? ['a.js'] : ['d.js'])); // weak but protected
  noteLoad(cwd, [stale], now - 25 * D);
  noteLoad(cwd, [reread], now - H);
  const doomed = [stale, orphan, replaced];
  assert.deepEqual(pruneSnapshots(cwd, { now, dryRun: true }), doomed);
  assert.equal(listSnapshots(cwd).length, 11);
  assert.deepEqual(pruneSnapshots(cwd, { now }), doomed);
  assert.deepEqual(listSnapshots(cwd), [reread, kept, ...newest]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(cwd, '.forge', 'snapshots', 'loads.json'), 'utf8'))), [reread]);
});

test('staleHandoff archives an automatic handoff once a session given it worked, or when past the cap', () => {
  const cwd = tmpdir('handoff-');
  const file = path.join(cwd, '.forge', 'HANDOFF.md');
  const auto = `${AUTO_MARK}\n# Handoff (automatic, session 11111111, 2026-10-09 01:00 UTC, context ~50k tokens)\n`;
  make(file, 30 * D, '# Handoff\nWritten by the user.\n');
  assert.equal(staleHandoff(cwd, 336, { now }), false);
  make(file, 4 * D, auto); // a long weekend: time alone does not spend it
  const mtime = fs.statSync(file).mtimeMs;
  snapshot(cwd, uuid(1), 1, 30 * 60e3); // its writer started again
  snapshot(cwd, uuid(2), 1, 30 * 60e3); // a parallel session that was never given it
  assert.equal(staleHandoff(cwd, 336, { now }), false);
  noteHandoffGiven(cwd, uuid(3), mtime); // given at startup, no work yet
  assert.equal(staleHandoff(cwd, 336, { now }), false);
  snapshot(cwd, uuid(3), 1, 20 * 60e3);
  assert.equal(staleHandoff(cwd, 336, { now, dryRun: true }), true);
  assert.ok(fs.existsSync(file));
  assert.equal(staleHandoff(cwd, 336, { now }), true);
  assert.ok(!fs.existsSync(file));
  const archived = fs.readdirSync(path.join(cwd, '.forge', 'handoffs'));
  assert.equal(archived.length, 1);
  assert.match(archived[0], /^\d{8}-\d{4}-11111111\.md$/);
  assert.match(fs.readFileSync(path.join(cwd, '.forge', '.gitignore'), 'utf8'), /^handoffs\/$/m);
  const old = tmpdir('handoff-');
  make(path.join(old, '.forge', 'HANDOFF.md'), 337 * H, auto);
  assert.equal(staleHandoff(old, 336, { now }), true);
});
