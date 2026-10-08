import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Store } from '../../../packages/core/src/index.ts';
import type { Gateway } from '../main.ts';
import { KEYS, call, quoteBody, startTestGateway } from './helpers.ts';

let g: Gateway;
before(async () => {
  g = await startTestGateway();
});
after(async () => {
  await g.stop();
});

type Line = { code: string; amount: number; label: string };
const codes = (body: { lineItems: Line[] }) => body.lineItems.map((l) => l.code);

test('POST /v2/quotes prices a mainland parcel', async () => {
  const r = await call(g, 'POST', '/v2/quotes', { key: KEYS.acme, body: quoteBody({ country: 'GB', postcode: 'M1 1AE' }) });
  assert.equal(r.status, 201);
  assert.deepEqual(codes(r.body), ['BAS', 'FSC']);
});

test('POST /v2/quotes adds remote area line for island postcodes and persists the quote', async () => {
  const r = await call(g, 'POST', '/v2/quotes', { key: KEYS.acme, body: quoteBody({ country: 'GB', postcode: 'HS1 2AB' }) });
  assert.equal(r.status, 201);
  const ras = (r.body.lineItems as Line[]).find((l) => l.code === 'RAS');
  assert.ok(ras);
  assert.equal(ras.amount, 26);
  const stored = g.container.get<Store>('core.store').find<{ id: string; lineItems: Line[] }>('quotes', r.body.id);
  assert.ok(stored?.lineItems.some((l) => l.code === 'RAS'));
  const fetched = await call(g, 'GET', `/v2/quotes/${r.body.id}`, { key: KEYS.acme });
  assert.equal(fetched.body.total, r.body.total);
});

test('contract tenant is not charged the remote area line', async () => {
  const r = await call(g, 'POST', '/v2/quotes', { key: KEYS.fjord, body: quoteBody({ country: 'GB', postcode: 'HS1 2AB' }) });
  assert.equal(r.status, 201);
  assert.deepEqual(codes(r.body), ['BAS', 'FSC', 'DSC']);
});

test('FR tenant gets localized remote line for Corsica', async () => {
  const r = await call(g, 'POST', '/v2/quotes', {
    key: KEYS.lumen,
    body: quoteBody({ country: 'FR', postcode: '20000' }, { origin: { country: 'FR', postcode: '75001' } }),
  });
  assert.equal(r.status, 201);
  const ras = (r.body.lineItems as Line[]).find((l) => l.code === 'RAS');
  assert.equal(ras?.label, 'Supplément zone éloignée');
  assert.equal(r.body.currency, 'EUR');
});

test('internal callers may price as another profile; others may not', async () => {
  const asOps = await call(g, 'POST', '/v2/quotes', { key: KEYS.ops, body: quoteBody({ country: 'GB', postcode: 'HS1 2AB' }), headers: { 'x-pricing-profile': 'standard' } });
  assert.ok(codes(asOps.body).includes('RAS'));
  const plainOps = await call(g, 'POST', '/v2/quotes', { key: KEYS.ops, body: quoteBody({ country: 'GB', postcode: 'HS1 2AB' }) });
  assert.deepEqual(codes(plainOps.body), ['BAS']);
  const denied = await call(g, 'POST', '/v2/quotes', { key: KEYS.acme, body: quoteBody({ country: 'GB', postcode: 'HS1 2AB' }), headers: { 'x-pricing-profile': 'contract' } });
  assert.equal(denied.status, 403);
});

test('auth, validation and scope errors', async () => {
  assert.equal((await call(g, 'POST', '/v2/quotes', { body: quoteBody({ country: 'GB', postcode: 'M1 1AE' }) })).status, 401);
  assert.equal((await call(g, 'POST', '/v2/quotes', { key: 'nope', body: {} })).status, 401);
  const bad = await call(g, 'POST', '/v2/quotes', { key: KEYS.acme, body: { service: 'x' } });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'validation_failed');
  assert.equal((await call(g, 'GET', '/v1/quote', { key: KEYS.acme })).status, 404);
});

test('health endpoints do not need a tenant', async () => {
  assert.equal((await call(g, 'GET', '/healthz')).status, 200);
  const ready = await call(g, 'GET', '/readyz');
  assert.equal(ready.body.env, 'test');
  assert.ok(!ready.body.flags.includes('zoneEngineV2'));
});
