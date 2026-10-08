import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteBand, zoneUpliftV2 } from '../src/zones/zoneEngineV2.ts';
import { adjustCtx } from './fixtures.ts';

test('v2 remote bands', () => {
  assert.equal(remoteBand('GB', 'ZE1 0AA'), 'far');
  assert.equal(remoteBand('GB', 'IV51 9XX'), 'near');
  assert.equal(remoteBand('GB', 'B1 1AA'), 'none');
  assert.equal(remoteBand('FR', '20000'), 'near');
});

test('v2 surcharge amounts', () => {
  assert.equal(zoneUpliftV2(adjustCtx({ destination: { country: 'GB', postcode: 'IV51 9XX' } }))[0].amount, 35);
  assert.equal(zoneUpliftV2(adjustCtx({ destination: { country: 'GB', postcode: 'ZE1 0AA' } }))[0].amount, 50);
});
