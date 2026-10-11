// Tests for the proxy on by default (lib/proxy-setup.mjs) and the preloaded repo map (hooks/session-start.mjs).
// Everything goes to temp dirs: Claude Code settings, tokenforge's config and cache, and a free port.
import './tmp.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-px-'));
process.env.XDG_CONFIG_HOME = path.join(dir, 'xdg');
process.env.XDG_CACHE_HOME = path.join(dir, 'cache');
process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'cc');
for (const k of ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'TFORGE_PROXY']) delete process.env[k];
process.env.TFORGE_PROXY_PORT = String(20000 + (process.pid % 20000));

const { applyProxyDefaultOnce, proxyBlocked, proxyGuard, proxyOff, proxyOn, proxyWanted } = await import('../lib/proxy-setup.mjs');
const { readConfig, writeConfig } = await import('../lib/config.mjs');
const { daemonStop } = await import('../lib/ui-control.mjs');
const { repoMap } = await import('../hooks/session-start.mjs');

const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
const settings = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const reset = (s) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s));
  writeConfig({ proxyAdded: null, proxyDefaultDone: false, proxyDefaultTries: 0 });
};
after(() => daemonStop('proxy'));

test('blocked by the user\'s own base URL or a cloud provider, not by the URL tokenforge added', () => {
  reset({ env: { ANTHROPIC_BASE_URL: 'https://gw.example' } });
  assert.match(proxyBlocked(file, {}), /gw\.example/);
  reset({});
  assert.match(proxyBlocked(file, { CLAUDE_CODE_USE_BEDROCK: '1' }), /BEDROCK/);
  assert.equal(proxyBlocked(file, { CLAUDE_CODE_USE_VERTEX: '0' }), null);
  reset({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' } });
  writeConfig({ proxyAdded: 'http://127.0.0.1:1' });
  assert.equal(proxyBlocked(file, {}), null);
});

test('TFORGE_PROXY=0: the first session leaves the settings alone, for good', async () => {
  reset({ model: 'x' });
  process.env.TFORGE_PROXY = '0';
  try {
    assert.equal(await applyProxyDefaultOnce(file), null);
  } finally {
    delete process.env.TFORGE_PROXY;
  }
  assert.deepEqual(settings(), { model: 'x' });
  assert.equal(readConfig().proxyDefaultDone, true);
  assert.equal(await applyProxyDefaultOnce(file), null, 'done: never asked again');
  assert.equal(await proxyGuard(file), null, 'not wanted: nothing to guard');
});

test('first session: the proxy starts, then the setting is written; off removes only that entry', async () => {
  reset({ env: { KEEP: '1' } });
  const r = await applyProxyDefaultOnce(file);
  assert.ok(r?.ok, JSON.stringify(r));
  assert.equal(settings().env.ANTHROPIC_BASE_URL, r.url);
  assert.equal(settings().env.KEEP, '1');
  assert.equal(proxyWanted(file), r.url);
  assert.equal(await proxyGuard(file), null, 'running: no warning');

  daemonStop('proxy');
  assert.equal(await proxyGuard(file), null, 'down: restarted');
  const res = await fetch(`${r.url}/v1/nothing`).catch(() => null);
  assert.ok(res, 'the restarted proxy answers');

  assert.deepEqual(proxyOff(file), { removed: true });
  assert.deepEqual(settings(), { env: { KEEP: '1' } });
  assert.equal(proxyWanted(file), null);
  assert.deepEqual(proxyOff(file), { removed: false });
});

test('on refuses next to the user\'s own base URL and leaves it', async () => {
  reset({ env: { ANTHROPIC_BASE_URL: 'https://gw.example' } });
  const r = await proxyOn(file);
  assert.equal(r.ok, false);
  assert.equal(settings().env.ANTHROPIC_BASE_URL, 'https://gw.example');
  assert.equal(readConfig().proxyDefaultDone, true);
});

test('repo map: capped, files packed when names do not fit, none without tmap or for tiny repos', () => {
  const fake = (out) => {
    const f = path.join(dir, `tmap-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(f, `#!/bin/sh\ncat <<'EOF'\n${out}\nEOF\n`, { mode: 0o755 });
    return f;
  };
  const files = Array.from({ length: 30 }, (_, i) => `    f${i}.js: alpha, beta, gamma, ${'x'.repeat(i * 3)}`);
  const tree = ['./ (30 files, 90 symbols)', '  src/', ...files].join('\n');
  assert.equal(repoMap(dir, { bin: null }), null);
  assert.equal(repoMap(dir, { bin: fake('./ (3 files, 9 symbols)\n  a.js: x') }), null);

  const whole = repoMap(dir, { bin: fake(tree), maxChars: 10000 });
  assert.match(whole, /^Repo map \(tmap/);
  assert.match(whole, /f29\.js: alpha/);
  assert.ok(whole.split('\n').every((l) => l.length <= 110));

  const packed = repoMap(dir, { bin: fake(tree), maxChars: 600 });
  assert.ok(packed.length <= 600, `${packed.length} chars`);
  assert.match(packed, /^ {4}f0\.js, f1\.js, f2\.js/m);
  assert.doesNotMatch(packed, /alpha/);

  const cut = repoMap(dir, { bin: fake(tree), maxChars: 200 });
  assert.ok(cut.length <= 200 + 40);
  assert.match(cut, /… \(cut; tmap tree DIR for the rest\)$/);
});
