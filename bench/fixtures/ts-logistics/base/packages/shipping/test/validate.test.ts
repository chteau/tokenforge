import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQuoteInput } from '../src/index.ts';

const ok = {
  origin: { country: 'GB', postcode: 'B1 1AA' },
  destination: { country: 'GB', postcode: 'HS1 2AB' },
  parcels: [{ weightGrams: 1200 }],
  service: 'express',
};

test('valid input gets default parcel kind', () => {
  assert.equal(validateQuoteInput(ok).parcels[0].kind, 'parcel');
});

test('invalid input lists issues', () => {
  try {
    validateQuoteInput({ ...ok, service: 'warp', parcels: [] });
    assert.fail('expected throw');
  } catch (err) {
    const issues = (err as { details: { issues: Array<{ path: string }> } }).details.issues.map((i) => i.path);
    assert.deepEqual(issues.sort(), ['parcels', 'service']);
  }
});

test('mixed parcel kinds rejected', () => {
  assert.throws(() => validateQuoteInput({ ...ok, parcels: [{ weightGrams: 1 }, { kind: 'pallet', weightGrams: 1 }] }), /invalid/);
});
