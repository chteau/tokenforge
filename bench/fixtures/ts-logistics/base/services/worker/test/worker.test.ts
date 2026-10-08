import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadConfig, silentLogger, type Store } from '../../../packages/core/src/index.ts';
import { buildContainer } from '../../gateway/bootstrap.ts';
import type { QuoteRepository } from '../../../packages/shipping/src/index.ts';
import { JobQueue } from '../queue.ts';
import { drain, HANDLERS } from '../main.ts';
import { previousPeriod } from '../jobs/invoiceRun.ts';

const root = join(import.meta.dirname, '..', '..', '..');

test('queue retries then dead-letters', () => {
  const q = new JobQueue({ maxAttempts: 2 });
  const j = q.enqueue('x');
  assert.equal(q.next(), j);
  q.retry(j, new Error('boom'));
  assert.equal(q.size(), 1);
  q.retry(q.next(Date.now() + 120_000)!, 'again');
  assert.equal(q.dead.length, 1);
});

test('requote job re-prices expired quotes', async () => {
  const config = loadConfig({ root, env: 'test', processEnv: {} });
  const c = buildContainer(config, { root, logger: silentLogger });
  const repo = c.get<QuoteRepository>('shipping.quoteRepository');
  await repo.save({
    id: 'qt_old', tenantId: 'tn_acme', status: 'open', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z',
    origin: { country: 'GB', postcode: 'B1 1AA' }, destination: { country: 'GB', postcode: 'KW15 1AA' },
    parcels: [{ kind: 'parcel', weightGrams: 1000 }], service: 'standard', carrier: 'PHP', transitDays: 2, currency: 'GBP',
    lineItems: [], total: 0, pricingProfile: 'standard',
  });
  const q = new JobQueue();
  q.enqueue('quotes.requote', { tenantId: 'tn_acme' });
  assert.equal(await drain(c, q), 1);
  const all = c.get<Store>('core.store').all<{ id: string; status: string; reference?: string; lineItems: Array<{ code: string }> }>('quotes');
  assert.equal(all.find((x) => x.id === 'qt_old')?.status, 'expired');
  const fresh = all.find((x) => x.reference === 'requote:qt_old');
  assert.ok(fresh?.lineItems.some((l) => l.code === 'RAS'));
});

test('known handlers and billing period', () => {
  assert.deepEqual(Object.keys(HANDLERS).sort(), ['billing.invoiceRun', 'notify.drain', 'quotes.requote', 'tracking.poll']);
  assert.equal(previousPeriod(new Date('2026-01-15T00:00:00Z')), '2025-12');
});
