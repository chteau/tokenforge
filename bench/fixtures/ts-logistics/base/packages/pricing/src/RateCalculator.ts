import { applyRemoteSurcharge, applyResidentialSurcharge } from './surcharge.ts';
import { volumeDiscount } from './discounts.ts';
import type { PriceLine, PriceRequest, PricedQuote } from './types.ts';

const WEIGHT_TABLE: Array<{ maxKg: number; economy: number; standard: number; express: number }> = [
  { maxKg: 1, economy: 380, standard: 480, express: 860 },
  { maxKg: 2, economy: 430, standard: 560, express: 960 },
  { maxKg: 5, economy: 570, standard: 720, express: 1200 },
  { maxKg: 10, economy: 760, standard: 960, express: 1540 },
  { maxKg: 20, economy: 1150, standard: 1440, express: 2210 },
  { maxKg: 30, economy: 1530, standard: 1920, express: 2880 },
];

const FUEL_PCT = 9.5;

/**
 * Prices a parcel: weight table, fuel, remote area and residential
 * surcharges, then volume discount.
 */
export class RateCalculator {
  calculate(req: PriceRequest): PricedQuote {
    const row = WEIGHT_TABLE.find((r) => req.weightKg <= r.maxKg);
    if (!row) throw new Error(`no rate for ${req.weightKg}kg`);
    let lines: PriceLine[] = [{ code: 'BAS', description: 'Transport', pence: row[req.service] }];
    lines.push({ code: 'FSC', description: 'Fuel surcharge', pence: Math.round((row[req.service] * FUEL_PCT) / 100) });
    lines = applyRemoteSurcharge(lines, req.toPostcode);
    lines = applyResidentialSurcharge(lines, req.residential);
    lines = volumeDiscount(lines, req.monthlyVolume);
    return { lines, totalPence: lines.reduce((a, l) => a + l.pence, 0) };
  }
}
