// Tests for the opencode plugin: the same hook scripts, answers mapped onto opencode's plugin hooks (API v1 and v2).
import './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import plugin, { TokenForge, bashDecision, installOpencode, removeOpencode } from '../lib/opencode.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-oc-'));
for (const k of Object.keys(process.env)) if (/^(TFORGE_|TMAP_BIN)/.test(k)) delete process.env[k];
Object.assign(process.env, { TFORGE_GC: '0', TFORGE_UI: '0', TFORGE_BANNER: '0', CLAUDE_CONFIG_DIR: path.join(dir, 'cc'), XDG_CONFIG_HOME: path.join(dir, 'xdg') });

test('opencode: kit-router answers map to deny, rewrite and note', () => {
  assert.deepEqual(bashDecision(null), {});
  assert.deepEqual(bashDecision({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'no' } }), { deny: 'no' });
  assert.deepEqual(bashDecision({ hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { command: 'x' }, additionalContext: 'n' } }), { command: 'x', note: 'n' });
  assert.deepEqual(bashDecision({ hookSpecificOutput: { permissionDecision: 'allow' } }), {});
});

test('opencode: interactive ssh is refused once, other commands run as typed; the policy goes in the system prompt', async () => {
  const p = await TokenForge({ directory: dir });
  const sid = `oc${process.pid}x${Date.now()}`;
  const before = (command, callID = 'c1') => p['tool.execute.before']({ tool: 'bash', sessionID: sid, callID }, { args: { command } });
  await assert.rejects(before('ssh myhost'), /interactive shell/);
  await before('ssh myhost'); // identical repeat goes through
  const args = { command: 'echo hi' };
  await p['tool.execute.before']({ tool: 'bash', sessionID: sid, callID: 'c2' }, { args });
  assert.equal(args.command, 'echo hi');
  await p['tool.execute.before']({ tool: 'read', sessionID: sid, callID: 'c3' }, { args: { filePath: 'x' } });
  const out = { system: [] };
  await p['experimental.chat.system.transform']({ sessionID: sid }, out);
  assert.equal(out.system.length, 1);
  assert.match(out.system[0], /tokenforge/);
  const again = { system: [] };
  await p['experimental.chat.system.transform']({ sessionID: sid }, again);
  assert.deepEqual(again.system, out.system, 'same text every request');
  assert.ok(!fs.existsSync(path.join(dir, 'cc', 'settings.json')), "Claude Code's settings are not touched");
});

// A fake opencode 2 ctx: hooks registered with ctx.tool.hook / ctx.session.hook, events mutated in place.
function fakeCtx(directory) {
  const hooks = {};
  const reg = (group) => ({ hook: async (name, fn) => ((hooks[`${group}.${name}`] = fn), { dispose: () => delete hooks[`${group}.${name}`] }) });
  return { hooks, ctx: { location: { directory }, tool: reg('tool'), session: reg('session') } };
}

test('opencode 2: setup registers shell, result and context hooks; dispose removes them', async () => {
  const { hooks, ctx } = fakeCtx(dir);
  const dispose = await plugin.setup(ctx);
  assert.deepEqual(Object.keys(hooks).sort(), ['session.context', 'tool.execute.after', 'tool.execute.before']);
  const sid = `oc2${process.pid}x${Date.now()}`;
  const ev = (command, id) => ({ tool: 'shell', sessionID: sid, id, input: { command } });
  await assert.rejects(hooks['tool.execute.before'](ev('ssh myhost', 'a')), /interactive shell/);
  const e = ev('echo hi', 'b');
  await hooks['tool.execute.before'](e);
  assert.equal(e.input.command, 'echo hi');
  const ctxEv = { sessionID: sid, system: [] };
  await hooks['session.context'](ctxEv);
  assert.equal(ctxEv.system.length, 1);
  assert.equal(ctxEv.system[0].type, 'text');
  assert.match(ctxEv.system[0].text, /tokenforge/);
  await hooks['tool.execute.after']({ id: 'b', status: 'completed', result: { content: [{ type: 'text', text: 'hi' }] } });
  await dispose();
  assert.deepEqual(Object.keys(hooks), []);
  assert.equal(typeof (await plugin.setup({})), 'function', 'a ctx without hooks is a no-op, not a crash');
});

test('opencode: install writes a re-export that loads, remove deletes only its own file', async () => {
  const file = installOpencode({});
  assert.equal(file, path.join(dir, 'xdg', 'opencode', 'plugins', 'tokenforge.js'));
  fs.copyFileSync(file, file.replace(/\.js$/, '.mjs'));
  const m = await import(pathToFileURL(file.replace(/\.js$/, '.mjs')).href);
  assert.deepEqual(Object.keys(m).sort(), ['TokenForge', 'default']);
  assert.equal(m.default.id, 'tokenforge');
  assert.equal(typeof m.default.setup, 'function', 'opencode 2 needs a default { id, setup }');
  assert.equal(removeOpencode({}), file);
  assert.equal(removeOpencode({}), null);
  fs.writeFileSync(file, 'mine');
  assert.throws(() => installOpencode({}), /not written by tforge/);
  assert.equal(removeOpencode({}), null);
  assert.equal(fs.readFileSync(file, 'utf8'), 'mine');
  const proj = installOpencode({ project: true, root: dir });
  assert.equal(proj, path.join(dir, '.opencode', 'plugins', 'tokenforge.js'));
});
