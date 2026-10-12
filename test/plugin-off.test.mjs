import './tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-off-'));
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'cc');
process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
const cfgFile = path.join(process.env.XDG_CONFIG_HOME, 'tokenforge', 'config.json');

const { pluginDisabled, undoIfDisabled, redoAfterReenable, disabledWatcher } = await import('../lib/plugin-off.mjs');
const { leanOn, leanStatus } = await import('../lib/lean.mjs');
const { readConfig, writeConfig } = await import('../lib/config.mjs');
const { startProxy } = await import('../lib/proxy.mjs');

const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (s) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s));
};
const URL_ = 'http://127.0.0.1:7879';

// what tokenforge sets up, next to the user's own deny entry; the proxy setting written as proxyOn would
function setup(enabled) {
  fs.rmSync(cfgFile, { force: true });
  write({ permissions: { deny: ['WebFetch'] }, ...(enabled === undefined ? {} : { enabledPlugins: { 'tokenforge@tokenforge': enabled, 'other@x': false } }) });
  leanOn(file, 'max');
  const s = read();
  s.env = { ANTHROPIC_BASE_URL: URL_ };
  write(s);
  writeConfig({ proxyAdded: URL_ });
}

test('plugin-off: only an explicit false for tokenforge@… counts as disabled', () => {
  for (const [ep, want] of [[undefined, false], [{}, false], [{ 'tokenforge@tokenforge': true }, false], [{ 'other@x': false }, false], [{ 'tokenforge@tokenforge': false }, true]]) {
    write(ep ? { enabledPlugins: ep } : {});
    assert.equal(pluginDisabled(file), want, JSON.stringify(ep));
  }
});

test('plugin-off: nothing changes while enabled, or with no enabledPlugins entry (--plugin-dir)', () => {
  for (const enabled of [true, undefined]) {
    setup(enabled);
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(undoIfDisabled(file), null);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});

test('plugin-off: disabled removes what tokenforge added, keeps the user\'s own, and comes back on re-enable', async () => {
  setup(false);
  assert.equal(read().autoCompactWindow, 300000);
  assert.deepEqual(undoIfDisabled(file), { lean: 'max', proxy: true });
  const s = read();
  assert.deepEqual(s.permissions.deny, ['WebFetch']);
  assert.equal(s.env, undefined);
  assert.equal(s.autoCompactWindow, undefined);
  assert.equal(s.enabledPlugins['tokenforge@tokenforge'], false);
  assert.equal(undoIfDisabled(file), null, 'once');
  assert.deepEqual(readConfig().disabledUndo, { lean: 'max', proxy: true });

  // re-enabled: lean comes back (the proxy part needs the daemon, so it is dropped from this run)
  writeConfig({ disabledUndo: { lean: 'max', proxy: false } });
  assert.deepEqual(await redoAfterReenable(file), ['lean tools ("max")']);
  assert.equal(leanStatus(file).level, 'max');
  assert.equal(readConfig().disabledUndo, null);
  assert.equal(await redoAfterReenable(file), null);
});

test('plugin-off: a level the user set while disabled is not overwritten', async () => {
  setup(false);
  undoIfDisabled(file);
  leanOn(file, 'on');
  assert.equal(await redoAfterReenable(file), null);
  assert.equal(leanStatus(file).level, 'on');
});

test('plugin-off: the watcher reads settings at most once per interval', () => {
  setup(false);
  const check = disabledWatcher(file, 60e3);
  assert.ok(check());
  setup(false);
  assert.equal(check(), null);
  assert.equal(leanStatus(file).level, 'max');
});

test('plugin-off: the proxy daemon cleans up on a request once the plugin is disabled', async () => {
  setup(false);
  const p = await startProxy({ port: 0, upstream: 'http://127.0.0.1:1', dir: path.join(root, 'proxy'), watchPlugin: true });
  try {
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: p.port, path: '/v1/models', method: 'GET' }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    });
    assert.deepEqual(read().permissions.deny, ['WebFetch']);
    assert.equal(read().env, undefined);
  } finally {
    p.server.close();
  }
});
