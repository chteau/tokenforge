import './tmp.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-sl-'));
process.env.XDG_CONFIG_HOME = path.join(ROOT, 'xdg');
process.env.XDG_CACHE_HOME = path.join(ROOT, 'cache');
process.env.CLAUDE_CONFIG_DIR = path.join(ROOT, 'cc');
delete process.env.TFORGE_STATUSLINE;

const { computeSavings, fmtTokens, formatSegment, asciiOnly, refresh, midnight } = await import('../lib/estimate.mjs');
const { statuslineCommand, installStatusline, removeStatusline, autoStatusline, shimPath } = await import('../lib/limits.mjs');
const { readConfig, writeConfig } = await import('../lib/config.mjs');
const { FIXED_TOKENS } = await import('../lib/lean.mjs');

const iso = (s) => new Date(s * 1000).toISOString();
const asst = (rid, ts, u, extra = {}) =>
  JSON.stringify({ type: 'assistant', timestamp: iso(ts), requestId: rid, cwd: '/repo', message: { id: 'msg_' + rid, usage: u, content: [] }, ...extra });

test('estimate math: fixed per call, tool savings re-read until compaction when tied to a session, answer hits, pct', () => {
  const s = {
    id: 'A',
    cwd: '/repo',
    saving: 7191, // balanced
    // [ts, tokens, context]
    calls: [[100, 20000, 19000], [200, 30000, 29000], [300, 40000, 39000], [400, 15000, 14000], [500, 16000, 15000]],
    compacts: [350],
    kits: [150],
  };
  const rows = [
    { t: 160, cwd: '/repo/sub', raw: 5000, out: 1000 }, // tied (kit at 150): re-read by calls at 200 and 300, then compacted
    { t: 2000, cwd: '/repo', raw: 2000, out: 500 }, // no kit call in the 30 min before: once
    { t: 2005, cwd: '/elsewhere', raw: 9000, out: 0 }, // no counted session in that project: left out
    { t: 460, cwd: '/repo', raw: 100, out: 400 }, // never negative
  ];
  const answers = [{ t: 320, session: 'A' }, { t: 330, session: 'gone' }];
  const r = computeSavings({ sessions: [s], rows, answers });
  assert.equal(r.calls, 5);
  assert.equal(r.used, 121000);
  assert.equal(r.fixed, 5 * 7191);
  assert.equal(r.tools, 4000 * 2 + 1500);
  assert.equal(r.toolsReread, 1);
  assert.equal(r.answers, 39000, 'one call at the context size just before the hit');
  assert.equal(r.answerHits, 2);
  assert.equal(r.saved, 35955 + 9500 + 39000);
  assert.ok(Math.abs(r.pct - r.saved / (121000 + r.saved)) < 1e-12);

  const later = computeSavings({ sessions: [s], rows, answers, since: 360 });
  assert.deepEqual([later.calls, later.fixed, later.tools, later.answers], [2, 2 * 7191, 1500, 0]);
  const mine = computeSavings({ sessions: [s], rows, answers, only: 'A' });
  assert.equal(mine.tools, 8000, 'untied rows are not part of a session');
  assert.equal(mine.answerHits, 1);
  assert.deepEqual(computeSavings({ sessions: [] }).pct, 0);
  // no calls before the hit: the session's fixed context is the least it would have cost
  assert.equal(computeSavings({ sessions: [{ ...s, calls: [] }], answers: [{ t: 1, session: 'A' }] }).answers, FIXED_TOKENS.off - 7191);
});

test('segment text: compact numbers, minus sign or ASCII fallback, empty until something is saved', () => {
  assert.deepEqual([fmtTokens(950), fmtTokens(1234), fmtTokens(45600), fmtTokens(1.23e6), fmtTokens(2.5e7)], ['950', '1.2k', '46k', '1.2M', '25M']);
  const r = { saved: 1.2e6, pct: 0.449 };
  assert.equal(formatSegment(r, false), 'TF \u221245% today (~1.2M saved)');
  assert.equal(formatSegment(r, true), 'TF -45% today (~1.2M saved)');
  assert.equal(formatSegment({ saved: 0, pct: 0 }, false), '');
  assert.equal(asciiOnly({ LANG: 'en_US.UTF-8' }, 'linux'), false);
  assert.equal(asciiOnly({ LANG: 'C' }, 'linux'), true);
  assert.equal(asciiOnly({}, 'win32'), true, 'legacy Windows console');
  assert.equal(asciiOnly({ WT_SESSION: 'x' }, 'win32'), false, 'Windows Terminal');
  assert.equal(asciiOnly({ TFORGE_ASCII: '1', LANG: 'en_US.UTF-8' }, 'linux'), true);
});

test('refresh: reads transcripts incrementally, dedups by requestId, ties kit savings, never double counts', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'r-'));
  const opts = (now) => ({ now, file: path.join(dir, 'state.json'), ledger: path.join(dir, 'savings.jsonl'), answers: path.join(dir, 'answers.jsonl') });
  const t0 = Math.floor(midnight() + 3600);
  const tr = path.join(dir, 'sess.jsonl');
  const u = (n) => ({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: n, output_tokens: 100 });
  const kit = { message: { id: 'msg_b', usage: u(20000), content: [{ type: 'tool_use', name: 'Bash', input: { command: 'tkit test' } }] } };
  fs.writeFileSync(
    tr,
    [
      JSON.stringify({ type: 'user', timestamp: iso(t0), cwd: '/repo' }),
      asst('a', t0 + 1, u(10000)),
      asst('a', t0 + 1, u(10000)), // second content block of the same response
      JSON.stringify({ ...JSON.parse(asst('b', t0 + 10, u(20000))), ...kit }),
    ].join('\n') + '\n' + asst('c', t0 + 30, u(30000)).slice(0, 40), // partial last line: not read yet
  );
  fs.writeFileSync(path.join(dir, 'savings.jsonl'), JSON.stringify({ t: t0 + 20, tool: 'test', cwd: '/repo', raw: 9000, out: 1000 }) + '\n');
  const input = { session_id: 'S1', transcript_path: tr, cwd: '/repo' };
  const first = refresh(input, opts((t0 + 25) * 1000));
  assert.equal(first.today.calls, 2);
  assert.equal(first.today.used, 10100 + 20100);
  assert.equal(first.today.tools, 8000, 'tied, but no later call yet: counted once');
  assert.equal(first.session.fixed, 0, 'lean off: no fixed saving');

  fs.writeFileSync(tr, fs.readFileSync(tr, 'utf8').replace(/\{[^\n]*$/, '') + asst('c', t0 + 30, u(30000)) + '\n' + JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: iso(t0 + 40) }) + '\n' + asst('d', t0 + 50, u(5000)) + '\n');
  fs.appendFileSync(path.join(dir, 'answers.jsonl'), JSON.stringify({ t: t0 + 45, session: 'S1' }) + '\n');
  const second = refresh(input, opts((t0 + 60) * 1000));
  assert.equal(second.today.calls, 4);
  assert.equal(second.today.tools, 8000, 're-read by the call at +30 only; the compaction drops it');
  assert.equal(second.today.answers, 30000);
  const again = refresh(input, opts((t0 + 61) * 1000));
  assert.deepEqual(again.today, second.today, 'nothing new: same numbers');
});

test('refresh: fixed saving follows the lean level, but not for sessions started before a lean change', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'lv-'));
  const opts = { file: path.join(dir, 'state.json'), ledger: path.join(dir, 'none'), answers: path.join(dir, 'none2') };
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const settings = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  const before = fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : null;
  return import('../lib/lean.mjs').then(({ leanOn, leanOff }) => {
    writeConfig({ leanChangedAt: 0 });
    leanOn(settings, 'max');
    const changed = readConfig().leanChangedAt / 1000;
    const tr = (name, ts) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, asst(name, ts, { input_tokens: 1000, output_tokens: 10 }) + '\n');
      return f;
    };
    const old = refresh({ session_id: 'old', transcript_path: tr('old', changed - 5) }, opts);
    assert.equal(old.session.fixed, 0, 'started before the change: unknown level, counts 0');
    const fresh = refresh({ session_id: 'new', transcript_path: tr('new', changed + 120) }, opts);
    assert.equal(fresh.session.fixed, FIXED_TOKENS.off - FIXED_TOKENS.max);
    leanOff(settings);
    if (before === null) fs.rmSync(settings, { force: true });
  });
});

test('status-line command: node and shim quoted, Windows paths with spaces and backslashes, no shell syntax', () => {
  const win = statuslineCommand('ccstatusline --x "a b"', { node: 'C:\\Program Files\\nodejs\\node.exe', shim: 'C:\\Users\\Jane Doe\\.config\\tokenforge\\statusline.mjs', platform: 'win32' });
  const m = /^"C:\/Program Files\/nodejs\/node.exe" "C:\/Users\/Jane Doe\/.config\/tokenforge\/statusline.mjs" --chain-b64 ([A-Za-z0-9+/=]+)$/.exec(win);
  assert.ok(m, win);
  assert.equal(Buffer.from(m[1], 'base64').toString('utf8'), 'ccstatusline --x "a b"');
  assert.doesNotMatch(win, /[$`'~;&|<>]/);
  assert.equal(statuslineCommand(null, { node: '/usr/bin/node', shim: '/h/a b/statusline.mjs', platform: 'linux' }), '"/usr/bin/node" "/h/a b/statusline.mjs"');
});

test('setup: auto-adds when there is no statusLine, only offers next to an existing one, remove restores exactly', () => {
  const file = path.join(ROOT, 'cc2', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const reset = () => writeConfig({ statusline: null, statuslineOffered: false });

  // none -> installed once, with a notice; removal leaves no statusLine key
  reset();
  fs.writeFileSync(file, JSON.stringify({ model: 'opus' }));
  assert.match(autoStatusline(file), /added a status line showing your savings; tforge statusline --remove undoes it/);
  const s1 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s1.statusLine.type, 'command');
  assert.ok(s1.statusLine.command.includes(shimPath()) && s1.statusLine.command.includes(process.execPath));
  assert.ok(fs.existsSync(shimPath()), 'shim copied');
  assert.equal(autoStatusline(file), null, 'once');
  assert.equal(removeStatusline(file).removed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'opus' });
  assert.equal(autoStatusline(file), null, 'removed stays removed');

  // existing -> never replaced automatically, offered once
  reset();
  const mine = { type: 'command', command: 'bash ~/my-line.sh', padding: 2 };
  fs.writeFileSync(file, JSON.stringify({ statusLine: mine }));
  assert.match(autoStatusline(file), /tforge statusline --setup/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine, mine);
  assert.equal(autoStatusline(file), null, 'offered once');
  // explicit setup wraps it; remove restores it exactly
  assert.equal(installStatusline(file).wrapped, true);
  const wrapped = JSON.parse(fs.readFileSync(file, 'utf8')).statusLine;
  assert.equal(wrapped.padding, 2);
  assert.equal(Buffer.from(/--chain-b64 (\S+)/.exec(wrapped.command)[1], 'base64').toString('utf8'), mine.command);
  assert.equal(installStatusline(file).already, true);
  removeStatusline(file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { statusLine: mine });
  assert.equal(removeStatusline(file).removed, false, 'never removes the user\'s own');

  // opt-out
  reset();
  fs.writeFileSync(file, '{}');
  process.env.TFORGE_STATUSLINE = '0';
  try {
    assert.equal(autoStatusline(file), null);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
  } finally {
    delete process.env.TFORGE_STATUSLINE;
  }
});

test('shim: appends the savings segment to the wrapped status line, or prints it alone', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'shim-'));
  const env = { ...process.env, XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_CONFIG_HOME: path.join(dir, 'xdg'), CLAUDE_CONFIG_DIR: path.join(dir, 'cc'), LANG: 'en_US.UTF-8', TFORGE_ASCII: '' };
  fs.mkdirSync(path.join(dir, 'cache', 'tokenforge'), { recursive: true });
  const t = Math.floor(Date.now() / 1000) - 5;
  const tr = path.join(dir, 's.jsonl');
  fs.writeFileSync(tr, asst('x', t, { input_tokens: 20900, output_tokens: 100 }) + '\n');
  fs.writeFileSync(path.join(dir, 'cache', 'tokenforge', 'savings.jsonl'), JSON.stringify({ t, tool: 'check', cwd: '/repo/pkg', raw: 10000, out: 1000 }) + '\n');
  fs.appendFileSync(path.join(dir, 'cache', 'tokenforge', 'savings.jsonl'), JSON.stringify({ t, tool: 'check', cwd: '/other', raw: 50000, out: 0 }) + '\n');
  const payload = JSON.stringify({ session_id: 'S', transcript_path: tr, cwd: '/repo' });
  const shim = path.join(HERE, '..', 'bin', 'statusline-shim.mjs');
  const prev = Buffer.from('echo "my line"').toString('base64');
  const r = spawnSync(process.execPath, [shim, '--chain-b64', prev], { input: payload, encoding: 'utf8', env });
  assert.equal(r.stdout, 'my line \u00b7 TF \u221230% today (~9.0k saved)');
  const alone = spawnSync(process.execPath, [shim], { input: payload, encoding: 'utf8', env: { ...env, TFORGE_ASCII: '1' } });
  assert.equal(alone.stdout, 'TF -30% today (~9.0k saved)');
});
