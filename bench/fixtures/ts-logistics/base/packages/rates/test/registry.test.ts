import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Container, loadConfig } from '../../core/src/index.ts';
import { registerCarriers } from '../../carriers/src/index.ts';
import { AdjusterRegistry, registerRates, zoneUplift, fuelIndexAdjustment } from '../src/index.ts';
import { zoneUpliftV2 } from '../src/zones/zoneEngineV2.ts';

const root = join(import.meta.dirname, '..', '..', '..');

function setup(overrides: Record<string, unknown> = {}) {
  const config = loadConfig({ root, env: 'test', processEnv: {}, overrides });
  const c = new Container();
  registerCarriers(c, config);
  registerRates(c, config);
  return { c, registry: c.get<AdjusterRegistry>('rates.adjusters') };
}

test('standard profile resolves the configured adjuster chain', () => {
  const { registry } = setup();
  const chain = registry.resolve('standard');
  assert.equal(chain.length, 4);
  assert.equal(chain[0], fuelIndexAdjustment);
  assert.equal(chain[1], zoneUplift);
});

test('unknown profile falls back to the default profile', () => {
  const { registry } = setup();
  assert.equal(registry.resolve('tariff:T2019'), registry.resolve('standard'));
  assert.equal(registry.resolve(undefined).length, 4);
});

test('contract profile has no zone adjuster', () => {
  const { registry } = setup();
  assert.ok(!registry.resolve('contract').includes(zoneUplift));
});

test('zoneEngineV2 flag swaps the zone adjuster', () => {
  const { registry } = setup({ features: { zoneEngineV2: true } });
  assert.equal(registry.resolve('standard')[1], zoneUpliftV2);
});

test('missing adjuster key is reported', () => {
  const { c } = setup();
  const r = new AdjusterRegistry({ defaultProfile: 'x', profiles: { x: ['adjuster.nope'] } }, c);
  assert.throws(() => r.resolve('x'), /no service registered/);
});
