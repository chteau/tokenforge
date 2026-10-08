import type { Quote } from '../quotes/types.ts';

export interface CustomsRules {
  holdDestinations: string[];
  declaredValueThreshold: number;
}

/**
 * Returns the flags a new shipment starts with. Shipments leaving the
 * customs union, or above the low-value threshold, are held until the
 * paperwork is uploaded.
 */
export function customsFlags(quote: Pick<Quote, 'origin' | 'destination' | 'parcels'>, rules: CustomsRules): string[] {
  const flags: string[] = [];
  const declared = quote.parcels.reduce((acc, p) => acc + (p.declaredValue ?? 0), 0);
  if (rules.holdDestinations.includes(quote.destination.country)) flags.push('HOLD_CUSTOMS');
  else if (quote.origin.country === 'GB' && quote.destination.country !== 'GB' && declared > rules.declaredValueThreshold) {
    flags.push('HOLD_CUSTOMS');
  }
  if (declared > 0 && quote.parcels.some((p) => p.declaredValue === undefined)) flags.push('PARTIAL_DECLARATION');
  return flags;
}
