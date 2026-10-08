import type { Container, TenantContext } from '../../../packages/core/src/index.ts';
import type { Quote, QuoteRepository, QuoteService } from '../../../packages/shipping/src/index.ts';
import type { TenantDirectory } from '../../gateway/tenants.ts';

/**
 * Re-prices expired open quotes for tenants on auto-renew, so that a
 * customer returning to an old quote link sees current prices.
 */
export async function requoteExpired(container: Container, payload: { tenantId: string }): Promise<number> {
  const tenants = container.get<TenantDirectory>('gateway.tenants');
  const record = tenants.get(payload.tenantId);
  if (!record) throw new Error(`unknown tenant ${payload.tenantId}`);
  const tenant: TenantContext = {
    id: record.id,
    name: record.name,
    market: record.market,
    currency: record.currency,
    pricingProfile: record.pricingProfile,
    scopes: record.scopes,
    internal: record.internal === true,
  };
  const repo = container.get<QuoteRepository>('shipping.quoteRepository');
  const quotes = container.get<QuoteService>('shipping.quotes');
  const now = Date.now();
  const expired = (await repo.listForTenant(tenant.id, { status: 'open', limit: 500 })).filter(
    (q: Quote) => new Date(q.expiresAt).getTime() < now,
  );
  for (const q of expired) {
    await repo.updateStatus(tenant.id, q.id, 'expired');
    await quotes.createQuote(
      { origin: q.origin, destination: q.destination, parcels: q.parcels, service: q.service, reference: q.reference ?? `requote:${q.id}` },
      tenant,
    );
  }
  return expired.length;
}
