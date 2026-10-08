import test from 'node:test';
import assert from 'node:assert/strict';
import { fuelSurcharge, remoteFuelSurcharge } from '../src/fuelSurcharge.ts';

test('fuel surcharge from monthly table', () => {
  assert.equal(fuelSurcharge(1000, new Date('2024-03-15')).amount, 108);
  assert.equal(remoteFuelSurcharge(1000, new Date('2024-03-15'), true).amount, 162);
});
