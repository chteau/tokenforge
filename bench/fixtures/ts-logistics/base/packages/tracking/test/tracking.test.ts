import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, EventBus, JsonlStore, fixedClock, loadConfig, silentLogger } from '../../core/src/index.ts';
import { registerCarriers } from '../../carriers/src/index.ts';
import { registerRates } from '../../rates/src/index.ts';
import { registerShipping, type QuoteService, type ShipmentService } from '../../shipping/src/index.ts';
import { registerTracking, canonicalStatus, isProgression, type TrackingService } from '../src/index.ts';
import { root, ACME } from '../../shipping/test/helpers.ts';

test('status mapping and progression', () => {
  assert.equal(canonicalStatus('NWX', 'OFD'), 'out_for_delivery');
  assert.equal(canonicalStatus('PHP', 'created'), 'ignore');
  assert.equal(canonicalStatus('XXX', '1'), undefined);
  assert.ok(isProgression('booked', 'in_transit'));
  assert.ok(!isProgression('delivered', 'in_transit'));
  assert.ok(isProgression('exception', 'in_transit'));
});

test('poll ingests carrier events once and advances shipment', async () => {
  const config = loadConfig({ root, env: 'test', processEnv: {} });
  const c = new Container();
  c.value('core.logger', silentLogger);
  c.value('core.clock', fixedClock('2026-03-10T09:00:00Z'));
  c.value('core.store', new JsonlStore(':memory:'));
  c.value('core.bus', new EventBus());
  registerCarriers(c, config);
  registerRates(c, config);
  registerShipping(c, config);
  registerTracking(c, config);
  const q = await c.get<QuoteService>('shipping.quotes').createQuote(
    { origin: { country: 'GB', postcode: 'B1 1AA' }, destination: { country: 'GB', postcode: 'M1 1AE' }, parcels: [{ kind: 'parcel', weightGrams: 900 }], service: 'standard' },
    ACME,
  );
  const s = await c.get<ShipmentService>('shipping.shipments').bookFromQuote(ACME, q.id);
  const tracking = c.get<TrackingService>('tracking.service');
  assert.equal(await tracking.poll(s), 2);
  assert.equal(tracking.history(s.id).length, 4);
  const again = await c.get<ShipmentService>('shipping.shipments').get(ACME, s.id);
  assert.equal(again.status, 'out_for_delivery');
  assert.equal(await tracking.poll(again), 0);
});
