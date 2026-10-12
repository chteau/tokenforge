// Property tests for the Bash router: commands generated from quoting, globs, paths with spaces, environment
// prefixes, substitutions, pipes, redirections and exit-code chains. Whatever the router rewrites must exit like the
// command as typed, leave the same files behind, and keep every line of output the original printed (tkit adds its
// own markers and may regroup grep's lines, never drop them under its cap). A fixed seed keeps failures reproducible;
// TFORGE_PROPERTY_SEED and TFORGE_PROPERTY_RUNS explore further.
import './tmp.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { routeCommand } from '../hooks/kit-router.mjs';
import { existingBinary } from '../lib/tmapbin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin');
const TMAP = existingBinary();
const SKIP = process.platform === 'win32' ? 'bash commands' : TMAP ? false : 'no tmap binary for this version (build native/tmap or set TMAP_BIN)';
const SEED = Number(process.env.TFORGE_PROPERTY_SEED) || 20261012;
const RUNS = Number(process.env.TFORGE_PROPERTY_RUNS) || 160;
const BASE_ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TFORGE_|TS_RAW|TMAP_BIN|NODE_TEST_CONTEXT)/.test(k))), TFORGE_GC: '0' };

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-prop-'));
  for (const d of ['sub', 'dir with space', "it's"]) fs.mkdirSync(path.join(dir, d));
  for (const f of ['a', 'b', 'B', '_x']) fs.writeFileSync(path.join(dir, `${f}.txt`), `${f} line\nneedle in ${f}\nNeedle upper\n`);
  fs.writeFileSync(path.join(dir, 'my file.txt'), 'needle spaced\n');
  fs.writeFileSync(path.join(dir, 'sub', 'c.rs'), 'fn needle() {}\n');
  fs.writeFileSync(path.join(dir, 'dir with space', 'x.txt'), 'needle x\n');
  fs.writeFileSync(path.join(dir, "it's", 'q.txt'), 'needle q\n');
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\nneedle again\n');
  return dir;
}

function sh(cmd, cwd) {
  const r = spawnSync('bash', ['-c', cmd], {
    cwd,
    encoding: 'utf8',
    env: { ...BASE_ENV, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, TFORGE_NO_DOWNLOAD: '1', XDG_CACHE_HOME: path.join(os.tmpdir(), 'prop-xdg'), TMAP_BIN: TMAP, PAT: 'needle', DIR: 'dir with space' },
    timeout: 20000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// Files a command left in the project, with their content (the .git dir aside).
function files(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.name === '.git') continue;
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const PATHS = ['.', 'sub', '"dir with space"', "'dir with space'", 'dir\\ with\\ space', '"$DIR"', `"it's"`, 'missing-dir'];
const PATTERNS = ['needle', '"needle in"', "'needle in a'", 'needle\\ in', '"$PAT"', 'Needle', 'nomatch', "'ne.dle'", '"$(echo needle)"', '`echo needle`'];
const NAMES = ['"*.txt"', "'*.rs'", '\\*.txt', '"my file.txt"', '"*"'];

function head(r) {
  switch (pick(r, ['find', 'find', 'grep', 'grep', 'grep', 'ls', 'git', 'cat'])) {
    case 'find': return { kind: 'find', cmd: `find ${pick(r, PATHS)}${r() < 0.6 ? ` -name ${pick(r, NAMES)}` : ''}${r() < 0.3 ? ' -type f' : ''}` };
    case 'grep': return { kind: 'grep', cmd: `grep -rn${r() < 0.3 ? 'i' : ''} ${pick(r, PATTERNS)} ${pick(r, PATHS)}` };
    case 'ls': return { kind: 'ls', cmd: `ls -R ${pick(r, PATHS)}` };
    case 'git': return { kind: 'git', cmd: pick(r, ['git status', 'git log', 'git diff', 'git diff -- a.txt', 'git show --stat HEAD']) };
    default: return { kind: 'cat', cmd: pick(r, ['cat *.txt', 'cat "my file.txt"', 'cat a.txt b.txt', 'cat missing.txt']) };
  }
}

function generate(r) {
  const h = head(r);
  let cmd = h.cmd;
  if (r() < 0.2) cmd = `${pick(r, ['FOO=1', 'LC_ALL=C', 'A="x y"'])} ${cmd}`;
  if (r() < 0.25) cmd += pick(r, [' 2>&1', ' 2>/dev/null', ' < /dev/null', ' > out.txt', ' >> b.txt', ' 2> err.txt']);
  if (r() < 0.2) cmd += pick(r, [' | head -n 2', ' | wc -l', ' | sort', ' | grep -c needle']);
  if (r() < 0.3) cmd += pick(r, ['; exit 3', ' && false', ' || true', ' && echo ok', ' || exit 7', '; echo "rc=$?"']);
  return { ...h, cmd };
}

const content = (s) => s.split('\n').filter((l) => l && !/^\[exit \d+\]$|lines omitted|^\.\.\. \[/.test(l));
// grep output regrouped by file still holds each match's text
const text = (l) => l.replace(/^[^:]*:\d+:/, '');

test('property: rewritten commands exit, write and print like the originals', { skip: SKIP }, () => {
  const r = rng(SEED);
  const seen = new Set();
  let rewritten = 0;
  for (let i = 0; i < RUNS; i++) {
    const g = generate(r);
    if (seen.has(g.cmd)) continue;
    seen.add(g.cmd);
    const dirA = project();
    const to = routeCommand(g.cmd, { cwd: dirA, permissionMode: 'bypassPermissions' })?.command;
    if (!to) continue;
    rewritten++;
    const dirB = project();
    const a = sh(g.cmd, dirA), b = sh(to, dirB);
    const why = `seed ${SEED}, case ${i}\n  ${g.cmd}\n  -> ${to}\n--- original (${a.code})\n${a.out}${a.err}--- rewritten (${b.code})\n${b.out}${b.err}`;
    assert.equal(b.code, a.code, why);
    assert.deepEqual(files(dirB), files(dirA), `files differ: ${why}`);
    // git's rewrites change the format on purpose (status -sb, log --oneline); everything else keeps its lines
    if (g.kind === 'git') continue;
    const bOut = b.out + b.err;
    for (const l of content(a.out)) assert.ok(bOut.includes(g.kind === 'grep' ? text(l) : l), `missing line ${JSON.stringify(l)}: ${why}`);
  }
  assert.ok(rewritten >= 25, `only ${rewritten} of the generated commands were rewritten`);
});
