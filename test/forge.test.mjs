import './tmp.mjs';
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

// Hooks under test must never touch the developer's real Claude Code settings (session start applies the
// first-run lean default there).
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-test-cc-'));
process.env.TFORGE_LEAN_DEFAULT = 'off';
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

test('usage store: incremental, de-duplicated, worktrees grouped, subagents attributed', async () => {
  const { UsageStore, overview, projects, sessions, blocks } = await import('../lib/usage.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-usage-'));
  const pdir = path.join(root, '-repo');
  fs.mkdirSync(path.join(pdir, 'sess1', 'subagents'), { recursive: true });
  const now = new Date().toISOString();
  const call = (id, cr, cwd) => JSON.stringify({ type: 'assistant', cwd, timestamp: now, message: { id, model: 'm1', usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: cr, output_tokens: 5 } } });
  const main = path.join(pdir, 'sess1.jsonl');
  fs.writeFileSync(main, [call('a', 1000, '/repo'), call('a', 1000, '/repo'), call('b', 2000, '/repo')].join('\n') + '\n');
  fs.writeFileSync(path.join(pdir, 'sess1', 'subagents', 'agent-x.jsonl'), call('c', 500, '/repo/.claude/worktrees/agent-x') + '\n');
  const cacheFile = path.join(root, 'cache.json');
  const s = new UsageStore({ root, cacheFile });
  await s.refresh();
  const ps = projects(s);
  assert.deepEqual(ps.map((p) => [p.project, p.calls]), [['/repo', 3]], 'duplicate content blocks count once; worktree joins its repo');
  const ss = sessions(s, '/repo');
  assert.equal(ss[0].subagents, 1);
  assert.equal(ss[0].subCalls, 1);
  fs.appendFileSync(main, call('d', 3000, '/repo') + '\n' + '{"type":"assistant","partial');
  const s2 = new UsageStore({ root, cacheFile });
  await s2.refresh();
  assert.equal(projects(s2)[0].calls, 4, 'appended line read from the cached offset; a partial last line waits');
  assert.equal(overview(s2).totals.today.calls, 4);
  const h = 3.6e6;
  const b = blocks([0, 3600, 4 * 3600, 6 * 3600, 6 * 3600 + 60].map((x) => x + 1e9));
  assert.equal(b.length, 2, 'a call 5h after the window start opens a new window');
  assert.equal(b[0].end - b[0].start, 5 * h);
});

test('dashboard server: localhost Host only, GET only, aggregate JSON', async () => {
  const { createServer } = await import('../lib/ui-server.mjs');
  const fakeStore = { files: {}, models: [], progress: { scanning: false }, lastRefresh: Date.now(), refresh: async () => {}, *calls() {} };
  let port = 0;
  const server = createServer({ store: fakeStore, port: () => port });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const http = await import('node:http');
  const req = (opts) => new Promise((r) => http.request({ host: '127.0.0.1', port, ...opts }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => r({ status: res.statusCode, body: b })); }).end());
  assert.equal((await req({ path: '/api/projects', headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await req({ path: '/api/projects', method: 'POST', headers: { host: `127.0.0.1:${port}` } })).status, 405);
  const ok = await req({ path: '/api/projects', headers: { host: `localhost:${port}` } });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), []);
  assert.match((await req({ path: '/api/graph?project=%2Fetc', headers: { host: `127.0.0.1:${port}` } })).body, /unknown project/);
  server.close();
});

test('status-line shim records limits and chains the previous command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-shim-'));
  const shim = path.join(HERE, '..', 'bin', 'statusline-shim.mjs');
  const payload = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 42, resets_at: 2000000000 }, seven_day: { used_percentage: 7, resets_at: 2000500000 } } });
  const prev = Buffer.from('echo "prev:$(cat | head -c 13)"').toString('base64');
  const r = spawnSync('node', [shim, '--chain-b64', prev], { input: payload, encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: dir } });
  assert.equal(r.stdout.trim(), 'prev:{"rate_limits', 'previous status line got the same JSON on stdin');
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'tokenforge', 'limits.json'), 'utf8'));
  assert.deepEqual([rec.fiveHour.used, rec.sevenDay.resetsAt], [42, 2000500000]);
  const alone = spawnSync('node', [shim], { input: payload, encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: dir } });
  assert.match(alone.stdout, /^5h 42% \(resets .+\) · 7d 7%/);
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

test('context budget warns once per band and holds one prompt; handoff-load injects the handoff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-hook-'));
  const tr = path.join(dir, 't.jsonl');
  const call = (id, read) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 5, cache_creation_input_tokens: 5000, cache_read_input_tokens: read, output_tokens: 1 } } });
  fs.writeFileSync(tr, call('a', 25000) + '\n' + call('x', 90000) + '\n');
  const hook = path.join(HERE, '..', 'hooks', 'context-watch.mjs');
  const sid = 'test-' + process.pid + '-' + Date.now();
  const env0 = { ...process.env };
  delete env0.TFORGE_BUDGET;
  delete env0.TFORGE_WATCH;
  const quiet = spawnSync('node', [hook], { input: JSON.stringify({ session_id: sid + 'q', transcript_path: tr, hook_event_name: 'PostToolUse' }), encoding: 'utf8', env: env0 });
  const q = JSON.parse(quiet.stdout);
  assert.match(q.systemMessage, /budget 50k/, 'the user sees the warning');
  assert.equal(q.hookSpecificOutput, undefined, 'nothing enters the model context by default');
  env0.TFORGE_WATCH_INJECT = '1';
  const run = (o) => spawnSync('node', [hook], { input: JSON.stringify({ session_id: sid, transcript_path: tr, ...o }), encoding: 'utf8', env: env0 });
  const out = JSON.parse(run({ hook_event_name: 'PostToolUse' }).stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /~95k tokens, over the 50k budget/);
  assert.equal(run({ hook_event_name: 'PostToolUse' }).stdout, '', 'same band stays silent');
  const alert = JSON.parse(run({ hook_event_name: 'UserPromptSubmit', prompt: 'next thing' }).stdout);
  assert.equal(alert.decision, undefined, 'prompts are never held');
  assert.match(alert.systemMessage, /\/clear when it suits you[\s\S]*sent normally/);
  assert.equal(run({ hook_event_name: 'UserPromptSubmit', prompt: 'another thing' }).stdout, '', 'one alert per step');
  assert.equal(run({ hook_event_name: 'UserPromptSubmit', prompt: '/tokenforge:handoff' }).stdout, '', 'slash commands stay silent');

  // A fixed part above the budget moves the limit to fixed + floor.
  const tr2 = path.join(dir, 't2.jsonl');
  fs.writeFileSync(tr2, call('a', 55000) + '\n' + call('b', 62000) + '\n');
  const r2 = spawnSync('node', [hook], { input: JSON.stringify({ session_id: sid + 'b', transcript_path: tr2, hook_event_name: 'PostToolUse' }), encoding: 'utf8', env: env0 });
  assert.match(JSON.parse(r2.stdout).hookSpecificOutput.additionalContext, /~67k tokens, near the 75k budget/);

  fs.mkdirSync(path.join(dir, '.forge'));
  fs.writeFileSync(path.join(dir, '.forge', 'HANDOFF.md'), '# Handoff: thing\n## Next\n1. do it\n');
  const ss = path.join(HERE, '..', 'hooks', 'session-start.mjs');
  const env = { ...process.env, XDG_CONFIG_HOME: dir, TFORGE_UI: '0', TFORGE_BANNER: '0' };
  const h = spawnSync('node', [ss], { input: JSON.stringify({ cwd: dir, source: 'clear' }), encoding: 'utf8', env });
  const ctx = JSON.parse(h.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /1\. do it/);
  assert.match(ctx, /^Reply terse: no preamble/, 'terse full is the default');
  assert.doesNotMatch(ctx, /tmap find <words>/, 'code-search hint is opt-in');
  const withMap = spawnSync('node', [ss], { input: JSON.stringify({ cwd: dir, source: 'startup' }), encoding: 'utf8', env: { ...env, TFORGE_MAP: '1' } });
  assert.match(JSON.parse(withMap.stdout).hookSpecificOutput.additionalContext, /tmap find <words>/);

  const compact = spawnSync('node', [ss], { input: JSON.stringify({ cwd: dir, source: 'compact' }), encoding: 'utf8', env });
  const cctx = JSON.parse(compact.stdout).hookSpecificOutput.additionalContext;
  assert.match(cctx, /terse/, 'terse rule returns after compaction');
  assert.doesNotMatch(cctx, /do it/, 'handoff is not re-injected after compaction');

  const bin = path.join(HERE, '..', 'bin', 'tforge');
  assert.match(spawnSync('node', [bin, 'terse', 'off'], { encoding: 'utf8', env }).stdout, /terse: off/);
  const off = spawnSync('node', [ss], { input: JSON.stringify({ cwd: '/nonexistent', source: 'startup' }), encoding: 'utf8', env: { ...env, TFORGE_KIT_POLICY: '0' } });
  assert.equal(off.stdout, '', 'terse off, kit policy off and no handoff: no output');
  assert.match(spawnSync('node', [bin, 'terse', 'status'], { encoding: 'utf8', env: { ...env, TFORGE_TERSE: 'lite' } }).stdout, /lite \(from TFORGE_TERSE\)/);
});

test('checkpoint writes chunked snapshots and session-start reloads the newest two (TFORGE_RECALL=inject)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-ckpt-'));
  const tr = path.join(dir, 't.jsonl');
  let min = 0;
  const ts = () => new Date(Date.UTC(2026, 9, 7, 10, min++)).toISOString();
  const user = (t) => JSON.stringify({ type: 'user', timestamp: ts(), message: { role: 'user', content: t } });
  const asst = (content, ctx = 0) => JSON.stringify({ type: 'assistant', timestamp: ts(), message: { content, usage: { input_tokens: 10, cache_read_input_tokens: ctx } } });
  fs.writeFileSync(
    tr,
    [
      user('<local-command-stdout></local-command-stdout>'),
      user('add a budget'),
      asst([{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(dir, 'hooks', 'a.mjs') } }]),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
      asst([{ type: 'text', text: 'Budget added.' }], 30000),
    ].join('\n') + '\n',
  );
  const hook = path.join(HERE, '..', 'hooks', 'checkpoint.mjs');
  const sid = 'ck' + process.pid + Date.now();
  const input = JSON.stringify({ session_id: sid, transcript_path: tr, cwd: dir });
  const env = { ...process.env, TFORGE_SNAPSHOT_PROMPTS: '2', TFORGE_RECALL: 'inject' };
  const snapDir = path.join(dir, '.forge', 'snapshots');
  const snaps = () => fs.readdirSync(snapDir).sort();
  const read = (f) => fs.readFileSync(path.join(snapDir, f), 'utf8');
  spawnSync('node', [hook], { input, encoding: 'utf8', env });
  assert.equal(snaps().length, 1);
  const first = read(snaps()[0]);
  assert.match(first, /^<!-- tforge \{.*"ctx":30010.*\} -->\n/);
  assert.match(first, /- add a budget/);
  assert.match(first, /- hooks\/a\.mjs/);
  assert.match(first, /## Last reply\nBudget added\./);
  assert.doesNotMatch(first, /local-command/);
  assert.match(fs.readFileSync(path.join(dir, '.forge', '.gitignore'), 'utf8'), /^snapshots\/$/m);

  // Second request fills chunk 1 (limit 2); the third opens chunk 2; a compaction opens chunk 3.
  fs.appendFileSync(tr, [user('second step'), asst([{ type: 'text', text: 'Done twice.' }]), user('third step'), asst([{ type: 'text', text: 'Third done.' }])].join('\n') + '\n');
  spawnSync('node', [hook], { input, encoding: 'utf8', env });
  assert.equal(snaps().length, 2);
  assert.match(read(snaps()[0]), /- add a budget\n- second step/, 'incremental: chunk 1 completed in place');
  assert.match(read(snaps()[1]), /- third step/);
  fs.appendFileSync(tr, [JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: ts() }), user('after compact'), asst([{ type: 'text', text: 'Fourth.' }])].join('\n') + '\n');
  spawnSync('node', [hook], { input, encoding: 'utf8', env });
  assert.equal(snaps().length, 3);
  assert.match(snaps()[2], /-003\.md$/);

  const ss = path.join(HERE, '..', 'hooks', 'session-start.mjs');
  const env2 = { ...process.env, XDG_CONFIG_HOME: dir, TFORGE_UI: '0', TFORGE_TERSE: 'off', TFORGE_RECALL: 'inject' };
  const ctx = JSON.parse(spawnSync('node', [ss], { input: JSON.stringify({ cwd: dir, source: 'clear' }), encoding: 'utf8', env: env2 }).stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /snapshots of the previous session/);
  assert.match(ctx, /third step[^]*after compact/, 'newest two, oldest first');
  assert.doesNotMatch(ctx, /add a budget/, 'only two snapshots loaded');
  assert.doesNotMatch(ctx, /<!-- tforge/, 'metadata line stripped');
  fs.writeFileSync(path.join(dir, '.forge', 'HANDOFF.md'), 'next steps\n');
  spawnSync('git', ['init', '-q', dir]);
  assert.equal(spawnSync('git', ['-C', dir, 'status', '--porcelain', '--', '.forge'], { encoding: 'utf8' }).stdout, '', 'automatic .forge files stay out of git');
});
