import type { Clock, EventBus, TenantContext } from '../../../core/src/index.ts';
import { conflict, newId, notFound } from '../../../core/src/index.ts';
import type { CarrierSelector } from '../../../carriers/src/index.ts';
import type { QuoteService } from '../quotes/QuoteService.ts';
import { customsFlags, type CustomsRules } from './customsHold.ts';
import type { ShipmentRepository } from './ShipmentRepository.ts';
import type { Shipment, ShipmentStatus } from './types.ts';

export class ShipmentService {
  private readonly quotes: QuoteService;
  private readonly repo: ShipmentRepository;
  private readonly carriers: CarrierSelector;
  private readonly bus: EventBus;
  private readonly clock: Clock;
  private readonly customs: CustomsRules;

  constructor(deps: {
    quotes: QuoteService;
    repo: ShipmentRepository;
    carriers: CarrierSelector;
    bus: EventBus;
    clock: Clock;
    customs: CustomsRules;
  }) {
    this.quotes = deps.quotes;
    this.repo = deps.repo;
    this.carriers = deps.carriers;
    this.bus = deps.bus;
    this.clock = deps.clock;
    this.customs = deps.customs;
  }

  async bookFromQuote(tenant: TenantContext, quoteId: string, opts: { option?: string } = {}): Promise<Shipment> {
    const quote = await this.quotes.acceptQuote(tenant, quoteId);
    const adapter = this.carriers.get(quote.carrier);
    if (!adapter) throw conflict(`carrier ${quote.carrier} is no longer available`);
    const grams = quote.parcels.reduce((a, p) => a + p.weightGrams, 0);
    const sel = {
      lane: `${quote.origin.country}-${quote.destination.country}`,
      service: quote.service,
      kind: quote.parcels[0].kind,
      grams,
    };
    const serviceCode = this.carriers.serviceCode(adapter.code, sel, opts.option);
    const id = newId('sh');
    const booking = await adapter.book({
      shipmentId: id,
      serviceCode,
      from: quote.origin,
      to: quote.destination,
      parcels: quote.parcels,
      reference: quote.reference,
    });
    const now = this.clock.now().toISOString();
    const shipment: Shipment = {
      id,
      tenantId: tenant.id,
      quoteId,
      status: 'booked',
      flags: customsFlags(quote, this.customs),
      carrier: booking.carrier,
      serviceCode,
      trackingNumber: booking.trackingNumber,
      labelUrl: booking.labelUrl,
      origin: quote.origin,
      destination: quote.destination,
      parcels: quote.parcels,
      service: quote.service,
      total: quote.total,
      currency: quote.currency,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.insert(shipment);
    await this.bus.publish('shipment.booked', { shipmentId: id, flags: shipment.flags }, tenant.id);
    return shipment;
  }

  async get(tenant: TenantContext, id: string): Promise<Shipment> {
    const s = await this.repo.get(tenant.id, id);
    if (!s) throw notFound(`shipment ${id} not found`);
    return s;
  }

  async cancel(tenant: TenantContext, id: string): Promise<Shipment> {
    const s = await this.get(tenant, id);
    if (s.status !== 'booked') throw conflict(`shipment ${id} cannot be cancelled once ${s.status}`);
    const next = { ...s, status: 'cancelled' as ShipmentStatus };
    await this.repo.update(next);
    await this.bus.publish('shipment.cancelled', { shipmentId: id }, tenant.id);
    return next;
  }

  async releaseCustomsHold(tenant: TenantContext, id: string): Promise<Shipment> {
    const s = await this.get(tenant, id);
    if (!s.flags.includes('HOLD_CUSTOMS')) return s;
    const next = { ...s, flags: s.flags.filter((f) => f !== 'HOLD_CUSTOMS') };
    await this.repo.update(next);
    await this.bus.publish('shipment.customs_released', { shipmentId: id }, tenant.id);
    return next;
  }

  async applyStatus(trackingNumber: string, status: ShipmentStatus, at: string): Promise<Shipment | undefined> {
    const s = await this.repo.byTracking(trackingNumber);
    if (!s || s.status === status) return s;
    const next = { ...s, status, lastEventAt: at };
    await this.repo.update(next);
    await this.bus.publish(`shipment.${status}`, { shipmentId: s.id, at }, s.tenantId);
    return next;
  }
}
