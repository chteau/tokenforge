import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBps, add, money, sum, fromDecimal } from '../src/index.ts';

test('applyBps rounds half to even', () => {
  assert.equal(applyBps(1000, 350), 35);
  assert.equal(applyBps(745, 350), 26);
  assert.equal(applyBps(50, 1000), 5);
  assert.equal(applyBps(25, 1000), 2); // 2.5 -> 2
  assert.equal(applyBps(35, 1000), 4); // 3.5 -> 4
});

test('money arithmetic guards currency', () => {
  assert.deepEqual(add(money(1, 'GBP'), money(2, 'GBP')), money(3, 'GBP'));
  assert.throws(() => add(money(1, 'GBP'), money(1, 'EUR')), /currency mismatch/);
  assert.deepEqual(sum([money(5, 'EUR'), money(7, 'EUR')], 'EUR'), money(12, 'EUR'));
  assert.throws(() => money(1.5, 'GBP'));
  assert.deepEqual(fromDecimal(12.345, 'GBP'), money(1235, 'GBP'));
});
