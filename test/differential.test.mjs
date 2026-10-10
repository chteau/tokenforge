// Differential tests for the Bash router: a command it rewrites must behave like the command as typed. Each case runs
// both forms in a temp dir and compares exit codes, and stdout too where the rewrite is pure shell (cat -> tview).
// Cases that run tkit need the tmap binary and are skipped without it; the rest check the router's output alone.
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
import { tail } from '../lib/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin');
const TMAP = existingBinary();
const NO_TMAP = TMAP ? false : 'no tmap binary for this version (build native/tmap or set TMAP_BIN)';
const BASE_ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TFORGE_|TS_RAW|TMAP_BIN)/.test(k))), TFORGE_GC: '0' };

const tmpdir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const route = (cmd, cwd = os.tmpdir()) => routeCommand(cmd, { cwd, permissionMode: 'bypassPermissions' })?.command ?? null;

// Both forms run under bash with the repo's bin/ first on PATH, so `tkit` and `tview` resolve to this checkout.
function sh(cmd, cwd, env = {}) {
  const r = spawnSync('bash', ['-c', cmd], {
    cwd,
    encoding: 'utf8',
    env: { ...BASE_ENV, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, TFORGE_NO_DOWNLOAD: '1', XDG_CACHE_HOME: path.join(cwd, '.xdg'), ...(TMAP ? { TMAP_BIN: TMAP } : {}), ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// A rewritten command must exist and exit like the original; returns both runs.
function differ(cmd, cwd, env) {
  const rewritten = route(cmd, cwd);
  assert.ok(rewritten, `router leaves ${JSON.stringify(cmd)} alone`);
  const a = sh(cmd, cwd, env), b = sh(rewritten, cwd, env);
  assert.equal(b.code, a.code, `${cmd}\n  -> ${rewritten}\n${b.out}${b.err}`);
  return { a, b, rewritten };
}

// tkit's own lines (cap marker, exit status) and grep's per-file headers are presentation, not content.
const content = (s) => s.split('\n').filter((l) => l && !/^\[exit \d+\]$|^\.\.\. \[\d+ of \d+ lines omitted/.test(l));

function project() {
  const dir = tmpdir('tforge-diff-');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.mkdirSync(path.join(dir, 'dir with space'));
  for (const f of ['b', 'a', 'c', 'B', '_x']) fs.writeFileSync(path.join(dir, `${f}.txt`), `${f} line\nneedle in ${f}\n`);
  fs.writeFileSync(path.join(dir, 'my file.txt'), 'spaced\n');
  fs.writeFileSync(path.join(dir, 'sub', 'c.rs'), 'fn main() {}\n');
  fs.writeFileSync(path.join(dir, 'dir with space', 'x.txt'), 'x\n');
  return dir;
}

test('differential: cat through tview prints exactly what cat prints, in the same order and with the same status', () => {
  const dir = project();
  for (const cmd of [
    'cat a.txt',
    'cat "my file.txt"',
    "cat 'my file.txt' a.txt",
    'cat my\\ file.txt',
    'cat a.txt b.txt | head -1',
    'cat a.txt | grep needle',
    'cat a.txt; cat b.txt',
    'cat a.txt && echo ok',
    'cat a.txt || echo never',
    'cd sub && cat c.rs',
    'cat *.txt', // the shell's sorted order, not fs.globSync's
    'cat [ab].txt b.txt',
  ]) {
    const r = route(cmd, dir);
    if (cmd === 'cat [ab].txt b.txt') {
      assert.equal(r, null, 'bracket globs are left to cat');
      continue;
    }
    const { a, b } = differ(cmd, dir);
    assert.equal(b.out, a.out, cmd);
  }
  assert.equal(route('cat "*.txt"', dir), null, 'a quoted glob names one file, it is not expanded');
});

test('differential: git rewrites keep the exit status', () => {
  const dir = tmpdir('tforge-diff-git-');
  for (const cmd of ['git status', 'git log']) differ(cmd, dir); // not a repository: both fail alike
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'f'), 'x\n');
  differ('git status', dir);
  differ('git log', dir, { GIT_CONFIG_GLOBAL: '/dev/null' }); // no commits yet
});

test('differential: an env prefix with a quoted value stays an assignment', () => {
  // stand-ins for cargo and tkit that print the variable: the rewrite is shell-level, so stdout must match
  const dir = tmpdir('tforge-diff-env-');
  const stubs = path.join(dir, 'stubs');
  fs.mkdirSync(stubs);
  for (const n of ['cargo', 'tkit']) {
    fs.writeFileSync(path.join(stubs, n), '#!/bin/sh\nprintf "%s|%s" "$FOO" "$BAR"\n');
    fs.chmodSync(path.join(stubs, n), 0o755);
  }
  const PATH = `${stubs}${path.delimiter}${process.env.PATH}`;
  for (const cmd of ['FOO="a b" cargo test', "FOO='x  y' BAR=1 cargo test", 'FOO=a\\ b cargo build', "FOO='$HOME' cargo test"]) {
    const rewritten = route(cmd, dir);
    assert.match(rewritten, /tkit /, cmd);
    const a = spawnSync('bash', ['-c', cmd], { cwd: dir, encoding: 'utf8', env: { ...BASE_ENV, PATH } });
    const b = spawnSync('bash', ['-c', rewritten], { cwd: dir, encoding: 'utf8', env: { ...BASE_ENV, PATH } });
    assert.equal(b.status, 0, `${rewritten}: ${b.stderr}`);
    assert.equal(b.stdout, a.stdout, `${cmd} -> ${rewritten}`);
  }
});

test('differential: shell expansions are never turned into literals', () => {
  for (const cmd of [
    'find "$D" -type f',
    'find $D -type f',
    'ls -R $HOME/src',
    'ls -R ~/src',
    'find ~ -name x',
    'pytest -k "$K"',
    'cargo test $(cat names)',
    'find `pwd` -name x',
    'find . -name *.js',
    'find {src,lib} -name x',
    'ls -R src/[ab]',
    'FOO="$X" cargo test',
  ])
    assert.equal(route(cmd), null, cmd);
  // quoted, the same characters are literal and the rewrite may re-quote them
  assert.match(route('find . -name "*.js"'), /find \. -name '\*\.js'$/);
  assert.match(route("find . -name '$x'"), /find \. -name '\$x'$/);
  assert.match(route('find src -name "a b"'), /find src -name 'a b'$/);
  assert.match(route('pytest tests/a\\ b.py'), /'tests\/a b\.py'$/);
  // grep keeps its arguments as typed, so they still expand
  assert.match(route('grep -n "$P" a.txt'), /grep --null -n "\$P" a\.txt$/);
});

test('differential: heredocs are never rewritten', () => {
  for (const cmd of ["cat <<'EOF'\n$x\nEOF", 'cargo test <<EOF\nx\nEOF', "find . -name x; python3 - <<'EOF'\nprint(1)\nEOF", 'cat a.txt <<< "x"'])
    assert.equal(route(cmd, project()), null, JSON.stringify(cmd));
});

test('differential: pipe stages with effects survive a build/test rewrite; display filters may go', () => {
  for (const cmd of [
    'cargo test 2>&1 | tee test.log',
    'cargo test | wc -l',
    'cargo test 2>&1 | tail -5 > last.txt',
    'cargo test | grep -c FAILED',
    'npm test | tail -f',
    'cargo test | sort',
    'find . -name x | xargs rm',
    'git log | head -3',
  ])
    assert.equal(route(cmd), null, cmd);
  // the test's own exit code replaces the pipe's (tail's): intended
  assert.match(route('cargo test 2>&1 | tail -30'), /^tkit test -l rust$/);
  assert.match(route('npm test | head -50'), /^tkit test -l ts$/);
});

test('differential: TFORGE_RAW=1 on the command runs it untouched; an exported one does not', () => {
  const hook = (command) => {
    const cfg = tmpdir('tforge-diff-cc-');
    const r = spawnSync('node', [path.join(HERE, '..', 'hooks', 'kit-router.mjs')], {
      input: JSON.stringify({ tool_name: 'Bash', session_id: `df${process.pid}${Math.random()}`, cwd: os.tmpdir(), permission_mode: 'bypassPermissions', tool_input: { command } }),
      encoding: 'utf8',
      env: { ...BASE_ENV, CLAUDE_CONFIG_DIR: cfg, TFORGE_LEAN_DEFAULT: 'off' },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  for (const cmd of ['TFORGE_RAW=1 cargo test', 'TFORGE_RAW=1 find . -name x', 'TFORGE_RAW=1 grep -rn x .', 'cargo build && TFORGE_RAW=1 cargo test'])
    assert.equal(hook(cmd), '', cmd);
  assert.match(hook('export TFORGE_RAW=1; cargo test'), /tkit test/);
  assert.match(hook('cargo test'), /tkit test/);
});

test('differential: tkit run exits like the command it wraps', { skip: NO_TMAP }, () => {
  const dir = project();
  const same = (cmd, env) => {
    const { a, b } = differ(cmd, dir, env);
    return { a, b };
  };
  for (const cmd of ['find . -name "*.txt"', 'find "dir with space" -type f', 'find sub', 'FOO="a b" find sub']) {
    const { a, b } = same(cmd);
    assert.deepEqual(content(b.out).sort(), content(a.out).sort(), cmd);
  }
  for (const cmd of ['find missing-dir', 'ls -R sub', 'ls -R missing-dir']) same(cmd);
  // grep: matches (0), none (1), a missing file (2); every matched line still shows
  const { a } = same('grep -rn needle .');
  const { b } = same('grep -rn needle .');
  for (const l of content(a.out)) assert.ok(b.out.includes(l.split(':').slice(2).join(':')), l);
  same('grep -rn nomatch-anywhere .');
  same('grep -n needle missing.txt');
  same('grep -n "$P" a.txt', { P: 'needle' });
});

test('differential: a capped log still ends with the error and the exit status', { skip: NO_TMAP }, () => {
  const dir = tmpdir('tforge-diff-cap-');
  const cmd = 'tkit run -n 50 sh -c \'for i in $(seq 3000); do echo "ok $i"; done; echo "error: boom at the end" >&2; exit 3\'';
  const r = sh(cmd, dir);
  assert.equal(r.code, 3);
  const lines = r.out.trimEnd().split('\n');
  assert.ok(lines.length < 120, `capped: ${lines.length} lines`);
  assert.match(r.out, /lines omitted/);
  assert.deepEqual(lines.slice(-2), ['error: boom at the end', '[exit 3]']);
});

test('differential: the worker-check log cap keeps a final error and a FAILED line after compiler warnings', () => {
  const long = [...Array.from({ length: 3000 }, (_, i) => `ok ${i}`), 'Error: boom at the end', '    at main (/src/app.js:3:9)'].join('\n');
  const t = tail(long, 80);
  assert.match(t, /^\[\.\.\. \d+ earlier lines dropped\]/);
  assert.match(t, /Error: boom at the end\n {4}at main \(\/src\/app\.js:3:9\)$/);
  assert.ok(tail('x'.repeat(20000) + '\nerror: last', 80, 6000).endsWith('error: last'), 'a char cap keeps the end too');
  // a warning block runs to a blank line; a test runner's failure lines right after it are not part of it
  const mixed = ['error[E0308]: mismatched types', '  --> src/a.rs:1:5', '', 'warning: unused variable `x`', '  --> src/b.rs:2:9', '  |', 'FAILED tests/test_a.py::test_one', '1 failed, 3 passed'].join('\n');
  const m = tail(mixed);
  assert.match(m, /FAILED tests\/test_a\.py::test_one\n1 failed, 3 passed/);
  assert.doesNotMatch(m, /unused variable/);
  assert.match(m, /\[1 compiler warning block\(s\) dropped\]/);
});
