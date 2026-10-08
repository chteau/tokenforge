import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { deepMerge, envOverrides, loadConfig, isEnabled, enabledFlags } from '../src/index.ts';

const root = join(import.meta.dirname, '..', '..', '..');

test('deepMerge merges nested objects and replaces arrays', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2], d: 3 } }), { a: { b: 1, c: [2], d: 3 } });
});

test('env overrides become nested camelCase keys', () => {
  assert.deepEqual(envOverrides({ KESTREL__RATES__FUEL_INDEX_BPS: '900', KESTREL__FEATURES__ZONE_ENGINE_V2: 'true', OTHER: 'x' }), {
    rates: { fuelIndexBps: 900 },
    features: { zoneEngineV2: true },
  });
});

test('test environment uses in-memory storage and keeps flags from default', () => {
  const cfg = loadConfig({ root, env: 'test', processEnv: {} });
  assert.equal(cfg.storage.dataDir, ':memory:');
  assert.equal(cfg.env, 'test');
  assert.equal(isEnabled(cfg, 'zoneEngineV2'), false);
  assert.ok(enabledFlags(cfg).includes('carrierFailover'));
});

test('production overrides fuel index', () => {
  const cfg = loadConfig({ root, env: 'production', processEnv: {} });
  assert.equal(cfg.rates.fuelIndexBps, 1210);
  assert.equal(cfg.rates.zoneUpliftBps.R, 350);
});
