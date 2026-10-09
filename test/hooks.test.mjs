// Tests for the tkit hooks: Bash/Read router, prompt router, MCP distill, kit policy at session start.
import './tmp.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { detect } from '../hooks/prompt-router.mjs';
import { existingBinary } from '../lib/tmapbin.mjs';
import { rewrite, readReason, denyReason, routeCommand, readOnly, pollingWait } from '../hooks/kit-router.mjs';

// Hooks under test must never touch the developer's real Claude Code settings (session start applies the
// first-run lean default there).
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-test-cc-'));
process.env.TFORGE_LEAN_DEFAULT = 'off';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = (n) => path.join(HERE, '..', 'hooks', n);
// The hooks must not see the developer's own switches.
const BASE_ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TFORGE_|TS_RAW|TMAP_BIN)/.test(k))), TFORGE_GC: '0' };
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
  assert.match(r.updatedInput.command, /bin\/tview'? a\.rs b\.rs ; tkit run --group -n 200 grep --null -n f1 a\.rs$/);
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
  assert.match(bash('grep -n Serialize ~/.cargo/registry/src/index.crates.io-6f17d22bba15001f/serde-1.0.200/src/lib.rs').updatedInput.command, /^tkit run --group -n 200 grep --null -n Serialize /, 'focused registry reads go through');
  assert.equal(bash("sed -n '1,40p' src/a.rs; echo ---; grep -n 'pub enum Value' -A 60 ~/.cargo/registry/src/x/duckdb-1.4.5/src/types/value.rs | head -60"), null, 'a batch with a focused registry slice is not refused');
  assert.match(bash('cat ~/.cargo/registry/src/index.crates.io-6f17d22bba15001f/serde-1.0.200/src/lib.rs').permissionDecisionReason, /tkit deps api serde/);
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
  for (const c of ['ls -la', 'cargo run', 'npm test -- --watch', 'cargo test > out.txt', 'echo cargo test', 'ssh -T git@github.com'])
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
  assert.notEqual(bash('grep -rn orbit_speed src', { TMAP_BIN: env.TMAP_BIN }, sid(), dir)?.permissionDecision, 'deny', 'opt-in');
  const session = sid();
  const r = bash('grep -rn orbit_speed src | head -20', env, session, dir);
  assert.equal(r.permissionDecision, 'deny');
  assert.match(r.permissionDecisionReason, /fake-tmap kit ctx orbit_speed/);
  assert.equal(bash('grep -rn orbit_speed src | head -20', env, session, dir), null, 'identical repeat runs');
  assert.match(bash('grep -rl OrbitSpeed .', env, sid(), dir).permissionDecisionReason, /kit ctx --refs OrbitSpeed/);
  for (const c of ['grep -rni orbit_speed src', 'grep -rn "failed to open" src', 'grep -n orbit_speed src/a.rs', 'grep -rn main src', 'TFORGE_RAW=1 grep -rn orbit_speed src'])
    assert.notEqual(bash(c, env, sid(), dir)?.permissionDecision, 'deny', c);
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
  assert.ok(policy.length < 1575, `policy is ${policy.length} chars`);
  assert.match(policy, /every stated requirement, nothing extra/);
  assert.doesNotMatch(ss({}, { TFORGE_LAZY: '0' }).additionalContext, /nothing extra/);
  assert.match(ctx, /^Planning: thinking is output.*Look before you plan/m);
  assert.match(ss({}, { TFORGE_PLAN: 'brief' }).additionalContext, /^Planning: think briefly/m);
  assert.doesNotMatch(ss({}, { TFORGE_PLAN: '0' }).additionalContext, /^Planning:/m);
  assert.ok(ctx.length < 1905, `whole session-start context is ${ctx.length} chars`);
  assert.doesNotMatch(ss({}, { TFORGE_KIT_POLICY: '0' }).additionalContext, /tool results are re-read/);
  assert.doesNotMatch(ss({}, { TFORGE_KIT_HOOKS: '0' }).additionalContext, /tool results are re-read/);
  assert.match(ss({}, { TFORGE_TERSE: '0' }).additionalContext, /^tokenforge: tool results/, 'terse off keeps the policy');
  const sub = ss({ hook_event_name: 'SubagentStart' });
  assert.equal(sub.hookEventName, 'SubagentStart');
  assert.match(sub.additionalContext, /^tokenforge: tool results/);
  assert.doesNotMatch(sub.additionalContext, /terse/);
  assert.doesNotMatch(sub.additionalContext, /^Planning:/m, 'the planning default is measured on main sessions only');
  assert.match(ss({ hook_event_name: 'SubagentStart' }, { TFORGE_PLAN: 'look' }).additionalContext, /^Planning: thinking is output/m);
});

test('instruction files: a subagent gets those Claude Code leaves out; a tool call, the nested ones it reached, once', () => {
  const dir = tmpdir('tforge-instr-');
  const env = { CLAUDE_CONFIG_DIR: path.join(dir, 'cfg'), XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_CONFIG_HOME: dir, TFORGE_UI: '0' };
  fs.mkdirSync(path.join(dir, 'pkg'));
  for (const [f, text] of [['CLAUDE.md', '# Top\n'], ['AGENTS.md', 'Agents rule.\n'], ['pkg/AGENTS.md', 'Pkg rule.\n']]) fs.writeFileSync(path.join(dir, f), text);
  const session = sid();
  const start = (agent_type) => run('session-start.mjs', { hook_event_name: 'SubagentStart', session_id: session, agent_id: 'a1', agent_type, cwd: dir }, env).additionalContext;
  assert.match(start('general-purpose'), /\n\ntokenforge: project instruction files[^]*AGENTS\.md:\n\nAgents rule\.$/);
  assert.doesNotMatch(start('Explore'), /Agents rule/);
  const grep = () => run('context-watch.mjs', { hook_event_name: 'PostToolUse', session_id: session, agent_id: 'a1', cwd: dir, tool_name: 'Grep', tool_input: { pattern: 'x', path: 'pkg' } }, env);
  assert.match(grep().additionalContext, /^tokenforge: instruction files of the directories[^]*Pkg rule\.$/);
  assert.equal(grep(), null);
});

test('pollingWait: loops that sleep and only look; nothing that builds, writes or runs in the background', () => {
  for (const c of [
    'until grep -q "png" /tmp/t/x.output; do sleep 5; done; cat /tmp/t/x.output',
    'F=/tmp/x.log; until grep -q "^exit" $F 2>/dev/null; do sleep 10; done; cat $F',
    'until [ -f /tmp/held ]; do sleep 2; done; echo locked',
    "for i in $(seq 1 57); do grep -q '^exit' $L 2>/dev/null && break; sleep 10; done; grep -E 'error|warn' $L",
    'for i in $(seq 1 55); do pgrep -x cargo > /dev/null || break; sleep 10; done; tail -5 log',
    "timeout 590 sh -c 'while ! test -s out.txt; do sleep 20; done'; cat out.txt",
    'while true; do if gh run view 12 --json status | grep -q completed; then break; fi; sleep 30; done',
  ]) assert.ok(pollingWait(c), c);
  for (const c of [
    'sleep 300; tail -5 log',
    'until cargo build; do sleep 5; done',
    'until [ -f x ]; do sleep 1; done; rm x',
    'until grep -q ok log; do sleep 5; done > out.txt',
    'while true; do sleep 5; done &',
    'until (grep -q ok log); do sleep 1; done',
    'for f in $(ls); do sleep 1; done',
    'ssh host "for i in \\$(seq 1 9); do sleep 1; done"',
  ]) assert.ok(!pollingWait(c), c);
});

test('kit router: a long polling wait gets 4 minutes where the prompt cache lives 5', () => {
  const dir = tmpdir('tforge-wait-');
  const transcript = path.join(dir, 'main.jsonl');
  const session = sid();
  const wait = 'until [ -s out.txt ]; do sleep 20; done; cat out.txt';
  const call = (extra = {}, ti = {}) =>
    run('kit-router.mjs', { tool_name: 'Bash', session_id: session, cwd: dir, transcript_path: transcript, ...extra, tool_input: { command: wait, timeout: 600000, ...ti } });
  const ttl = (file, t) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `{"usage":{"cache_creation":{"ephemeral_5m_input_tokens":${t === '5m' ? 900 : 0},"ephemeral_1h_input_tokens":${t === '1h' ? 900 : 0}}}}\n`);
  };
  const first = call({ agent_id: 'a1' }); // a subagent: the 5-minute cache unless its transcript says otherwise
  assert.deepEqual(first.updatedInput, { command: wait, timeout: 240000 });
  assert.equal(first.permissionDecision, undefined, 'permissions are checked as usual');
  assert.match(first.additionalContext, /cut at 4 min/);
  assert.equal(call({ agent_id: 'a1' }).additionalContext, undefined, 'said once');
  ttl(path.join(dir, session, 'subagents', 'agent-a2.jsonl'), '1h');
  assert.equal(call({ agent_id: 'a2' }), null);
  assert.equal(call(), null, 'a main session only when its transcript shows the 5-minute cache');
  ttl(transcript, '5m');
  assert.equal(call().updatedInput.timeout, 240000);
  for (const ti of [{ timeout: 240000 }, { run_in_background: true }, { command: 'sleep 300; cat out.txt' }]) {
    assert.equal(call({ agent_id: 'a1' }, ti), null, JSON.stringify(ti));
  }
});

test('tforge lean: each level sets when 1M-context sessions compact, never over your own value; old installs get it once', () => {
  const dir = tmpdir('tforge-win-');
  const env = { CLAUDE_CONFIG_DIR: path.join(dir, 'cc'), XDG_CONFIG_HOME: path.join(dir, 'xdg'), TFORGE_UI: '0', TFORGE_BANNER: '0' };
  const file = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const drop = (f, key) => {
    const o = json(f);
    delete o[key];
    fs.writeFileSync(f, JSON.stringify(o));
  };
  const tf = (...a) => spawnSync('node', [path.join(HERE, '..', 'bin', 'tforge'), 'lean', ...a], { encoding: 'utf8', env: { ...BASE_ENV, ...env } });
  const start = () => JSON.parse(spawnSync('node', [HOOK('session-start.mjs')], { input: JSON.stringify({ source: 'startup', cwd: dir }), encoding: 'utf8', env: { ...BASE_ENV, ...env } }).stdout);
  for (const [level, w] of [['on', 400000], ['max', 300000], ['ultra', 200000], ['balanced', 400000], ['off', undefined]]) {
    tf(level);
    assert.equal(json(file).autoCompactWindow, w, level);
  }
  fs.writeFileSync(file, JSON.stringify({ autoCompactWindow: 500000 }));
  tf('max');
  tf('off');
  assert.equal(json(file).autoCompactWindow, 500000, 'your own value stays');
  // an install from before the window: the next session start sets it for the active level, once, and says so
  fs.writeFileSync(file, '{}');
  tf('on');
  drop(file, 'autoCompactWindow');
  drop(path.join(env.XDG_CONFIG_HOME, 'tokenforge', 'config.json'), 'leanWindowAdded');
  assert.match(start().systemMessage, /compact at 400k tokens/);
  assert.equal(json(file).autoCompactWindow, 400000);
  assert.equal(start().systemMessage, undefined, 'once');
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
  const env = { CLAUDE_CONFIG_DIR: path.join(dir, 'cc'), XDG_CONFIG_HOME: path.join(dir, 'xdg'), TFORGE_UI: '0', TFORGE_LEAN_DEFAULT: '', TFORGE_BANNER: '0' };
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

test('session start: no dashboard auto-start in headless sessions (claude -p, SDK, CI)', () => {
  const dir = tmpdir('tforge-ui-');
  for (const e of [{ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, { CLAUDE_CODE_SESSION_ATTENDED: '0' }, { CI: 'true' }]) {
    const r = spawnSync('node', [HOOK('session-start.mjs')], {
      input: JSON.stringify({ cwd: dir, source: 'startup' }), encoding: 'utf8',
      env: { ...BASE_ENV, HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'cc'), TFORGE_LEAN_DEFAULT: 'off', ...e },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /dashboard starting/, JSON.stringify(e));
  }
  assert.ok(!fs.existsSync(path.join(dir, 'tokenforge', 'ui.json')) && !fs.existsSync(path.join(dir, '.cache', 'tokenforge', 'ui.json')));
});

test('no URL.pathname used as a file path (breaks on Windows: /C:/...)', () => {
  const root = path.join(HERE, '..');
  for (const dir of ['lib', 'hooks', 'bin']) {
    for (const f of fs.readdirSync(path.join(root, dir))) {
      const p = path.join(root, dir, f);
      if (!fs.statSync(p).isFile()) continue;
      assert.doesNotMatch(fs.readFileSync(p, 'utf8'), /import\.meta\.url\)\.pathname/, `${dir}/${f}`);
    }
  }
});

test('kit router: our own read-only tools are approved without a prompt; writes, network and mixes are not', () => {
  const allow = (command) => bash(command)?.permissionDecision;
  for (const c of ['tread Ledger.add src/cli.rs:40-80', 'tkit ctx Ledger --refs | head -40', 'tforge recall budget alerts',
    'cd src && tread parse; grep -n foo a.rs', 'tview src/big.rs', 'tkit test store', 'tkit jx get a.json .x', 'tforge lean', 'grep -n foo a.rs'])
    assert.equal(allow(c), 'allow', c);
  for (const c of ['tkit edit < edits.txt', 'tkit ssh web1 uptime', 'tkit http https://x', 'tforge lean max', 'tkit jx set a.json .x 1',
    'tread x > out.txt', 'tread x; rm -rf build', 'grep -n foo a.rs > out.txt', 'tread $(cat list)', 'FOO=1 tread x'])
    assert.notEqual(allow(c), 'allow', c);
  assert.notEqual(run('kit-router.mjs', { tool_name: 'Bash', session_id: sid(), cwd: os.tmpdir(), tool_input: { command: 'tread x' } }, { TFORGE_AUTO_ALLOW: '0' })?.permissionDecision, 'allow');
});

test('session start: "TokenForge: active" banner with a walkthrough the first 3 times; checkpoint notice after /clear', () => {
  const dir = tmpdir('tforge-banner-');
  const env = { ...BASE_ENV, HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'cc'),
    TFORGE_UI: '0', TFORGE_LEAN_DEFAULT: 'off', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ATTENDED: '1', CI: '' };
  const msg = (source) => {
    const r = spawnSync('node', [HOOK('session-start.mjs')], { input: JSON.stringify({ cwd: dir, source }), encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout || '{}').systemMessage || '';
  };
  for (let i = 0; i < 3; i++) assert.match(msg('startup'), /^TokenForge: active · lean off · replies full[\s\S]*handoff/);
  const fourth = msg('startup');
  assert.match(fourth, /^TokenForge: active/);
  assert.doesNotMatch(fourth, /handoff/, 'walkthrough only for the first sessions');
  assert.match(msg('clear'), /no checkpoint in this folder yet/);
  fs.mkdirSync(path.join(dir, '.forge', 'snapshots'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'snapshots', '20261008-1200-abc-001.md'), 'x');
  assert.match(msg('clear'), /^TokenForge: checkpoint saved \(just now/);
  fs.writeFileSync(path.join(dir, '.forge', 'HANDOFF.md'), '# handoff');
  assert.match(msg('clear'), /checkpoint saved[\s\S]*Handoff reloaded/);
  assert.equal(spawnSync('node', [HOOK('session-start.mjs')], { input: JSON.stringify({ cwd: dir, source: 'startup' }), encoding: 'utf8', env: { ...env, TFORGE_BANNER: '0' } }).stdout.includes('TokenForge: active'), false);
});

test('session start after /clear: compact checkpoint (bounded) is reloaded when there is no handoff', async () => {
  const { render } = await import('../hooks/checkpoint.mjs');
  const dir = tmpdir('tforge-clear-');
  const snapDir = path.join(dir, '.forge', 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });
  const c = { n: 1, start: '2026-10-08T10:00:00Z', end: '2026-10-08T10:30:00Z', ctx: 1, reply: 'Done: budgets now alert at 80%. '.repeat(40),
    prompts: ['add monthly budgets', 'make alerts fire at 80% ' + 'x'.repeat(500), 'also show them in the report'],
    files: Array.from({ length: 30 }, (_, i) => path.join(dir, `src/f${i}.rs`)) };
  fs.writeFileSync(path.join(snapDir, '20261008-1000-abcdef12-001.md'), render(c, 'abcdef12-session', dir));
  const env = { ...BASE_ENV, HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, TFORGE_UI: '0', TFORGE_LEAN_DEFAULT: 'off', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ATTENDED: '1', CI: '' };
  const go = (e = {}) => JSON.parse(spawnSync('node', [HOOK('session-start.mjs')], { input: JSON.stringify({ cwd: dir, source: 'clear' }), encoding: 'utf8', env: { ...env, ...e } }).stdout || '{}');
  const out = go();
  const ctx = out.hookSpecificOutput.additionalContext;
  const cp = ctx.slice(ctx.indexOf('tokenforge checkpoint'));
  assert.match(cp, /also show them in the report/);
  assert.doesNotMatch(cp, /add monthly budgets/, 'only the last two requests');
  assert.match(cp, /src\/f9\.rs/);
  assert.doesNotMatch(cp, /src\/f10\.rs/, 'at most 10 files');
  assert.ok(cp.length <= 1200, `checkpoint is ${cp.length} chars`);
  assert.match(out.systemMessage, /checkpoint saved[\s\S]*Reloaded: Claude continues/);
  assert.doesNotMatch(go({ TFORGE_CLEAR_RELOAD: '0' }).hookSpecificOutput?.additionalContext || '', /tokenforge checkpoint/);
  fs.writeFileSync(path.join(dir, '.forge', 'HANDOFF.md'), '# handoff\nnext: tests');
  assert.doesNotMatch(go().hookSpecificOutput.additionalContext, /tokenforge checkpoint/, 'a fresh handoff wins');
});

test('kit router: tkit edit/patch are approved only in accept-edits sessions', () => {
  const r = (command, mode) => run('kit-router.mjs', { tool_name: 'Bash', session_id: sid(), cwd: os.tmpdir(), permission_mode: mode, tool_input: { command } })?.permissionDecision;
  const edit = "tkit edit <<'EOF'\nsrc/a.rs\n<<<\nold\n===\nnew\n>>>\nEOF";
  assert.equal(r(edit, 'acceptEdits'), 'allow');
  assert.notEqual(r(edit, 'default'), 'allow');
  assert.equal(r('tkit fmt', 'acceptEdits'), 'allow');
  assert.notEqual(r("tkit edit <<'EOF'\nx\nEOF\nrm -rf /", 'acceptEdits'), 'allow', 'nothing after the heredoc');
  assert.notEqual(r("tkit edit <<'EOF' && rm x\nx\nEOF", 'acceptEdits'), 'allow');
  assert.notEqual(r('tkit ssh web1 reboot', 'acceptEdits'), 'allow');
});

test('update check: banner shows a newer version from the daily check; none when up to date', async () => {
  const { cmpVersion } = await import('../lib/update-check.mjs');
  assert.equal(cmpVersion('0.7.2', '0.7.1'), 1);
  assert.equal(cmpVersion('0.7.1', '0.10.0'), -1);
  assert.equal(cmpVersion(null, '0.7.1'), 0);
  const dir = tmpdir('tforge-upd-');
  const env = { ...BASE_ENV, HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, TFORGE_UI: '0', TFORGE_LEAN_DEFAULT: 'off', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ATTENDED: '1', CI: '', TFORGE_UPDATE_URL: 'http://127.0.0.1:9/none' };
  const msg = () => JSON.parse(spawnSync('node', [HOOK('session-start.mjs')], { input: JSON.stringify({ cwd: dir, source: 'startup' }), encoding: 'utf8', env }).stdout || '{}').systemMessage || '';
  fs.mkdirSync(path.join(dir, 'tokenforge'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tokenforge', 'update.json'), JSON.stringify({ checked: Date.now(), latest: '99.0.0' }));
  assert.match(msg(), /TokenForge 99\.0\.0 is available[\s\S]*\/plugin marketplace update tokenforge/);
  fs.writeFileSync(path.join(dir, 'tokenforge', 'update.json'), JSON.stringify({ checked: Date.now(), latest: '0.0.1' }));
  assert.doesNotMatch(msg(), /is available/);
});

test('proofreading is never weakened: fresh-look prompts skip the answer cache, prose is not folded, lists stay complete', async () => {
  const { FRESH_LOOK } = await import('../lib/memory.mjs');
  for (const p of ['relis dans sa totalité et sans contexte le document et relève les erreurs et incohérences',
    'Proofread the manuscript again from scratch', 'review the whole paper', 'vérifie le chapitre 3'])
    assert.ok(FRESH_LOOK.test(p), p);
  assert.ok(!FRESH_LOOK.test('what is the password of the local dev admin account'));
  const { viewFile, view } = await import('../lib/view.mjs');
  const dir = tmpdir('tforge-prose-');
  const doc = path.join(dir, 'paper.tex');
  fs.writeFileSync(doc, Array.from({ length: 400 }, (_, i) => (i % 20 === 0 ? `\\section{S${i}}` : `  sentence ${i} with a typo teh`)).join('\n'));
  assert.equal(viewFile(doc).folded, 0, 'a .tex document prints whole');
  const md = path.join(dir, 'spec.md');
  const paras = `${'One paragraph per line, as editors soft-wrap it. '.repeat(20)}\n`.repeat(30);
  fs.writeFileSync(md, paras);
  assert.equal(view([md]), paras, 'long document lines are not cut');
  const { TERSE_RULES } = await import('../lib/config.mjs');
  assert.match(TERSE_RULES.full, /list the user asked for .* stays complete/i);
});

test('SpecAudit compatibility: document prompts get no code-mode routing; a skill being followed overrides the policy', async () => {
  for (const p of ['relis le manuscrit et relève les erreurs', 'find the errors in the proof of lemma 3', 'review docs/spec.md for inconsistencies', 'vérifie la démonstration du théorème 2'])
    assert.equal(detect(p).mode, null, p);
  assert.equal(detect('fix the error in src/parse.ts that spec.md describes').mode, 'debug');
  assert.equal(detect('review PR #12, it rewrites chapter 2').mode, 'review');
  const { kitPolicy } = await import('../hooks/session-start.mjs');
  assert.match(kitPolicy(), /skill or agent definition you follow overrides these rules/);
});

test('context budget: the handoff is written automatically from this session\'s snapshots, never over the user\'s own', async () => {
  const { autoHandoff } = await import('../hooks/context-watch.mjs');
  const { render } = await import('../hooks/checkpoint.mjs');
  const dir = tmpdir('tforge-auto-');
  const sd = path.join(dir, '.forge', 'snapshots');
  fs.mkdirSync(sd, { recursive: true });
  const sidv = 'abcd1234-ffff';
  fs.writeFileSync(path.join(sd, '20261008-1000-abcd1234-001.md'), render({ n: 1, start: '2026-10-08T10:00:00Z', end: '2026-10-08T10:10:00Z', ctx: 1, prompts: ['build the sql layer'], files: [path.join(dir, 'src/sql.rs')], reply: 'sql layer done' }, sidv, dir));
  fs.writeFileSync(path.join(sd, '20261008-1100-abcd1234-002.md'), render({ n: 2, start: '2026-10-08T11:00:00Z', end: '2026-10-08T11:10:00Z', ctx: 1, prompts: ['add duckdb backend'], files: [path.join(dir, 'src/duckdb.rs')], reply: 'duckdb backend compiles; TPC-H q1 passes' }, sidv, dir));
  assert.equal(autoHandoff(dir, sidv, 257000), true);
  const h = fs.readFileSync(path.join(dir, '.forge', 'HANDOFF.md'), 'utf8');
  assert.match(h, /automatic[\s\S]*build the sql layer[\s\S]*add duckdb backend[\s\S]*src\/sql\.rs[\s\S]*src\/duckdb\.rs[\s\S]*TPC-H q1 passes/);
  fs.writeFileSync(path.join(dir, '.forge', 'HANDOFF.md'), '# my own handoff\nnext: q2');
  assert.equal(autoHandoff(dir, sidv, 260000), false, "the user's handoff is kept");
  assert.match(fs.readFileSync(path.join(dir, '.forge', 'HANDOFF.md'), 'utf8'), /my own handoff/);
});

test('kit router: greps are never refused; build, install, git and curl rewrites', () => {
  assert.equal(bash('cd ~/.cargo/registry/src/x && grep -rn "pub struct ExternalPaths" -A6 src | head -12; ls'), null);
  assert.match(rewrite(['cargo', 'check', '-p', 'rbx_import']), /tkit check -l rust -p rbx_import --fast/);
  assert.equal(rewrite(['npm', 'install']), 'tkit run npm install');
  assert.equal(rewrite(['git', 'status']), 'git status -sb');
  assert.equal(rewrite(['find', '.', '-name', '*.rs']), "tkit run -n 150 find . -name '*.rs'");
  assert.equal(rewrite(['find', '.', '-delete']), null);
  assert.equal(rewrite(['git', 'diff', '--staged']), 'tkit run -n 300 git --no-pager diff -U1 --staged');
  assert.equal(rewrite(['git', 'diff', '-p']), null);
  assert.equal(rewrite(['curl', '-s', '-X', 'POST', 'http://localhost:3000/a', '-d', '{"a":1}']), `tkit http POST http://localhost:3000/a '{"a":1}'`);
  assert.equal(rewrite(['curl', '-o', 'f', 'http://x.io']), null);
  assert.ok(denyReason('npm init') && !denyReason('npm init -y') && denyReason('sudo apt-get install foo') && !denyReason('apt-get install -y foo'));
  assert.ok(routeCommand('ls src | grep x', {}) === null && routeCommand('find . -name a | wc -l', {}) === null);
  assert.equal(rewrite(['git', 'log']), 'git --no-pager log --oneline -n 20');
  assert.equal(rewrite(['git', 'log', '-p']), null);
  assert.ok(readReason('/p/package-lock.json', false) && !readReason('/p/package-lock.json', true) && !readReason('/p/src/a.js', false));
  assert.equal(rewrite(['docker', 'logs', '--tail', '50', 'web']), "tkit run --fuzzy docker logs --tail 50 web");
  assert.equal(rewrite(['docker', 'logs', '-f', 'web']), null);
  assert.equal(rewrite(['kubectl', 'logs', '-f', 'pod']), null);
  assert.equal(rewrite(['cargo', 'build', '--release']), 'tkit run cargo build --release');
});

test('kit router: heredoc writes and scripts are never refused or rewritten', () => {
  for (const c of ["cat > shell/a.rs <<'EOF'\nfn a() {}\nEOF", "cat > /tmp/a.py <<'E'\nprint(1)\nE\npython3 -I /tmp/a.py", "cat > a.rs <<'E'\nfn a(){}\nE\ncat > b.rs <<'E'\nfn b(){}\nE"])
    assert.equal(bash(c), null, c);
});

test('kit router: a lone grep/rg runs grouped by file through tkit run; output-changing flags, pipes and redirects are left alone', () => {
  const dir = tmpdir('tforge-grep-');
  const route = (c) => routeCommand(c, { cwd: dir })?.command ?? null;
  const ex = '--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.venv --exclude-dir=__pycache__';
  assert.equal(route("grep -rn --include='*.rs' foo ~/src"), `tkit run --group -n 200 grep --null ${ex} -rn --include='*.rs' foo ~/src`);
  assert.equal(route('grep -n foo a.txt 2>/dev/null'), 'tkit run --group -n 200 grep --null --no-messages -n foo a.txt 2>/dev/null');
  assert.match(route('grep -rn x node_modules/y'), /grep --null --exclude-dir=\.git --exclude-dir=\.venv --exclude-dir=__pycache__ -rn/);
  fs.mkdirSync(path.join(dir, 'target'));
  fs.writeFileSync(path.join(dir, 'target', 'CACHEDIR.TAG'), '');
  assert.match(route('grep -R foo .'), /--exclude-dir=target -R foo \.$/);
  for (const c of ['grep -c foo a', 'grep -rl foo .', 'grep -q foo a', 'grep foo a >/dev/null', 'grep -rn foo . | head', 'LC_ALL=C grep foo a', 'rg --files', 'rg --json foo', 'rg --pre cat foo'])
    assert.equal(route(c), null, c);
  const saved = process.env.PATH;
  try {
    process.env.PATH = dir;
    assert.equal(route('rg foo'), null, 'rg that is only a shell function cannot be started by tkit run');
    fs.writeFileSync(path.join(dir, 'rg'), '');
    assert.equal(route('rg -n foo src'), 'tkit run --group -n 200 rg --null -n foo src');
  } finally {
    process.env.PATH = saved;
  }
  assert.equal(rewrite(['gh', 'run', 'view', '42', '--log-failed']), 'tkit run --fuzzy -n 200 gh run view 42 --log-failed');
  assert.ok(readOnly(['gh', 'run', 'view', '42']) && !readOnly(['gh', 'pr', 'merge', '1']));
});

test('dashboard: a Bash call is attributed to the command that printed, not to cd, loops or heredoc text', async () => {
  const { mainCommand } = await import('../lib/insights.mjs');
  const cases = {
    'cd /x && FOO=1 timeout 60 cargo test -p a': 'cargo test',
    'for f in *.rs; do wc -l $f; done': 'wc',
    "python3 - <<'EOF'\nimport os; print(1)\nEOF": 'python3 -',
    'python3 -I bench/run.py': 'python3 *.py',
    'python3 -u -m pytest -k x': 'python3 -m pytest',
    '[ -d x ] && ls x': 'ls',
    'echo "a; b" && sed -n 1,5p f': 'sed',
    'git -C /p --no-pager log --oneline': 'git log',
    'claude -p "fix it" --model haiku': 'claude',
    "cat > a.py <<'E'\nx = 1\nE\npython3 a.py": 'python3 *.py',
    'if ! cargo build; then echo FAIL; fi': 'cargo build',
    'cd x': 'cd',
  };
  for (const [c, want] of Object.entries(cases)) assert.equal(mainCommand(c), want, c);
});

test('checkpoint: request graph links each request to its edits, reads, commands and outcome', async () => {
  const { render, fold } = await import('../hooks/checkpoint.mjs');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tfg-')), 't.jsonl');
  const ev = (o) => JSON.stringify(o);
  fs.writeFileSync(f, [
    ev({ type: 'user', timestamp: '2026-10-08T10:00:00Z', message: { content: 'fix the parser bug' } }),
    ev({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/p/a.rs' } }, { type: 'tool_use', name: 'Edit', input: { file_path: '/p/b.rs' } }, { type: 'tool_use', name: 'Bash', input: { command: 'cargo test' } }, { type: 'text', text: 'Fixed in b.rs.' }] } }),
  ].join('\n') + '\n');
  const out = render(fold(f, {}).chunk, 'sid12345', '/p');
  assert.match(out, /- R1 "fix the parser bug"\n  - edited: b\.rs\n  - read: a\.rs\n  - ran: cargo test\n  - said: Fixed in b\.rs\./);
});

test('checkpoints and handoffs live at the git root, not in the subfolder Claude was started in', async () => {
  const { projectRoot } = await import('../lib/util.mjs');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-root-'));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'crates', 'a', 'src'), { recursive: true });
  assert.equal(projectRoot(path.join(repo, 'crates', 'a', 'src')), repo);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-plain-'));
  assert.equal(projectRoot(plain), plain);
});

test('diagnose: counts skill and MCP calls from transcripts, lists long skills', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-diag-'));
  fs.mkdirSync(path.join(dir, 'skills', 'wordy'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'wordy', 'SKILL.md'), `---\nname: wordy\ndescription: ${'long '.repeat(200)}\n---\nbody`);
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ mcpServers: { used: {}, idle: {} } }));
  const t = path.join(dir, 's.jsonl');
  fs.writeFileSync(t, '{"name":"Skill","input":{"skill":"wordy"}}\n{"name":"mcp__used__q","input":{}}\n');
  process.env.CLAUDE_CONFIG_DIR = dir;
  const { diagnose } = await import('../lib/diagnose.mjs?' + Date.now());
  const d = diagnose({ files: { [t]: { mtime: Date.now() } } });
  assert.deepEqual(d.skills.map((s) => [s.name, s.uses, s.tokens > d.longTokens]), [['wordy', 1, true]]);
  assert.deepEqual(d.mcps.map((m) => [m.name, m.uses]), [['idle', 0], ['used', 1]]);
});

test('checkpoint: shell writes, reads, searches and failures land in the graph', async () => {
  const { analyzeBash } = await import('../hooks/checkpoint.mjs');
  const a = analyzeBash("cat > src/new.rs <<'EOF'\nfn x(){}\nEOF");
  assert.deepEqual(a.edits, ['src/new.rs']);
  assert.deepEqual(analyzeBash("python3 - <<'EOF'\np='src/a.rs'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF").edits, ['src/a.rs']);
  assert.deepEqual(analyzeBash("tkit edit <<'EOF'\n@@ a.rs\n<<<\nx\n===\ny\n>>>\nEOF").edits, ['a.rs']);
  const b = analyzeBash('sed -n 10,40p src/a.rs; grep -rn "featured" crates/ | head; git add -A && git commit -m x');
  assert.deepEqual(b.reads, ['src/a.rs:10-40']);
  assert.match(b.searched[0], /featured in crates/);
  assert.match(b.ran, /git add -A/);
});
