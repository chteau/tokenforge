import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Gateway } from '../main.ts';
import { KEYS, call, quoteBody, startTestGateway } from './helpers.ts';

let g: Gateway;
before(async () => {
  g = await startTestGateway();
});
after(async () => {
  await g.stop();
});

test('quote -> shipment -> tracking', async () => {
  const q = await call(g, 'POST', '/v2/quotes', { key: KEYS.polder, body: quoteBody({ country: 'NL', postcode: '1012 AB' }, { origin: { country: 'NL', postcode: '3011 AA' }, parcels: [{ weightGrams: 900 }] }) });
  assert.equal(q.status, 201);
  const s = await call(g, 'POST', '/v2/shipments', { key: KEYS.polder, body: { quoteId: q.body.id } });
  assert.equal(s.status, 201);
  assert.equal(s.body.status, 'booked');
  const t = await call(g, 'GET', `/v2/shipments/${s.body.id}/tracking?refresh=1`, { key: KEYS.polder });
  assert.equal(t.status, 200);
  assert.ok(t.body.events.length > 0);
  const again = await call(g, 'POST', '/v2/shipments', { key: KEYS.polder, body: { quoteId: q.body.id } });
  assert.equal(again.status, 409);
});

test('Jersey postcodes book without a customs hold and can be cancelled', async () => {
  const q = await call(g, 'POST', '/v2/quotes', { key: KEYS.acme, body: quoteBody({ country: 'GB', postcode: 'JE2 3AB' }) });
  const s = await call(g, 'POST', '/v2/shipments', { key: KEYS.acme, body: { quoteId: q.body.id } });
  assert.deepEqual(s.body.flags, []);
  const cancelled = await call(g, 'POST', `/v2/shipments/${s.body.id}/cancel`, { key: KEYS.acme });
  assert.equal(cancelled.body.status, 'cancelled');
});

test('lumen lacks shipments:write scope', async () => {
  const r = await call(g, 'POST', '/v2/shipments', { key: KEYS.lumen, body: { quoteId: 'qt_x' } });
  assert.equal(r.status, 403);
});
