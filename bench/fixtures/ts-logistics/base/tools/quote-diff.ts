#!/usr/bin/env node
/**
 * Compares the old pricing engine with the current rate card for a sample
 * of lanes. Used during the 2025 rate review; prints a table of deltas.
 *
 *   node tools/quote-diff.ts HS1 IV51 B1 EH1
 */
import { RateCalculator as PricingCalculator } from '../packages/pricing/src/index.ts';
import { BANDS } from '../packages/rates/src/index.ts';

export function diff(postcodes: string[], kg = 2): Array<{ postcode: string; old: number; card: number }> {
  const old = new PricingCalculator();
  const band = BANDS.parcel.find((b) => kg * 1000 <= b.maxGrams);
  return postcodes.map((pc) => ({
    postcode: pc,
    old: old.calculate({ weightKg: kg, toPostcode: pc, service: 'standard' }).totalPence,
    card: band ? band.price.standard : 0,
  }));
}

if (import.meta.main) {
  for (const r of diff(process.argv.slice(2))) console.log(`${r.postcode.padEnd(8)} old=${r.old} card=${r.card} delta=${r.card - r.old}`);
}
