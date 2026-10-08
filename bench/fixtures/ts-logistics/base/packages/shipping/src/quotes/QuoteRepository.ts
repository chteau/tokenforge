import type { Store } from '../../../core/src/index.ts';
import type { Quote } from './types.ts';

const COLLECTION = 'quotes';

export class QuoteRepository {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  async save(quote: Quote): Promise<Quote> {
    this.store.append(COLLECTION, { ...quote });
    return quote;
  }

  async get(tenantId: string, id: string): Promise<Quote | undefined> {
    const q = this.store.find<Quote & { id: string }>(COLLECTION, id);
    return q && q.tenantId === tenantId ? q : undefined;
  }

  async listForTenant(tenantId: string, opts: { status?: string; limit?: number } = {}): Promise<Quote[]> {
    return this.store
      .all<Quote & { id: string }>(COLLECTION)
      .filter((q) => q.tenantId === tenantId && (!opts.status || q.status === opts.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, opts.limit ?? 50);
  }

  async updateStatus(tenantId: string, id: string, status: Quote['status']): Promise<Quote | undefined> {
    const q = await this.get(tenantId, id);
    if (!q) return undefined;
    const next = { ...q, status };
    this.store.replace(COLLECTION, next);
    return next;
  }
}
