import test from 'node:test';
import assert from 'node:assert/strict';
import { RateCalculator, applyRemoteSurcharge, isRemote, volumeDiscount } from '../src/index.ts';

test('remote postcodes', () => {
  assert.ok(isRemote('HS1 2AB'));
  assert.ok(isRemote('ze1 0aa'));
  assert.ok(!isRemote('B1 1AA'));
});

test('applyRemoteSurcharge adds 3.5% of transport', () => {
  const lines = applyRemoteSurcharge([{ code: 'BAS', description: 'Transport', pence: 1000 }], 'HS1 2AB');
  assert.deepEqual(lines[1], { code: 'RAS', description: 'Remote area surcharge', pence: 35 });
});

test('calculate prices a remote parcel', () => {
  const q = new RateCalculator().calculate({ weightKg: 2, toPostcode: 'IV51 9XX', service: 'standard' });
  assert.deepEqual(q.lines.map((l) => l.code), ['BAS', 'FSC', 'RAS']);
  assert.equal(q.totalPence, 560 + 53 + 21);
});

test('volume discount tiers', () => {
  assert.equal(volumeDiscount([{ code: 'BAS', description: '', pence: 1000 }], 1200)[1].pence, -80);
});
