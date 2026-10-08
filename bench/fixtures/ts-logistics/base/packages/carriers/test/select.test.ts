import test from 'node:test';
import assert from 'node:assert/strict';
import { PriorityCarrierSelector, CARRIER_SERVICE_CODES } from '../src/index.ts';
import { ParcelHop } from '../src/adapters/parcelhop.ts';
import { NorthwindExpress } from '../src/adapters/northwind.ts';
import { Bluefreight } from '../src/adapters/bluefreight.ts';

const req = { lane: 'GB-GB', service: 'standard' as const, kind: 'parcel' as const, grams: 2000 };

test('priority order picks first supporting carrier', () => {
  const s = new PriorityCarrierSelector([new ParcelHop(), new NorthwindExpress(), new Bluefreight()]);
  assert.equal(s.select(req).code, 'PHP');
  assert.equal(s.select({ ...req, grams: 20000 }).code, 'NWX');
  assert.equal(s.select({ ...req, kind: 'pallet', grams: 200000 }).code, 'BLF');
});

test('failover skips unhealthy carriers', () => {
  const s = new PriorityCarrierSelector([new ParcelHop(), new NorthwindExpress()], { failover: true });
  s.markUnhealthy('PHP');
  assert.equal(s.select(req).code, 'NWX');
  s.markUnhealthy('NWX');
  assert.throws(() => s.select(req), /no carrier/);
});

test('service codes come from the generated table', () => {
  const s = new PriorityCarrierSelector([new ParcelHop()]);
  const code = s.serviceCode('PHP', req);
  assert.ok(CARRIER_SERVICE_CODES.some((r) => r.externalCode === code && r.active));
});

test('simulated booking produces events', async () => {
  const nw = new NorthwindExpress();
  const b = await nw.book({ shipmentId: 's1', serviceCode: 'x', from: { country: 'GB', postcode: 'B1' }, to: { country: 'GB', postcode: 'M1' }, parcels: [{ weightGrams: 1 }] });
  assert.match(b.trackingNumber, /^NW\d+$/);
  assert.equal((await nw.fetchEvents(b.trackingNumber)).length, 4);
});
