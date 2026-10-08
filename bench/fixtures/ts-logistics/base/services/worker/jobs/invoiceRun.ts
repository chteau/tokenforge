import type { Container } from '../../../packages/core/src/index.ts';
import type { InvoiceService } from '../../../packages/billing/src/index.ts';
import type { TenantDirectory } from '../../gateway/tenants.ts';

export function previousPeriod(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

export async function invoiceRun(container: Container, payload: { period?: string }): Promise<number> {
  const period = payload.period ?? previousPeriod(new Date());
  const invoices = container.get<InvoiceService>('billing.invoices');
  let issued = 0;
  for (const t of container.get<TenantDirectory>('gateway.tenants').all()) {
    if (t.internal) continue;
    const inv = await invoices.run({ id: t.id, market: t.market, currency: t.currency }, period);
    if (inv) issued += 1;
  }
  return issued;
}
