import test from 'node:test';
import assert from 'node:assert/strict';
import { customsFlags, type QuoteService, type ShipmentService } from '../src/index.ts';
import { ACME, container } from './helpers.ts';

const rules = { holdDestinations: ['CH', 'NO'], declaredValueThreshold: 135000 };

test('customs flags', () => {
  const q = (country: string, declared?: number) => ({
    origin: { country: 'GB', postcode: 'B1' },
    destination: { country, postcode: 'x' },
    parcels: [{ kind: 'parcel' as const, weightGrams: 1, declaredValue: declared }],
  });
  assert.deepEqual(customsFlags(q('CH'), rules), ['HOLD_CUSTOMS']);
  assert.deepEqual(customsFlags(q('FR', 200000), rules), ['HOLD_CUSTOMS']);
  assert.deepEqual(customsFlags(q('FR', 1000), rules), []);
  assert.deepEqual(customsFlags(q('GB', 200000), rules), []);
});

test('book, cancel and status updates', async () => {
  const { c } = container();
  const quotes = c.get<QuoteService>('shipping.quotes');
  const shipments = c.get<ShipmentService>('shipping.shipments');
  const q = await quotes.createQuote(
    { origin: { country: 'GB', postcode: 'B1 1AA' }, destination: { country: 'GB', postcode: 'M1 1AE' }, parcels: [{ kind: 'parcel', weightGrams: 900 }], service: 'standard' },
    ACME,
  );
  const s = await shipments.bookFromQuote(ACME, q.id);
  assert.equal(s.status, 'booked');
  assert.equal(s.carrier, 'PHP');
  const moved = await shipments.applyStatus(s.trackingNumber, 'in_transit', '2026-03-10T10:00:00Z');
  assert.equal(moved?.status, 'in_transit');
  await assert.rejects(shipments.cancel(ACME, s.id), /cannot be cancelled/);
});
