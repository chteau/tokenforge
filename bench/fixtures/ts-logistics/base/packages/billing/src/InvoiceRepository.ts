import type { Store } from '../../core/src/index.ts';

export interface InvoiceLine {
  shipmentId: string;
  description: string;
  net: number;
  tax: number;
}

export interface Invoice {
  id: string;
  tenantId: string;
  period: string;
  currency: string;
  lines: InvoiceLine[];
  net: number;
  tax: number;
  gross: number;
  issuedAt: string;
  [k: string]: unknown;
}

export class InvoiceRepository {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  async insert(inv: Invoice): Promise<void> {
    this.store.append('invoices', inv);
  }
  async forPeriod(tenantId: string, period: string): Promise<Invoice | undefined> {
    return this.store.all<Invoice>('invoices').find((i) => i.tenantId === tenantId && i.period === period);
  }
  async all(tenantId: string): Promise<Invoice[]> {
    return this.store.all<Invoice>('invoices').filter((i) => i.tenantId === tenantId);
  }
}
