import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validatePlan } from '../lib/plan.mjs';
import { runPlan } from '../lib/runner.mjs';
import { meterTranscript } from '../lib/meter.mjs';
import { tail } from '../lib/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fake-claude.mjs');
fs.chmodSync(FAKE, 0o755);

function project(plan, script = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-test-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-fake-'));
  fs.mkdirSync(path.join(root, '.forge'));
  fs.writeFileSync(path.join(root, '.forge', 'plan.json'), JSON.stringify(plan));
  fs.writeFileSync(path.join(root, 'contracts.ts'), 'export type X = number;\n');
  process.env.FAKE_SCRIPT = JSON.stringify(script);
  process.env.FAKE_STATE_DIR = stateDir;
  const calls = () =>
    fs.existsSync(path.join(stateDir, 'calls.jsonl'))
      ? fs.readFileSync(path.join(stateDir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      : [];
  const ledger = () => fs.readFileSync(path.join(root, '.forge', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const go = (opts = {}) => runPlan(root, { claudeBin: FAKE, quiet: true, ...opts });
  return { root, calls, ledger, go };
}

const base = (tasks, extra = {}) => ({ version: 1, goal: 'test goal', context: ['contracts.ts'], tasks, ...extra });

test('validatePlan rejects shared owners, cycles, unknown deps and escaping paths', () => {
  const errs = validatePlan(
    base([
      { id: 'a', spec: 's', files: ['x.ts'], deps: ['b'] },
      { id: 'b', spec: 's', files: ['x.ts', '../evil.ts'], deps: ['a'] },
      { id: 'c', spec: 's', files: ['c.ts'], deps: ['zzz'] },
    ]),
    '/tmp/p',
  ).join('\n');
  assert.match(errs, /already owned by a/);
  assert.match(errs, /inside the project/);
  assert.match(errs, /unknown dep zzz/);
  const cyc = validatePlan(base([{ id: 'a', spec: 's', files: ['a'], deps: ['b'] }, { id: 'b', spec: 's', files: ['b'], deps: ['a'] }]), '/tmp/p');
  assert.match(cyc.join(), /cycle/);
});

test('runs tasks in dependency order with lean worker flags, then skips them when unchanged', async () => {
  const p = project(
    base([
      { id: 'b', spec: 'needs a', files: ['b.ts'], deps: ['a'], reads: ['a.ts'], verify: 'test -f b.ts' },
      { id: 'a', spec: 'first', files: ['a.ts'], verify: 'test -f a.ts', model: 'haiku' },
    ]),
    { a: [{ write: { 'a.ts': 'export const a = 1;\n' } }], b: [{ write: { 'b.ts': 'export const b = 2;\n' } }] },
  );
  const r = await p.go();
  assert.equal(r.ok, true);
  const calls = p.calls();
  assert.deepEqual(calls.map((c) => c.id), ['a', 'b']);
  const args = calls[0].args;
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
  assert.equal(args.at(-2), '--tools', 'tools flag must come last: it is variadic');
  assert.ok(args.includes('--strict-mcp-config') && args.includes('--disable-slash-commands'));
  assert.equal(args[args.indexOf('--effort') + 1], 'low', 'workers default to low effort');
  const sys = fs.readFileSync(args[args.indexOf('--system-prompt-file') + 1], 'utf8');
  assert.match(sys, /export type X = number/, 'shared context lives in the cached system prompt');
  assert.match(calls[1].prompt, /export const a = 1/, 'reads are inlined');
  assert.doesNotMatch(calls[1].prompt, /export type X/, 'shared context is not repeated per task');

  await p.go();
  assert.equal(p.calls().length, 2, 'unchanged tasks are skipped');

  const plan = JSON.parse(fs.readFileSync(path.join(p.root, '.forge/plan.json'), 'utf8'));
  plan.tasks[1].spec = 'first, changed';
  fs.writeFileSync(path.join(p.root, '.forge/plan.json'), JSON.stringify(plan));
  await p.go();
  assert.deepEqual(p.calls().slice(2).map((c) => c.id), ['a', 'b'], 'changing a spec reruns it and its dependents');
});

test('retries with the failing check output, escalating the model on the last attempt', async () => {
  const p = project(base([{ id: 'calc', spec: 'add', files: ['calc.js'], verify: 'grep -q correct calc.js', retries: 1 }]), {
    calc: [{ write: { 'calc.js': 'wrong\n' } }, { write: { 'calc.js': 'correct\n' } }],
  });
  const r = await p.go();
  assert.equal(r.ok, true);
  const calls = p.calls();
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /failed its checks/);
  assert.match(calls[1].prompt, /grep -q correct calc.js/);
  assert.equal(calls[1].args[calls[1].args.indexOf('--model') + 1], 'opus', 'sonnet escalates to opus on the final attempt');
  assert.equal(calls[1].args[calls[1].args.indexOf('--effort') + 1], 'high', 'and to high effort');
  assert.deepEqual(p.ledger().map((l) => l.outcome), ['verify-fail', 'pass']);
});

test('a failed task blocks its dependents and the run fails', async () => {
  const p = project(
    base([
      { id: 'a', spec: 's', files: ['a.ts'], verify: 'false', retries: 0 },
      { id: 'b', spec: 's', files: ['b.ts'], deps: ['a'] },
      { id: 'c', spec: 's', files: ['c.ts'] },
    ]),
    { a: [{ write: { 'a.ts': 'x' } }], c: [{ write: { 'c.ts': 'x' } }] },
  );
  const r = await p.go({ concurrency: 1 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed.sort(), ['a', 'b']);
  assert.ok(!p.calls().some((c) => c.id === 'b'), 'blocked task never starts');
});

test('BLOCKED worker reply stops retries; crashes are retried', async () => {
  const p = project(
    base([
      { id: 'blk', spec: 's', files: ['blk.ts'], verify: 'test -f blk.ts' },
      { id: 'crash', spec: 's', files: ['crash.ts'], verify: 'test -f crash.ts' },
    ]),
    { blk: [{ result: 'BLOCKED: needs a file I do not own' }], crash: [{ crash: true }, { write: { 'crash.ts': 'ok' } }] },
  );
  const r = await p.go({ concurrency: 1 });
  assert.deepEqual(r.failed, ['blk']);
  assert.equal(p.calls().filter((c) => c.id === 'blk').length, 1);
  assert.equal(p.calls().filter((c) => c.id === 'crash').length, 2);
});

test('records writes outside owned files', async () => {
  const p = project(base([{ id: 'a', spec: 's', files: ['a.ts'] }]), { a: [{ write: { 'a.ts': 'x', 'other.ts': 'y' } }] });
  await p.go();
  assert.deepEqual(p.ledger()[0].strays, ['other.ts']);
});

test('parallel workers writing their own files are not reported as strays', async () => {
  const p = project(
    base([
      { id: 'slow', spec: 's', files: ['slow.ts'] },
      { id: 'fast', spec: 's', files: ['fast.ts'] },
    ]),
    { slow: [{ write: { 'slow.ts': 'x' }, sleepMs: 400 }], fast: [{ write: { 'fast.ts': 'y' } }] },
  );
  await p.go({ concurrency: 2 });
  assert.deepEqual(p.ledger().flatMap((l) => l.strays), []);
});

test('final check failure triggers an integration worker', async () => {
  const p = project(base([{ id: 'a', spec: 's', files: ['a.ts'] }], { verify: 'grep -q fixed a.ts' }), {
    a: [{ write: { 'a.ts': 'broken' } }],
    'integrate-1': [{ write: { 'a.ts': 'fixed' } }],
  });
  const r = await p.go();
  assert.equal(r.ok, true);
  const integ = p.calls().find((c) => c.id === 'integrate-1');
  assert.ok(integ, 'integration worker ran');
  assert.match(integ.prompt, /- a\.ts/);
});

test('detached run plus wait reports the summary and exit code', () => {
  const p = project(base([{ id: 'a', spec: 's', files: ['a.ts'], verify: 'test -f a.ts' }]), { a: [{ write: { 'a.ts': 'x' } }] });
  const bin = path.join(HERE, '..', 'bin', 'tforge');
  const env = { ...process.env, TFORGE_CLAUDE: FAKE };
  const start = spawnSync('node', [bin, 'run', '--detach', '-C', p.root], { cwd: p.root, env, encoding: 'utf8' });
  assert.match(start.stdout, /run started/);
  const w = spawnSync('node', [bin, 'wait', '-C', p.root], { cwd: p.root, env, encoding: 'utf8' });
  assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.match(w.stdout, /1\/1 task\(s\) passed/);
});

test('failure output drops runtime stack frames but keeps project frames', () => {
  const raw = [
    'AssertionError: expected',
    '    at TestContext.<anonymous> (/p/slug.test.mjs:5:10)',
    '    at Test.run (node:internal/test_runner/test:1402:25)',
    '    at f (/p/node_modules/vitest/dist/x.js:1:1)',
    "  actual: 'a'",
  ].join('\n');
  const out = tail(raw);
  assert.match(out, /slug\.test\.mjs:5:10/);
  assert.doesNotMatch(out, /node:internal|node_modules/);
  assert.match(out, /\[2 runtime frames\]/);
});

test('line ranges inline only the slice; ownership uses the bare path', async () => {
  const p = project(
    base([
      { id: 'a', spec: 's', files: ['big.rs:2-3'], reads: ['lib.rs:4-5'], verify: 'grep -q changed big.rs' },
      { id: 'b', spec: 's', files: ['big.rs'] },
    ]),
  );
  assert.match(String(validatePlan(JSON.parse(fs.readFileSync(path.join(p.root, '.forge/plan.json'))), p.root)), /big\.rs already owned by a/);
  const ok = project(base([{ id: 'a', spec: 's', files: ['big.rs:2-3'], reads: ['lib.rs:4-5'], verify: 'grep -q changed big.rs' }]), {
    a: [{ write: { 'big.rs': 'changed' } }],
  });
  fs.writeFileSync(path.join(ok.root, 'big.rs'), 'L1\nL2\nL3\nL4\n');
  fs.writeFileSync(path.join(ok.root, 'lib.rs'), 'x1\nx2\nx3\nx4\nx5\nx6\n');
  assert.equal((await ok.go()).ok, true);
  const prompt = ok.calls()[0].prompt;
  assert.match(prompt, /- big\.rs\n/);
  assert.match(prompt, /lines 2-3 of 4[^\n]*\nL2\nL3\n/);
  assert.match(prompt, /x4\nx5\n/);
  assert.doesNotMatch(prompt, /L1|x1|x6/);
});

test('compiler warnings are dropped when errors exist', () => {
  const raw = ['warning: unused variable: `x`', '  --> src/a.rs:3:9', '', 'error[E0308]: mismatched types', '  --> src/b.rs:9:5', '', 'warning: `crate` (lib) generated 1 warning', 'error: could not compile'].join('\n');
  const out = tail(raw);
  assert.doesNotMatch(out, /unused variable|a\.rs/);
  assert.match(out, /E0308[\s\S]*b\.rs:9:5/);
  assert.match(out, /1 compiler warning block/);
  assert.match(tail('warning: only warnings\n  --> x.rs:1:1\n'), /only warnings/, 'warnings stay when there is no error');
});

test('tmap launcher runs TMAP_BIN with the given arguments and exit code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-tmap-'));
  const fake = path.join(dir, 'fake-tmap');
  fs.writeFileSync(fake, '#!/bin/sh\necho "args: $*"\nexit 3\n', { mode: 0o755 });
  const r = spawnSync('node', [path.join(HERE, '..', 'bin', 'tmap'), 'find', 'add layer'], { encoding: 'utf8', env: { ...process.env, TMAP_BIN: fake } });
  assert.equal(r.stdout, 'args: find add layer\n');
  assert.equal(r.status, 3);
});

test('code redirect: opt-in, answers identifier greps from the index once, lets prose and repeats through', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-redir-'));
  const fake = path.join(dir, 'fake-tmap');
  fs.writeFileSync(fake, '#!/bin/sh\necho "src/a.rs:1-9  fn $2()"\n', { mode: 0o755 });
  const hook = path.join(HERE, '..', 'hooks', 'code-redirect.mjs');
  const call = (pattern, env) =>
    spawnSync('node', [hook], { input: JSON.stringify({ tool_name: 'Grep', session_id: `t${process.pid}${Date.now()}${pattern.length}`, cwd: dir, tool_input: { pattern } }), encoding: 'utf8', env: { ...process.env, TMAP_BIN: fake, ...env } }).stdout;
  assert.equal(call('orbit_speed', {}), '', 'off by default');
  const sid = { TFORGE_REDIRECT: '1' };
  const input = JSON.stringify({ tool_name: 'Grep', session_id: `same${process.pid}`, cwd: dir, tool_input: { pattern: 'orbit_speed|orbitRate' } });
  const first = spawnSync('node', [hook], { input, encoding: 'utf8', env: { ...process.env, TMAP_BIN: fake, ...sid } }).stdout;
  assert.match(JSON.parse(first).hookSpecificOutput.permissionDecisionReason, /src\/a\.rs:1-9/);
  assert.equal(spawnSync('node', [hook], { input, encoding: 'utf8', env: { ...process.env, TMAP_BIN: fake, ...sid } }).stdout, '', 'identical repeat runs');
  assert.equal(call('failed to open the window', sid), '', 'prose search is not redirected');
});

test('meter counts each API call once and weighs columns by price', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-meter-'));
  const f = path.join(dir, 's.jsonl');
  const usage = { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 10000, output_tokens: 50 };
  const line = (id) => JSON.stringify({ type: 'assistant', message: { id, model: 'm', usage } });
  fs.writeFileSync(f, [line('m1'), line('m1'), line('m2'), '{"type":"user"}'].join('\n'));
  const s = meterTranscript(f);
  assert.equal(s.calls, 2);
  assert.equal(s.peakCtx, 11100);
  assert.equal(s.weighted, 2 * (100 + 1250 + 1000 + 250));
});

test('context-watch warns once per band; handoff-load injects the handoff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-hook-'));
  const tr = path.join(dir, 't.jsonl');
  const big = { input_tokens: 5, cache_creation_input_tokens: 5000, cache_read_input_tokens: 90000, output_tokens: 1 };
  fs.writeFileSync(tr, JSON.stringify({ type: 'assistant', message: { id: 'x', usage: big } }) + '\n');
  const hook = path.join(HERE, '..', 'hooks', 'context-watch.mjs');
  const sid = 'test-' + process.pid + '-' + Date.now();
  const input = JSON.stringify({ session_id: sid, transcript_path: tr, hook_event_name: 'PostToolUse' });
  const first = spawnSync('node', [hook], { input, encoding: 'utf8' });
  const out = JSON.parse(first.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /~95k tokens/);
  assert.equal(spawnSync('node', [hook], { input, encoding: 'utf8' }).stdout, '', 'same band stays silent');

  fs.mkdirSync(path.join(dir, '.forge'));
  fs.writeFileSync(path.join(dir, '.forge', 'HANDOFF.md'), '# Handoff: thing\n## Next\n1. do it\n');
  const ss = path.join(HERE, '..', 'hooks', 'session-start.mjs');
  const env = { ...process.env, XDG_CONFIG_HOME: dir };
  const h = spawnSync('node', [ss], { input: JSON.stringify({ cwd: dir, source: 'clear' }), encoding: 'utf8', env });
  const ctx = JSON.parse(h.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /1\. do it/);
  assert.match(ctx, /tokenforge terse\)/, 'terse full is the default');
  assert.doesNotMatch(ctx, /tmap find <words>/, 'code-search hint is opt-in');
  const withMap = spawnSync('node', [ss], { input: JSON.stringify({ cwd: dir, source: 'startup' }), encoding: 'utf8', env: { ...env, TFORGE_MAP: '1' } });
  assert.match(JSON.parse(withMap.stdout).hookSpecificOutput.additionalContext, /tmap find <words>/);

  const compact = spawnSync('node', [ss], { input: JSON.stringify({ cwd: dir, source: 'compact' }), encoding: 'utf8', env });
  const cctx = JSON.parse(compact.stdout).hookSpecificOutput.additionalContext;
  assert.match(cctx, /terse/, 'terse rule returns after compaction');
  assert.doesNotMatch(cctx, /do it/, 'handoff is not re-injected after compaction');

  const bin = path.join(HERE, '..', 'bin', 'tforge');
  assert.match(spawnSync('node', [bin, 'terse', 'off'], { encoding: 'utf8', env }).stdout, /terse: off/);
  const off = spawnSync('node', [ss], { input: JSON.stringify({ cwd: '/nonexistent', source: 'startup' }), encoding: 'utf8', env });
  assert.equal(off.stdout, '', 'terse off and no handoff: no output');
  assert.match(spawnSync('node', [bin, 'terse', 'status'], { encoding: 'utf8', env: { ...env, TFORGE_TERSE: 'lite' } }).stdout, /lite \(from TFORGE_TERSE\)/);
});
