import type { Clock, EventBus } from '../../core/src/index.ts';
import { newId } from '../../core/src/index.ts';
import type { ShipmentRepository } from '../../shipping/src/index.ts';
import type { Invoice, InvoiceRepository } from './InvoiceRepository.ts';
import { vatFor } from './tax.ts';

export interface TenantBilling {
  id: string;
  market: string;
  currency: string;
}

export class InvoiceService {
  private readonly d: {
    shipments: ShipmentRepository;
    invoices: InvoiceRepository;
    bus: EventBus;
    clock: Clock;
    vatBps: Record<string, number>;
  };

  constructor(d: InvoiceService['d']) {
    this.d = d;
  }

  /** Bills all non-cancelled shipments created in `period` (YYYY-MM). Idempotent per tenant/period. */
  async run(tenant: TenantBilling, period: string): Promise<Invoice | undefined> {
    const existing = await this.d.invoices.forPeriod(tenant.id, period);
    if (existing) return existing;
    const shipments = (await this.d.shipments.forTenant(tenant.id)).filter(
      (s) => s.createdAt.startsWith(period) && s.status !== 'cancelled',
    );
    if (shipments.length === 0) return undefined;
    const lines = shipments.map((s) => {
      const t = vatFor(s.total, tenant.market, s.destination.country, this.d.vatBps);
      return { shipmentId: s.id, description: `${s.carrier} ${s.trackingNumber} to ${s.destination.postcode}`, net: s.total, tax: t.tax };
    });
    const net = lines.reduce((a, l) => a + l.net, 0);
    const tax = lines.reduce((a, l) => a + l.tax, 0);
    const inv: Invoice = {
      id: newId('inv'),
      tenantId: tenant.id,
      period,
      currency: tenant.currency,
      lines,
      net,
      tax,
      gross: net + tax,
      issuedAt: this.d.clock.now().toISOString(),
    };
    await this.d.invoices.insert(inv);
    await this.d.bus.publish('invoice.issued', { invoiceId: inv.id, gross: inv.gross }, tenant.id);
    return inv;
  }
}
