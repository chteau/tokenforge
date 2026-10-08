// Tests for the tkit hooks: Bash/Read router, prompt router, MCP distill, kit policy at session start.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { detect } from '../hooks/prompt-router.mjs';
import { existingBinary } from '../lib/tmapbin.mjs';

// Hooks under test must never touch the developer's real Claude Code settings (session start applies the
// first-run lean default there).
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-test-cc-'));
process.env.TFORGE_LEAN_DEFAULT = 'off';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = (n) => path.join(HERE, '..', 'hooks', n);
// The hooks must not see the developer's own switches.
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TFORGE_|TS_RAW|TMAP_BIN)/.test(k)));
let seq = 0;
const sid = () => `hk${process.pid}x${Date.now()}x${seq++}`;

function run(hook, input, env = {}) {
  const r = spawnSync('node', [HOOK(hook)], { input: JSON.stringify(input), encoding: 'utf8', env: { ...BASE_ENV, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

const tmpdir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// A stand-in tmap: prints its args, or N lines when FAKE_LINES is set; `kit distill` answers like a model.
function fakeTmap(dir) {
  const f = path.join(dir, 'fake-tmap');
  fs.writeFileSync(
    f,
    '#!/bin/sh\n' +
      'if [ "$2" = distill ]; then cat >/dev/null; [ -n "$FAKE_DISTILL_FAIL" ] && { echo "[distill unavailable; heuristic excerpt]"; exit 0; }; printf "[distilled by haiku from 9 KB / 1 lines; exit=n/a]\\nsrc/a.rs:12 the answer\\n"; exit 0; fi\n' +
      'if [ -n "$FAKE_LINES" ]; then i=0; while [ $i -lt "$FAKE_LINES" ]; do echo "line $i"; i=$((i+1)); done; exit 0; fi\n' +
      'echo "fake-tmap $*"\n',
    { mode: 0o755 },
  );
  return f;
}

// ---------- Bash / Read router ----------
const bash = (command, env = {}, session = sid(), cwd = os.tmpdir()) => run('kit-router.mjs', { tool_name: 'Bash', session_id: session, cwd, tool_input: { command } }, env);

test('kit router: raw build/test commands are rewritten to tkit and auto-approved; mixed commands run unchanged', () => {
  const r = bash('cargo test parse_args -p core 2>&1 | tail -30');
  assert.equal(r.permissionDecision, 'allow');
  assert.equal(r.updatedInput.command, 'tkit test parse_args -l rust -p core');
  assert.match(bash('npx tsc --noEmit').updatedInput.command, /tkit check -l ts$/);
  assert.match(bash('go test -run TestX ./pkg -race').updatedInput.command, /tkit test TestX -l go -p \.\/pkg -- -race$/);
  assert.match(bash("pytest -k 'a and b' tests/t.py").updatedInput.command, /tkit test 'a and b' -l py -p tests\/t\.py$/);
  // Windows executables
  assert.match(bash('npm.cmd test').updatedInput.command, /tkit test -l ts$/);
  assert.match(bash('cargo.exe clippy').updatedInput.command, /tkit check -l rust$/);
  // read-only neighbours keep it auto-approvable
  assert.match(bash('git status --short && cargo test').updatedInput.command, /git status --short && tkit test -l rust$/);
  // anything else in the same line: never 'ask' (a prompt per rewrite, unanswerable headless); run unchanged
  assert.equal(bash('cargo check && rm -rf build'), null);
  const bypass = run('kit-router.mjs', { tool_name: 'Bash', session_id: sid(), cwd: os.tmpdir(), permission_mode: 'bypassPermissions', tool_input: { command: 'cargo check && rm -rf build' } });
  assert.equal(bypass.permissionDecision, 'allow');
  assert.match(bypass.updatedInput.command, /tkit check -l rust --fast && rm -rf build$/);
  // heredocs are never touched
  assert.equal(bash("cat >> tests/a.rs <<'EOF'\n#[test] fn t() {}\nEOF\ncargo test"), null);
});

test('kit router: cat of long project files goes through tview; reads elsewhere, pipes and flags do not', () => {
  const dir = tmpdir('tforge-view-');
  const body = Array.from({ length: 60 }, (_, i) => `    let v${i} = ${i};`).join('\n');
  const src = Array.from({ length: 4 }, (_, k) => `fn f${k}() {\n${body}\n}\n`).join('\n');
  fs.writeFileSync(path.join(dir, 'a.rs'), src);
  fs.writeFileSync(path.join(dir, 'b.rs'), src);
  const r = bash('cat a.rs b.rs; grep -n f1 a.rs', {}, sid(), dir);
  assert.equal(r.permissionDecision, 'allow');
  assert.match(r.updatedInput.command, /bin\/tview'? a\.rs b\.rs ; grep -n f1 a\.rs$/);
  assert.match(bash('cat a.rs b.rs | head -700', {}, sid(), dir).updatedInput.command, /tview'? a\.rs b\.rs \| head -700$/);
  assert.equal(bash('cat a.rs | sort', {}, sid(), dir), null, 'only filters after the cat');
  assert.equal(bash('cat -n a.rs', {}, sid(), dir), null);
  assert.equal(bash('cat /etc/hostname', {}, sid(), dir), null);
  assert.equal(bash('cat missing.rs', {}, sid(), dir), null);
  if (typeof fs.globSync === 'function')
    assert.match(bash('cat *.rs', {}, sid(), dir).updatedInput.command, /tview'? a\.rs b\.rs$/, 'globs are expanded inside the project');
  assert.equal(bash('cat *.zz', {}, sid(), dir), null, 'a glob that matches nothing runs unchanged');
  assert.equal(bash('cat a.rs; sed -i s/a/b/ b.rs', {}, sid(), dir), null, 'a write in the line keeps the normal permission flow');
});

test('kit router: ssh/scp become tkit ssh in bypass sessions, interactive ssh and registry reads are refused once', () => {
  const ssh = (command) => run('kit-router.mjs', { tool_name: 'Bash', session_id: sid(), cwd: os.tmpdir(), permission_mode: 'bypassPermissions', tool_input: { command } });
  const s = ssh('ssh web1 "uptime; df -h"');
  assert.equal(s.permissionDecision, 'allow');
  assert.match(s.updatedInput.command, /tkit ssh web1 'uptime; df -h'$/);
  assert.match(ssh('scp build.tgz web1:/tmp/').updatedInput.command, /tkit ssh put build\.tgz web1:\/tmp\/$/);
  assert.equal(bash('ssh web1 "uptime"'), null, 'without bypass, ssh keeps its normal permission prompt');
  assert.equal(ssh('scp C:/a.txt D:/b.txt'), null, 'Windows drive letters are not remote hosts');
  assert.equal(ssh('ssh web1 cat /var/log/app.log | grep ERROR'), null, 'a local pipe after ssh is kept');

  const session = sid();
  const d = bash('ssh web1', {}, session);
  assert.equal(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /tkit ssh HOST 'CMD'/);
  assert.equal(bash('ssh web1', {}, session), null, 'identical repeat goes through');

  // one inline edit script is cheaper than a chain of Edit calls: allowed
  assert.equal(bash(`python3 -c "p='a.py';s=open(p).read().replace('x','y');open(p,'w').write(s)"`), null);
  assert.equal(bash("python3 - <<'EOF'\nimport json\nd = json.load(open('a.json'))\njson.dump(d, open('a.json', 'w'))\nEOF"), null);
  assert.match(bash('cat node_modules/react/index.js').permissionDecisionReason, /tkit deps api react/);
  assert.match(bash('grep -n Serialize ~/.cargo/registry/src/index.crates.io-6f17d22bba15001f/serde-1.0.200/src/lib.rs').permissionDecisionReason, /tkit deps api serde/);
  assert.equal(bash("rg foo --glob '!node_modules/**' src"), null, 'exclusion globs are not registry reads');

  const read = run('kit-router.mjs', { tool_name: 'Read', session_id: sid(), tool_input: { file_path: '/p/node_modules/@types/node/fs.d.ts' } });
  assert.match(read.permissionDecisionReason, /tkit deps api @types\/node/);
  assert.equal(run('kit-router.mjs', { tool_name: 'Read', session_id: sid(), tool_input: { file_path: '/p/node_modules/x/a.js', offset: 10, limit: 20 } }), null);

  // whole-file Read of a big saved tool output: asked to grep/sed it instead, once
  const spill = path.join(tmpdir('tforge-spill-'), 'tool-results');
  fs.mkdirSync(spill);
  const big = path.join(spill, 'b1.txt');
  fs.writeFileSync(big, 'x'.repeat(100) + '\n'.repeat(1) + 'line\n'.repeat(3000));
  const rs = sid();
  assert.match(run('kit-router.mjs', { tool_name: 'Read', session_id: rs, tool_input: { file_path: big } }).permissionDecisionReason, /grep -n PATTERN/);
  assert.equal(run('kit-router.mjs', { tool_name: 'Read', session_id: rs, tool_input: { file_path: big } }), null);
  assert.equal(run('kit-router.mjs', { tool_name: 'Read', session_id: sid(), tool_input: { file_path: big, offset: 1, limit: 50 } }), null);
});

test('kit router: uncovered commands, escape hatches and switches pass through', () => {
  for (const c of ['ls -la', 'cargo build --release', 'npm test -- --watch', 'cargo test > out.txt', 'echo cargo test', 'git status', 'ssh -T git@github.com'])
    assert.equal(bash(c), null, c);
  assert.equal(bash('TFORGE_RAW=1 cargo test'), null);
  assert.equal(bash('TS_RAW=1 cargo test'), null);
  assert.ok(bash('export TFORGE_RAW=1; cargo test'), 'an exported escape does not switch the router off for good');
  assert.equal(bash('cargo test', { TFORGE_KIT_HOOKS: '0' }), null);
  assert.equal(bash('cargo test', { TFORGE_KIT_ROUTE: '0' }), null);
  const session = sid();
  assert.ok(bash('cargo test', {}, session));
  assert.equal(bash('cargo test', {}, session), null, 'identical repeat runs raw');
});

test('kit router: with TFORGE_REDIRECT=1 an identifier grep in Bash is answered from the index', () => {
  const dir = tmpdir('tforge-bgrep-');
  fs.mkdirSync(path.join(dir, 'src'));
  const env = { TMAP_BIN: fakeTmap(dir), TFORGE_REDIRECT: '1' };
  assert.equal(bash('grep -rn orbit_speed src', { TMAP_BIN: env.TMAP_BIN }, sid(), dir), null, 'opt-in');
  const session = sid();
  const r = bash('grep -rn orbit_speed src | head -20', env, session, dir);
  assert.equal(r.permissionDecision, 'deny');
  assert.match(r.permissionDecisionReason, /fake-tmap kit ctx orbit_speed/);
  assert.equal(bash('grep -rn orbit_speed src | head -20', env, session, dir), null, 'identical repeat runs');
  assert.match(bash('grep -rl OrbitSpeed .', env, sid(), dir).permissionDecisionReason, /kit ctx --refs OrbitSpeed/);
  for (const c of ['grep -rni orbit_speed src', 'grep -rn "failed to open" src', 'grep -n orbit_speed src/a.rs', 'grep -rn main src', 'TFORGE_RAW=1 grep -rn orbit_speed src'])
    assert.equal(bash(c, env, sid(), dir), null, c);
});

// ---------- prompt router ----------
function gitRepo() {
  const dir = tmpdir('tforge-route-');
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.js'), 'export function orbitSpeed(x) {\n  return x * 2;\n}\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'a.js'), 'export function orbitSpeed(x) {\n  return x * 3;\n}\n');
  return dir;
}

test('prompt router: mode detection', () => {
  assert.equal(detect('please review the changes on this branch').mode, 'review');
  assert.equal(detect('can you look at PR #42 before I merge').pr, '42');
  assert.equal(detect('TypeError at src/app.ts:42 when saving').mode, 'debug');
  assert.equal(detect('the login page crashes after submit').mode, 'debug');
  assert.equal(detect('le bouton est cassé depuis hier').mode, 'debug');
  assert.equal(detect('add a --json flag to the export command').mode, 'write');
  assert.equal(detect('how does the scheduler pick the next job?').mode, 'inspect');
  assert.equal(detect('où est défini le parseur de config ?').mode, 'inspect');
  assert.equal(detect('thanks, that looks great to me').mode, null);
  assert.deepEqual(detect('where is `orbitSpeed` and `foo bar` used').ticks, ['orbitSpeed', 'foo bar']);
});

test('prompt router: pre-loads bounded tkit context in a git repo, silent elsewhere', () => {
  const dir = gitRepo();
  const fake = fakeTmap(dir);
  const ask = (prompt, env = {}, cwd = dir) => run('prompt-router.mjs', { prompt, cwd, session_id: sid() }, { TMAP_BIN: fake, TFORGE_KIT_PROMPT: '1', ...env });
  assert.equal(run('prompt-router.mjs', { prompt: 'review PR #12 please', cwd: dir, session_id: sid() }, { TMAP_BIN: fake }), null, 'off by default');
  const w = ask('add a `orbitSpeed` override for tests');
  assert.equal(w.hookEventName, 'UserPromptSubmit');
  assert.match(w.additionalContext, /auto-mode: WRITE/);
  assert.match(w.additionalContext, /fake-tmap kit analog orbitSpeed/);
  assert.match(ask('where is `orbitSpeed` computed?').additionalContext, /fake-tmap kit ctx orbitSpeed/);
  const pr = ask('review PR #12 please').additionalContext;
  assert.match(pr, /tkit diff --pr 12/);
  assert.doesNotMatch(pr, /fake-tmap/, 'no network call from the hook');
  assert.match(ask('Error: boom at a.js:2 when called').additionalContext, /fake-tmap kit debug --trace -/);

  const big = ask('review my changes before I push', { FAKE_LINES: '5000', TFORGE_ROUTE_MAX_LINES: '120' }).additionalContext;
  assert.ok(big.split('\n').length <= 122, `capped: ${big.split('\n').length} lines`);
  assert.match(big, /more lines\]$/);
  assert.ok(ask('review my changes before I push', { FAKE_LINES: '5000' }).additionalContext.split('\n').length <= 302, 'default cap');

  assert.equal(ask('/compact'), null);
  assert.equal(ask('fix it'), null);
  assert.equal(ask('add a flag to the export command', {}, tmpdir('tforge-nogit-')), null, 'not a git repo');
  assert.equal(ask('add a flag to the export command', { TFORGE_KIT_PROMPT: '0' }), null);
  assert.equal(ask('add a flag to the export command', { TFORGE_KIT_HOOKS: '0' }), null);
});

test('prompt router: real tmap review pre-load', { skip: !existingBinary() && 'no tmap binary' }, () => {
  const dir = gitRepo();
  const r = run('prompt-router.mjs', { prompt: 'review my uncommitted changes', cwd: dir, session_id: sid() }, { XDG_CACHE_HOME: dir, TMAP_BIN: existingBinary(), TFORGE_KIT_PROMPT: '1' });
  assert.match(r.additionalContext, /IS the review context/);
  assert.match(r.additionalContext, /x \* 3/);
});

// ---------- MCP distill ----------
test('mcp distill: large MCP results become distilled facts, small ones and #raw pass through', () => {
  const dir = tmpdir('tforge-distill-');
  const env = { TMAP_BIN: fakeTmap(dir) };
  const big = 'x'.repeat(9000);
  const call = (o, e = env) => run('mcp-distill.mjs', { session_id: sid(), tool_name: 'mcp__ctx__search', tool_input: { queries: ['where is foo'] }, ...o }, e);
  const r = call({ tool_response: [{ type: 'text', text: big }] });
  const text = r.updatedMCPToolOutput.content[0].text;
  assert.match(text, /9000 bytes of search output/);
  assert.match(text, /src\/a\.rs:12 the answer$/);
  assert.doesNotMatch(text, /distilled by/);
  assert.ok(call({ tool_response: { content: [{ type: 'text', text: big }] } }), 'object form');
  assert.equal(call({ tool_response: [{ type: 'text', text: 'small' }] }), null);
  assert.equal(call({ tool_input: { query: '#raw foo' }, tool_response: big }), null);
  assert.equal(call({ tool_name: 'Bash', tool_response: big }), null, 'only MCP tools');
  assert.equal(call({ tool_response: big }, { ...env, FAKE_DISTILL_FAIL: '1' }), null, 'heuristic fallback keeps the original');
  assert.equal(call({ tool_response: big }, { ...env, TFORGE_KIT_DISTILL: '0' }), null);
  assert.equal(call({ tool_response: big }, { ...env, TFORGE_DISTILL_MCP_BYTES: '20000' }), null);
});

test('mcp distill: real tmap without a working model leaves the result alone', { skip: !existingBinary() && 'no tmap binary' }, () => {
  const dir = tmpdir('tforge-distill-real-');
  fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const r = run(
    'mcp-distill.mjs',
    { session_id: sid(), tool_name: 'mcp__x__y', tool_input: {}, tool_response: 'error line\n'.repeat(1000) },
    { PATH: `${dir}${path.delimiter}${process.env.PATH}`, TFORGE_DISTILL_TIMEOUT: '5', XDG_CACHE_HOME: dir, TMAP_BIN: existingBinary() },
  );
  assert.equal(r, null);
});

// ---------- session start ----------
test('session start: short efficiency policy, also for subagents, with switches', () => {
  const dir = tmpdir('tforge-ss-');
  const env = { XDG_CONFIG_HOME: dir, TFORGE_UI: '0' };
  const ss = (o, e = {}) => run('session-start.mjs', { cwd: dir, source: 'startup', ...o }, { ...env, ...e });
  const ctx = ss({}).additionalContext;
  const policy = ctx.slice(ctx.indexOf('tokenforge: tool results'));
  assert.match(policy, /tread NAME/);
  assert.match(policy, /tkit test \[FILTER\]/);
  assert.ok(policy.length < 960, `policy is ${policy.length} chars`);
  assert.match(policy, /every stated requirement, nothing extra/);
  assert.doesNotMatch(ss({}, { TFORGE_LAZY: '0' }).additionalContext, /nothing extra/);
  assert.ok(ctx.length < 1260, `whole session-start context is ${ctx.length} chars`);
  assert.doesNotMatch(ss({}, { TFORGE_KIT_POLICY: '0' }).additionalContext, /tool results are re-read/);
  assert.doesNotMatch(ss({}, { TFORGE_KIT_HOOKS: '0' }).additionalContext, /tool results are re-read/);
  assert.match(ss({}, { TFORGE_TERSE: '0' }).additionalContext, /^tokenforge: tool results/, 'terse off keeps the policy');
  const sub = ss({ hook_event_name: 'SubagentStart' });
  assert.equal(sub.hookEventName, 'SubagentStart');
  assert.match(sub.additionalContext, /^tokenforge: tool results/);
  assert.doesNotMatch(sub.additionalContext, /terse/);
});

test('tforge lean: adds its deny rules to user settings and removes only those', () => {
  const dir = tmpdir('tforge-lean-');
  const env = { CLAUDE_CONFIG_DIR: path.join(dir, 'cfg'), XDG_CONFIG_HOME: path.join(dir, 'xdg') };
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR);
  const file = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ permissions: { deny: ['WebSearch', 'Monitor'] }, model: 'opus' }));
  const tf = (...a) => spawnSync('node', [path.join(HERE, '..', 'bin', 'tforge'), 'lean', ...a], { encoding: 'utf8', env: { ...BASE_ENV, ...env } });
  assert.match(tf('on').stdout, /lean: on; denied Workflow/);
  const on = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(on.permissions.deny.includes('Workflow') && on.permissions.deny.includes('CronCreate'));
  assert.equal(on.permissions.deny.filter((t) => t === 'Monitor').length, 1, 'no duplicates');
  assert.match(tf('status').stdout, /lean: on/);
  tf('off');
  const off = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(off.permissions.deny, ['WebSearch', 'Monitor'], "the user's own rules stay");
  assert.equal(off.model, 'opus');
});

test('dashboard insights: session health spots missing tokenforge and dead plugin hooks; cost ranks re-read results', async () => {
  const { sessionHealth, sessionCost } = await import('../lib/insights.mjs');
  const dir = tmpdir('tforge-ins-');
  const lines = (xs) => xs.map((x) => JSON.stringify(x)).join('\n') + '\n';
  const asst = (rid, tools = []) => ({ type: 'assistant', requestId: rid, message: { id: rid, content: tools.map(([id, command]) => ({ type: 'tool_use', id, name: 'Bash', input: { command } })) } });
  const res = (id, n) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(n) }] } });
  const without = path.join(dir, 'a.jsonl');
  fs.writeFileSync(without, lines([
    { type: 'attachment', cwd: '/p', version: '2.1.292', attachment: { type: 'hook_non_blocking_error', stderr: 'Failed to run: Plugin directory does not exist: /x/cache/caveman/caveman/3.1.0 (caveman@caveman — run /plugin to reinstall)' } },
    asst('r1', [['t1', 'cat a b c']]), res('t1', 8000), asst('r2', [['t2', 'sed -n 1,5p a']]), res('t2', 400), asst('r3'), asst('r4'),
  ]));
  const h = sessionHealth(without);
  assert.equal(h.tokenforge, null);
  assert.deepEqual(h.deadPlugins, ['caveman']);
  const withTf = path.join(dir, 'b.jsonl');
  fs.writeFileSync(withTf, lines([{ type: 'system', subtype: 'stop_hook_summary', hookInfos: [{ command: 'node "/h/.claude/plugins/cache/tokenforge/tokenforge/0.7.0/hooks/checkpoint.mjs"' }] }]));
  assert.equal(sessionHealth(withTf).tokenforge, '0.7.0');
  const c = sessionCost(without);
  assert.equal(c.requests, 4);
  assert.equal(c.top[0].what, 'cat a b c');
  assert.equal(c.top[0].rereads, 3);
  assert.equal(c.top[0].estTokens, 6000);
});

test('tview: language-agnostic folding (Luau) and long-line cutting', async () => {
  const { view } = await import('../lib/view.mjs');
  const dir = tmpdir('tforge-tv-');
  const body = Array.from({ length: 20 }, (_, i) => `\tlocal v${i} = ${i}`).join('\n');
  const luau = path.join(dir, 'Inv.luau');
  fs.writeFileSync(luau, `local Inv = {}\n\nfunction Inv.new(owner: Player)\n${body}\n\treturn {}\nend\n\nreturn Inv\n`.repeat(60));
  const out = view([luau]);
  assert.match(out, /^function Inv\.new\(owner: Player\)\n\t… 21 lines folded: sed -n '4,24p'/m);
  assert.match(out, /^end$/m);
  const gen = path.join(dir, 'gen.json');
  fs.writeFileSync(gen, '[' + Array.from({ length: 3000 }, (_, i) => i).join(',') + ']\n');
  const g = view([gen]);
  assert.ok(g.length < 600, `cut output is ${g.length} chars`);
  assert.match(g, /\[\+\d+ chars: sed -n '1p'/);
  const small = path.join(dir, 's.luau');
  fs.writeFileSync(small, 'return 1\n');
  assert.equal(view([small]), 'return 1\n', 'small reads are byte-identical to cat');
});

test('session start: the lean default is applied once, never over an explicit choice, and only tells the user', () => {
  const dir = tmpdir('tforge-ld-');
  const env = { CLAUDE_CONFIG_DIR: path.join(dir, 'cc'), XDG_CONFIG_HOME: path.join(dir, 'xdg'), TFORGE_UI: '0', TFORGE_LEAN_DEFAULT: '' };
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR);
  const start = () => JSON.parse(spawnSync('node', [HOOK('session-start.mjs')], { input: JSON.stringify({ source: 'startup', cwd: dir }), encoding: 'utf8', env: { ...BASE_ENV, ...env } }).stdout);
  const first = start();
  assert.match(first.systemMessage, /turned on lean tools \("balanced"\)/);
  assert.doesNotMatch(first.hookSpecificOutput.additionalContext, /lean tools/, 'the notice is not in Claude\'s context');
  const s = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
  assert.ok(s.permissions.deny.includes('Workflow'));
  assert.equal(s.skillOverrides['deep-research'], 'user-invocable-only', 'hidden from Claude, still typeable');
  assert.equal(s.skillOverrides['code-review'], 'user-invocable-only');
  assert.ok(!s.permissions.deny.includes('Skill') && !s.permissions.deny.includes('Task'), 'skills and subagents stay');
  assert.equal(start().systemMessage, undefined, 'only once');
});

test('memory: indexes sessions from transcripts, recalls by keyword, and hints at session start', async () => {
  const cc = process.env.CLAUDE_CONFIG_DIR;
  const proj = tmpdir('tforge-mem-proj-');
  const { projectKey, recall, formatRecall, memoryHint, sessionDetail } = await import('../lib/memory.mjs');
  const dir = path.join(cc, 'projects', projectKey(proj));
  fs.mkdirSync(dir, { recursive: true });
  const L = (xs) => xs.map((x) => JSON.stringify(x)).join('\n') + '\n';
  const u = (t, ts) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: t } });
  const a = (tools, text = '') => ({ type: 'assistant', message: { content: [...(text ? [{ type: 'text', text }] : []), ...tools.map(([name, input], i) => ({ type: 'tool_use', id: `t${i}${Math.random()}`, name, input }))] } });
  fs.writeFileSync(path.join(dir, 's1.jsonl'), L([
    u('add a budget subcommand with monthly limits', '2026-10-01T10:00:00Z'),
    a([['Write', { file_path: path.join(proj, 'src/commands/budget.rs') }], ['Bash', { command: "cat > src/store/budgets.rs <<'EOF'\nif x > 15: y\nEOF\ngit commit -m \"budget: monthly limits\"" }]], 'Added the budget command.'),
  ]));
  fs.writeFileSync(path.join(dir, 's2.jsonl'), L([
    u('fix the stale cache totals after editing an entry', '2026-10-02T10:00:00Z'),
    a([['Edit', { file_path: path.join(proj, 'src/cache.rs') }], ['Bash', { command: 'cd /elsewhere && sed -i s/a/b/ other.rs' }]], 'Fingerprint now hashes the content.'),
  ]));
  const r = recall(proj, 'budget limits');
  assert.equal(r.total, 2);
  assert.equal(r.sessions[0].id, 's1');
  assert.deepEqual(r.sessions[0].edited, ['src/commands/budget.rs', 'src/store/budgets.rs'], 'heredoc body is not a write target');
  assert.deepEqual(r.sessions[0].commits, ['budget: monthly limits']);
  assert.equal(recall(proj, 'stale cache').sessions[0].id, 's2');
  assert.ok(!recall(proj, 'cache').sessions[0].edited.includes('other.rs'), 'files after cd elsewhere are not this project');
  assert.match(formatRecall(r), /edited: src\/commands\/budget\.rs/);
  assert.match(formatRecall(recall(proj, 'kubernetes')), /nothing in 2 earlier sessions matches/);
  assert.match(sessionDetail(proj, 's2'), /1\. fix the stale cache totals/);
  assert.match(memoryHint(proj, 's2'), /^tokenforge memory: 1 earlier session in this project \(latest 2026-10-01: "add a budget subcommand/);
  assert.equal(memoryHint(tmpdir('tforge-mem-empty-'), 'x'), null);
});

test('tread: definitions by name, ranges and regex matches in one call', async () => {
  const { read } = await import('../lib/read.mjs');
  const dir = tmpdir('tforge-tread-');
  fs.writeFileSync(path.join(dir, 'inv.luau'), 'local M = {}\n\nfunction M.add(a, b)\n\tlocal s = a + b\n\treturn s\nend\n\nfunction M.sub(a, b)\n\treturn a - b\nend\n\nreturn M\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  const out = read(['M.add', 'notes.txt:10-12', 'inv.luau:/a - b/', 'nope.rs:1-2', 'Missing'], dir);
  assert.match(out, /==> inv\.luau:3-10 <==\nfunction M\.add\(a, b\)/, 'symbol found without an index (fallback); adjacent hits merge');
  assert.match(out, /==> notes\.txt:10-12 <==\nline 10\nline 11\nline 12\n/);
  assert.match(out, /\nfunction M\.sub\(a, b\)\n\treturn a - b\nend\n/, 'regex match prints its enclosing definition');
  assert.match(out, /Missing: no definition found/);
  assert.match(out, /nope\.rs:1-2: not a file/);
});

test('answer cache: a repeated question is answered from memory with no model call; tasks and rephrasings are not blocked', async () => {
  const cc = process.env.CLAUDE_CONFIG_DIR;
  const proj = tmpdir('tforge-ans-proj-');
  const { projectKey, buildIndex } = await import('../lib/memory.mjs');
  const dir = path.join(cc, 'projects', projectKey(proj));
  fs.mkdirSync(dir, { recursive: true });
  const L = (xs) => xs.map((x) => JSON.stringify(x)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'old.jsonl'), L([
    { type: 'user', timestamp: '2026-10-01T09:00:00Z', message: { role: 'user', content: 'What is the password of the local dev admin account?' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'It is `devpass-123` (seed/users.ts).' }] } },
    { type: 'user', timestamp: '2026-10-01T09:05:00Z', message: { role: 'user', content: 'Rename the admin account to root' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: path.join(proj, 'seed/users.ts') } }, { type: 'text', text: 'Renamed.' }] } },
  ]));
  buildIndex(proj);
  const ask = (prompt, session = sid()) => run('answer-cache.mjs', { prompt, cwd: proj, session_id: session });
  const askRaw = (prompt, session) => {
    const r = spawnSync('node', [HOOK('answer-cache.mjs')], { input: JSON.stringify({ prompt, cwd: proj, session_id: session }), encoding: 'utf8', env: BASE_ENV });
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  const s = sid();
  const first = askRaw('what is the password of the local dev admin account', s);
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /devpass-123/);
  assert.match(first.reason, /Send the same message again/);
  assert.equal(askRaw('what is the password of the local dev admin account', s), null, 're-sent: goes to Claude');
  assert.equal(askRaw('Rename the admin account to root', sid()), null, 'a turn that edited files is never replayed');
  const sim = ask('I forgot the password for the local admin dev account, what was it again?');
  assert.match(sim.additionalContext, /similar question was answered.*devpass-123/);
  assert.equal(ask('How do I deploy this to production?'), null);
  assert.equal(run('answer-cache.mjs', { prompt: 'what is the password of the local dev admin account', cwd: proj, session_id: sid() }, { TFORGE_ANSWER_CACHE: '0' }), null);
});
