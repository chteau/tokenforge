import type { RatesConfig, TenantContext } from '../../core/src/index.ts';
import type { AdjustContext, BaseRate } from '../src/index.ts';

export const RATES: RatesConfig = {
  currency: 'GBP',
  zoneUpliftBps: { A: 0, B: 120, R: 350, X: 900 },
  fuelIndexBps: 1175,
  residentialFlat: 145,
  peak: { from: '11-20', to: '12-31', bps: 400 },
  volumetricDivisor: 5000,
};

export const TENANT: TenantContext = {
  id: 'tn_test',
  name: 'Test Ltd',
  market: 'GB',
  currency: 'GBP',
  pricingProfile: 'standard',
  scopes: ['*'],
  internal: false,
};

export function adjustCtx(over: Partial<AdjustContext> = {}): AdjustContext {
  const base: BaseRate = { carrier: 'PHP', service: 'standard', chargeableGrams: 2500, band: 'P5', amount: 1000, currency: 'GBP', transitDays: 2 };
  return {
    tenant: TENANT,
    origin: { country: 'GB', postcode: 'B1 1AA' },
    destination: { country: 'GB', postcode: 'EC1A 1BB' },
    parcels: [{ kind: 'parcel', weightGrams: 2500 }],
    base,
    subtotal: base.amount,
    currency: 'GBP',
    locale: 'en',
    rates: RATES,
    now: new Date('2026-03-10T12:00:00Z'),
    ...over,
  };
}
