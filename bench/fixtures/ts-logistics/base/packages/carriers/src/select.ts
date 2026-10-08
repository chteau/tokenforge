import type { CarrierAdapter, SelectionRequest } from './types.ts';
import { CARRIER_SERVICE_CODES } from './carrierCodes.gen.ts';

export class NoCarrierAvailable extends Error {}

export interface CarrierSelector {
  select(req: SelectionRequest): CarrierAdapter;
  serviceCode(carrier: string, req: SelectionRequest, option?: string): string;
  get(code: string): CarrierAdapter | undefined;
}

/**
 * Picks the first carrier (in priority order) that supports a request.
 * With failover enabled, carriers marked unhealthy are skipped.
 */
export class PriorityCarrierSelector implements CarrierSelector {
  private readonly adapters: CarrierAdapter[];
  private readonly failover: boolean;
  private unhealthy = new Set<string>();

  constructor(adapters: CarrierAdapter[], opts: { failover?: boolean } = {}) {
    this.adapters = adapters;
    this.failover = opts.failover ?? false;
  }

  markUnhealthy(code: string): void {
    this.unhealthy.add(code);
  }

  markHealthy(code: string): void {
    this.unhealthy.delete(code);
  }

  get(code: string): CarrierAdapter | undefined {
    return this.adapters.find((a) => a.code === code);
  }

  select(req: SelectionRequest): CarrierAdapter {
    const candidates = this.adapters.filter((a) => a.supports(req));
    const usable = this.failover ? candidates.filter((a) => !this.unhealthy.has(a.code)) : candidates;
    const pick = usable[0] ?? (this.failover ? undefined : candidates[0]);
    if (!pick) throw new NoCarrierAvailable(`no carrier for ${req.lane} ${req.service} ${req.kind} ${req.grams}g`);
    return pick;
  }

  serviceCode(carrier: string, req: SelectionRequest, option = 'none'): string {
    const row = CARRIER_SERVICE_CODES.find(
      (r) => r.carrier === carrier && r.service === req.service && r.kind === req.kind && r.option === option && r.active,
    );
    if (!row) throw new NoCarrierAvailable(`no active service code for ${carrier} ${req.service} ${req.kind} ${option}`);
    return row.externalCode;
  }
}
