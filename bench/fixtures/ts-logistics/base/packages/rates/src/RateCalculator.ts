import type { RatesConfig } from '../../core/src/index.ts';
import { applyBps } from '../../core/src/index.ts';
import { BANDS, LANE_MULTIPLIER, TRANSIT_DAYS } from './bands.ts';
import type { Address, BaseRate, Parcel, ServiceLevel } from './types.ts';
import { chargeableGrams, roundWeight } from './weights.ts';
import type { CarrierSelector } from '../../carriers/src/index.ts';

export interface RateRequest {
  origin: Address;
  destination: Address;
  parcels: Parcel[];
  service: ServiceLevel;
  currency: string;
}

export class RateNotAvailable extends Error {}

/**
 * Computes the base transport rate for a request: chargeable weight, band
 * lookup and lane multiplier. Surcharges and adjustments are NOT applied
 * here; see AdjusterRegistry.
 */
export class RateCalculator {
  private readonly rates: RatesConfig;
  private readonly carriers: CarrierSelector;

  constructor(rates: RatesConfig, carriers: CarrierSelector) {
    this.rates = rates;
    this.carriers = carriers;
  }

  calculate(req: RateRequest): BaseRate {
    if (req.parcels.length === 0) throw new RateNotAvailable('no parcels');
    const kind = req.parcels[0].kind;
    const grams = roundWeight(chargeableGrams(req.parcels, this.rates.volumetricDivisor));
    const band = BANDS[kind].find((b) => grams <= b.maxGrams);
    if (!band) throw new RateNotAvailable(`no ${kind} band for ${grams}g`);
    const lane = `${req.origin.country}-${req.destination.country}`;
    const multiplier = LANE_MULTIPLIER[lane];
    if (multiplier === undefined) throw new RateNotAvailable(`lane ${lane} not served`);
    const carrier = this.carriers.select({ lane, service: req.service, kind, grams });
    const amount = applyBps(band.price[req.service], multiplier);
    return {
      carrier: carrier.code,
      service: req.service,
      chargeableGrams: grams,
      band: band.id,
      amount,
      currency: req.currency,
      transitDays: TRANSIT_DAYS[req.service] + (lane.slice(0, 2) === lane.slice(3) ? 0 : 2),
    };
  }
}
