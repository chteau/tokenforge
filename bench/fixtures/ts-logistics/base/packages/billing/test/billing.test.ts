import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, EventBus, JsonlStore, fixedClock } from '../../core/src/index.ts';
import { ShipmentRepository, type Shipment } from '../../shipping/src/index.ts';
import { InvoiceRepository, InvoiceService, vatFor } from '../src/index.ts';

test('vat rules', () => {
  const rates = { GB: 2000, FR: 2000 };
  assert.equal(vatFor(1000, 'GB', 'GB', rates).tax, 200);
  assert.equal(vatFor(1000, 'GB', 'FR', rates).tax, 0);
  assert.equal(vatFor(1000, 'FR', 'NL', rates).tax, 200);
});

test('invoice run is idempotent', async () => {
  const store = new JsonlStore(':memory:');
  const shipments = new ShipmentRepository(store);
  const base = { tenantId: 'tn_a', quoteId: 'q', flags: [], carrier: 'PHP', serviceCode: 'x', labelUrl: '', origin: { country: 'GB', postcode: 'B1' }, parcels: [], service: 'standard', currency: 'GBP', updatedAt: '' };
  await shipments.insert({ ...base, id: 's1', status: 'delivered', trackingNumber: 'T1', destination: { country: 'GB', postcode: 'M1' }, total: 1000, createdAt: '2026-02-03T00:00:00Z' } as Shipment);
  await shipments.insert({ ...base, id: 's2', status: 'cancelled', trackingNumber: 'T2', destination: { country: 'GB', postcode: 'M1' }, total: 500, createdAt: '2026-02-04T00:00:00Z' } as Shipment);
  const svc = new InvoiceService({ shipments, invoices: new InvoiceRepository(store), bus: new EventBus(), clock: fixedClock('2026-03-01T06:00:00Z'), vatBps: { GB: 2000 } });
  const tenant = { id: 'tn_a', market: 'GB', currency: 'GBP' };
  const inv = await svc.run(tenant, '2026-02');
  assert.equal(inv?.gross, 1200);
  assert.equal((await svc.run(tenant, '2026-02'))?.id, inv?.id);
  assert.equal(await svc.run(tenant, '2026-01'), undefined);
  void Container;
});
