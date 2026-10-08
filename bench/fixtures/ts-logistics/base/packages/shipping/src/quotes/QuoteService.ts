import type { Clock, EventBus, Logger, TenantContext } from '../../../core/src/index.ts';
import { addHours, label, lineItemCode, marketLocale, newId, conflict, notFound } from '../../../core/src/index.ts';
import type { AdjusterRegistry, AdjustContext, LineItem, RateCalculator } from '../../../rates/src/index.ts';
import type { RatesConfig } from '../../../core/src/index.ts';
import type { QuoteRepository } from './QuoteRepository.ts';
import type { Quote, QuoteInput } from './types.ts';

export interface QuoteServiceDeps {
  calculator: RateCalculator;
  adjusters: AdjusterRegistry;
  repo: QuoteRepository;
  bus: EventBus;
  clock: Clock;
  rates: RatesConfig;
  logger: Logger;
  validityHours?: number;
}

export class QuoteService {
  private readonly d: QuoteServiceDeps;

  constructor(deps: QuoteServiceDeps) {
    this.d = deps;
  }

  /**
   * Prices a request for a tenant and stores the quote. Line items are the
   * base transport line followed by whatever the tenant's pricing profile
   * adds.
   */
  async createQuote(input: QuoteInput, tenant: TenantContext): Promise<Quote> {
    const now = this.d.clock.now();
    const locale = marketLocale(tenant.market);
    const base = this.d.calculator.calculate({
      origin: input.origin,
      destination: input.destination,
      parcels: input.parcels,
      service: input.service,
      currency: tenant.currency,
    });
    const baseCode = lineItemCode('base', input.parcels[0].kind);
    const lineItems: LineItem[] = [{ code: baseCode, label: label(baseCode, locale), amount: base.amount, source: 'base' }];

    const ctx: AdjustContext = {
      tenant,
      origin: input.origin,
      destination: input.destination,
      parcels: input.parcels,
      base,
      subtotal: base.amount,
      currency: tenant.currency,
      locale,
      rates: this.d.rates,
      now,
    };
    for (const adjust of this.d.adjusters.resolve(tenant.pricingProfile)) {
      lineItems.push(...adjust(ctx));
    }

    const quote: Quote = {
      id: newId('qt'),
      tenantId: tenant.id,
      status: 'open',
      createdAt: now.toISOString(),
      expiresAt: addHours(now, this.d.validityHours ?? 24).toISOString(),
      origin: input.origin,
      destination: input.destination,
      parcels: input.parcels,
      service: input.service,
      carrier: base.carrier,
      transitDays: base.transitDays,
      currency: tenant.currency,
      lineItems,
      total: lineItems.reduce((acc, li) => acc + li.amount, 0),
      pricingProfile: tenant.pricingProfile,
      reference: input.reference,
    };
    await this.d.repo.save(quote);
    this.d.logger.info('quote created', { quoteId: quote.id, tenantId: tenant.id, total: quote.total });
    await this.d.bus.publish('quote.created', { quoteId: quote.id, total: quote.total }, tenant.id);
    return quote;
  }

  async getQuote(tenant: TenantContext, id: string): Promise<Quote> {
    const q = await this.d.repo.get(tenant.id, id);
    if (!q) throw notFound(`quote ${id} not found`);
    if (q.status === 'open' && new Date(q.expiresAt) < this.d.clock.now()) return { ...q, status: 'expired' };
    return q;
  }

  async listQuotes(tenant: TenantContext, status?: string): Promise<Quote[]> {
    return this.d.repo.listForTenant(tenant.id, { status });
  }

  async acceptQuote(tenant: TenantContext, id: string): Promise<Quote> {
    const q = await this.getQuote(tenant, id);
    if (q.status !== 'open') throw conflict(`quote ${id} is ${q.status}`);
    const updated = await this.d.repo.updateStatus(tenant.id, id, 'accepted');
    await this.d.bus.publish('quote.accepted', { quoteId: id }, tenant.id);
    return updated as Quote;
  }
}
