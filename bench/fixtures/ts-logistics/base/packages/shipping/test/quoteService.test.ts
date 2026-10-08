import test from 'node:test';
import assert from 'node:assert/strict';
import type { EventBus, Store } from '../../core/src/index.ts';
import type { QuoteService } from '../src/index.ts';
import { ACME, container } from './helpers.ts';

const input = (postcode: string, extra: Record<string, unknown> = {}) => ({
  origin: { country: 'GB', postcode: 'B1 1AA' },
  destination: { country: 'GB', postcode, ...extra },
  parcels: [{ kind: 'parcel' as const, weightGrams: 2500 }],
  service: 'standard' as const,
});

test('quote for mainland postcode has base and fuel only', async () => {
  const { c } = container();
  const q = await c.get<QuoteService>('shipping.quotes').createQuote(input('M1 1AE'), ACME);
  assert.deepEqual(q.lineItems.map((l) => l.code), ['BAS', 'FSC']);
  assert.equal(q.total, 745 + 88);
  assert.equal(q.expiresAt, '2026-03-11T09:00:00.000Z');
});

test('quote for remote postcode carries remote area line and is stored', async () => {
  const { c } = container();
  const q = await c.get<QuoteService>('shipping.quotes').createQuote(input('HS1 2AB'), ACME);
  assert.deepEqual(q.lineItems.map((l) => l.code), ['BAS', 'FSC', 'RAS']);
  const stored = c.get<Store>('core.store').find<{ id: string; total: number }>('quotes', q.id);
  assert.equal(stored?.total, q.total);
  assert.equal(c.get<EventBus>('core.bus').history.at(-1)?.type, 'quote.created');
});

test('contract tenants get discount and no zone uplift', async () => {
  const { c } = container();
  const q = await c
    .get<QuoteService>('shipping.quotes')
    .createQuote(input('HS1 2AB'), { ...ACME, id: 'tn_fjord', pricingProfile: 'contract', contractDiscountBps: 800 } as typeof ACME);
  assert.deepEqual(q.lineItems.map((l) => l.code), ['BAS', 'FSC', 'DSC']);
});

test('residential and peak season lines', async () => {
  const { c } = container({ now: '2026-12-02T10:00:00Z' });
  const q = await c.get<QuoteService>('shipping.quotes').createQuote(input('ZE1 0AA', { residential: true }), ACME);
  assert.deepEqual(q.lineItems.map((l) => l.code), ['BAS', 'FSC', 'XAS', 'RES', 'PKS']);
});

test('accept quote transitions once', async () => {
  const { c } = container();
  const svc = c.get<QuoteService>('shipping.quotes');
  const q = await svc.createQuote(input('M1 1AE'), ACME);
  assert.equal((await svc.acceptQuote(ACME, q.id)).status, 'accepted');
  await assert.rejects(svc.acceptQuote(ACME, q.id), /is accepted/);
  await assert.rejects(svc.getQuote({ ...ACME, id: 'other' }, q.id), /not found/);
});
