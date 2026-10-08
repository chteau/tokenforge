import test from 'node:test';
import assert from 'node:assert/strict';
import { PriorityCarrierSelector } from '../../carriers/src/index.ts';
import { ParcelHop } from '../../carriers/src/adapters/parcelhop.ts';
import { Bluefreight } from '../../carriers/src/adapters/bluefreight.ts';
import { RateCalculator, chargeableGrams, roundWeight } from '../src/index.ts';
import { RATES } from './fixtures.ts';

const calc = new RateCalculator(RATES, new PriorityCarrierSelector([new ParcelHop(), new Bluefreight()]));

test('chargeable weight uses volumetric when larger', () => {
  assert.equal(chargeableGrams([{ kind: 'parcel', weightGrams: 1000, dimensions: { lengthCm: 50, widthCm: 40, heightCm: 30 } }], 5000), 12000);
  assert.equal(roundWeight(1), 500);
  assert.equal(roundWeight(2501), 3000);
});

test('domestic parcel base rate', () => {
  const r = calc.calculate({
    origin: { country: 'GB', postcode: 'B1 1AA' },
    destination: { country: 'GB', postcode: 'HS1 2AB' },
    parcels: [{ kind: 'parcel', weightGrams: 2500 }],
    service: 'standard',
    currency: 'GBP',
  });
  assert.equal(r.band, 'P5');
  assert.equal(r.amount, 745);
  assert.equal(r.carrier, 'PHP');
  assert.equal(r.transitDays, 2);
});

test('cross-border lane multiplier and carrier', () => {
  const r = calc.calculate({
    origin: { country: 'GB', postcode: 'B1 1AA' },
    destination: { country: 'FR', postcode: '75001' },
    parcels: [{ kind: 'parcel', weightGrams: 900 }],
    service: 'express',
    currency: 'GBP',
  });
  assert.equal(r.amount, 1477);
  assert.equal(r.carrier, 'BLF');
  assert.equal(r.transitDays, 3);
});

test('unserved lane throws', () => {
  assert.throws(
    () => calc.calculate({ origin: { country: 'GB', postcode: 'B1' }, destination: { country: 'US', postcode: '10001' }, parcels: [{ kind: 'parcel', weightGrams: 1 }], service: 'standard', currency: 'GBP' }),
    /not served/,
  );
});
