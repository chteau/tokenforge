import type { Store } from '../../core/src/index.ts';
import type { TariffQuote } from '../tariff/quoteWithTariff.ts';

/**
 * Persistence for tariff quotes produced by the monolith (and the CLI).
 * Rows go to the `legacy_quotes` collection, which the 2019 reporting jobs
 * still read.
 */
export class QuoteRepository {
  private readonly store: Store;
  private seq = 0;

  constructor(store: Store) {
    this.store = store;
  }

  save(quote: TariffQuote): string {
    this.seq += 1;
    const id = `LQ${Date.now()}${this.seq}`;
    this.store.append('legacy_quotes', { id, ...quote, savedBy: 'legacy' });
    return id;
  }

  list(account: string): TariffQuote[] {
    return this.store.all<TariffQuote & { id: string }>('legacy_quotes').filter((q) => q.account === account);
  }
}
