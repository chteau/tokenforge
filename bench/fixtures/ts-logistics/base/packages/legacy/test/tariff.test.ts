import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonlStore } from '../../core/src/index.ts';
import { quoteWithTariff } from '../tariff/quoteWithTariff.ts';
import { remoteAreaSurcharge } from '../tariff/surcharge.ts';
import { QuoteRepository } from '../quotes/QuoteRepository.ts';

test('remote area surcharge on tariff price', () => {
  assert.equal(remoteAreaSurcharge(1000, 'HS1 2AB'), 35);
  assert.equal(remoteAreaSurcharge(1000, 'EH1 1AA'), 0);
});

test('tariff quote lines and persistence', () => {
  const q = quoteWithTariff({ account: '100231', tariff: 'T2019', weightKg: 2, postcode: 'KW15 1AA', outOfHours: true });
  assert.deepEqual(q.lines.map((l) => l.code), ['BAS', 'RAS', 'OOH']);
  const repo = new QuoteRepository(new JsonlStore(':memory:'));
  repo.save(q);
  assert.equal(repo.list('100231').length, 1);
});
