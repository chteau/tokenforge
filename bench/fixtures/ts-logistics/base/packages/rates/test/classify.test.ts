import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPostcode, outwardCode } from '../src/index.ts';

test('outward code extraction', () => {
  assert.equal(outwardCode('hs1 2ab'), 'HS1');
  assert.equal(outwardCode('EC1A 1BB'), 'EC1A');
  assert.equal(outwardCode('IV51 9XX'), 'IV51');
  assert.equal(outwardCode('B1'), 'B1');
});

test('GB zone classes', () => {
  assert.equal(classifyPostcode('GB', 'B1 1AA'), 'A');
  assert.equal(classifyPostcode('GB', 'HS1 2AB'), 'R');
  assert.equal(classifyPostcode('GB', 'IV51 9XX'), 'R');
  assert.equal(classifyPostcode('GB', 'IV2 3AA'), 'B');
  assert.equal(classifyPostcode('GB', 'ZE1 0AA'), 'X');
  assert.equal(classifyPostcode('GB', 'TR21 0AA'), 'X');
  assert.equal(classifyPostcode('GB', 'PO30 1AA'), 'B');
  assert.equal(classifyPostcode('GB', 'JE2 3AB'), 'X');
});

test('FR and NL zone classes', () => {
  assert.equal(classifyPostcode('FR', '75001'), 'A');
  assert.equal(classifyPostcode('FR', '20000'), 'R');
  assert.equal(classifyPostcode('FR', '97200'), 'X');
  assert.equal(classifyPostcode('FR', '05000'), 'B');
  assert.equal(classifyPostcode('NL', '1012 AB'), 'A');
  assert.equal(classifyPostcode('NL', '1791 AA'), 'R');
  assert.equal(classifyPostcode('NL', '9163 GA'), 'R');
});

test('unknown countries default to outer zone', () => {
  assert.equal(classifyPostcode('DE', '10115'), 'B');
});
