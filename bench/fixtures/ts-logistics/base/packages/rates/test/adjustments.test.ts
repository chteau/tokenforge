import test from 'node:test';
import assert from 'node:assert/strict';
import { contractDiscount, fuelIndexAdjustment, peakSeasonAdjustment, residentialSurcharge, zoneUplift } from '../src/index.ts';
import { adjustCtx, TENANT } from './fixtures.ts';

test('fuel index applies to subtotal', () => {
  assert.deepEqual(fuelIndexAdjustment(adjustCtx()).map((l) => [l.code, l.amount]), [['FSC', 118]]);
});

test('zone uplift: mainland A has no line', () => {
  assert.deepEqual(zoneUplift(adjustCtx()), []);
});

test('zone uplift: remote destination adds RAS', () => {
  const lines = zoneUplift(adjustCtx({ destination: { country: 'GB', postcode: 'HS1 2AB' } }));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].code, 'RAS');
  assert.equal(lines[0].amount, 35);
  assert.equal(lines[0].label, 'Remote area surcharge');
});

test('zone uplift: localized label', () => {
  const [line] = zoneUplift(adjustCtx({ destination: { country: 'FR', postcode: '20090' }, locale: 'fr' }));
  assert.equal(line.label, 'Supplément zone éloignée');
});

test('peak season only inside window', () => {
  assert.deepEqual(peakSeasonAdjustment(adjustCtx()), []);
  assert.equal(peakSeasonAdjustment(adjustCtx({ now: new Date('2026-12-01T00:00:00Z') }))[0].code, 'PKS');
});

test('residential surcharge per parcel', () => {
  const ctx = adjustCtx({
    destination: { country: 'GB', postcode: 'B2 4QA', residential: true },
    parcels: [{ kind: 'parcel', weightGrams: 1000 }, { kind: 'parcel', weightGrams: 1000 }],
  });
  assert.equal(residentialSurcharge(ctx)[0].amount, 290);
  assert.deepEqual(residentialSurcharge(adjustCtx()), []);
});

test('contract discount is negative', () => {
  const ctx = adjustCtx({ tenant: { ...TENANT, contractDiscountBps: 800 } });
  assert.equal(contractDiscount(ctx)[0].amount, -80);
});
