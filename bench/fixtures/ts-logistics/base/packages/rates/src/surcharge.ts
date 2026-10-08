import { label, lineItemCode } from '../../core/src/index.ts';
import type { AdjustContext, LineItem } from './types.ts';

/**
 * Residential delivery surcharge: flat fee per parcel when the destination
 * is flagged residential. Pallets are never delivered to residential
 * addresses, documents are exempt.
 */
export function residentialSurcharge(ctx: AdjustContext): LineItem[] {
  if (!ctx.destination.residential) return [];
  const eligible = ctx.parcels.filter((p) => p.kind === 'parcel').length;
  if (eligible === 0) return [];
  const code = lineItemCode('residential', 'flat');
  return [{ code, label: label(code, ctx.locale), amount: ctx.rates.residentialFlat * eligible, source: 'residential' }];
}
