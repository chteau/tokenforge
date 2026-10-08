import type { Clock, EventBus, Logger, Store } from '../../core/src/index.ts';
import type { CarrierEvent, CarrierSelector } from '../../carriers/src/index.ts';
import type { Shipment, ShipmentRepository, ShipmentService } from '../../shipping/src/index.ts';
import { canonicalStatus, isProgression } from './statusMap.ts';

export interface TrackingEventRecord {
  id: string;
  shipmentId: string;
  trackingNumber: string;
  carrier: string;
  at: string;
  rawStatus: string;
  status: string;
  location?: string;
  [k: string]: unknown;
}

export class TrackingService {
  private readonly deps: {
    store: Store;
    shipments: ShipmentService;
    shipmentRepo: ShipmentRepository;
    carriers: CarrierSelector;
    bus: EventBus;
    clock: Clock;
    logger: Logger;
    staleAfterHours: number;
  };

  constructor(deps: TrackingService['deps']) {
    this.deps = deps;
  }

  async ingest(shipment: Shipment, events: CarrierEvent[]): Promise<number> {
    const seen = new Set(this.history(shipment.id).map((e) => `${e.at}|${e.rawStatus}`));
    let applied = 0;
    let current = shipment.status;
    for (const ev of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
      const key = `${ev.at}|${ev.status}`;
      if (seen.has(key)) continue;
      const status = canonicalStatus(shipment.carrier, ev.status);
      const record: TrackingEventRecord = {
        id: `${shipment.id}:${ev.at}:${ev.status}`,
        shipmentId: shipment.id,
        trackingNumber: ev.trackingNumber,
        carrier: shipment.carrier,
        at: ev.at,
        rawStatus: ev.status,
        status: status ?? 'unknown',
        location: ev.location,
      };
      this.deps.store.append('tracking_events', record);
      if (status === undefined) this.deps.logger.warn('unmapped carrier status', { carrier: shipment.carrier, raw: ev.status });
      if (status && status !== 'ignore' && isProgression(current, status)) {
        await this.deps.shipments.applyStatus(shipment.trackingNumber, status, ev.at);
        current = status;
        applied += 1;
      }
    }
    return applied;
  }

  async poll(shipment: Shipment): Promise<number> {
    const adapter = this.deps.carriers.get(shipment.carrier);
    if (!adapter) return 0;
    const events = await adapter.fetchEvents(shipment.trackingNumber);
    return this.ingest(shipment, events);
  }

  async pollAll(): Promise<{ polled: number; updated: number; stale: string[] }> {
    const active = await this.deps.shipmentRepo.active();
    let updated = 0;
    const stale: string[] = [];
    const cutoff = this.deps.clock.now().getTime() - this.deps.staleAfterHours * 3_600_000;
    for (const s of active) {
      updated += await this.poll(s);
      const last = new Date(s.lastEventAt ?? s.createdAt).getTime();
      if (last < cutoff) stale.push(s.id);
    }
    if (stale.length) await this.deps.bus.publish('tracking.stale', { shipmentIds: stale });
    return { polled: active.length, updated, stale };
  }

  history(shipmentId: string): TrackingEventRecord[] {
    return this.deps.store
      .all<TrackingEventRecord>('tracking_events')
      .filter((e) => e.shipmentId === shipmentId)
      .sort((a, b) => a.at.localeCompare(b.at));
  }
}
