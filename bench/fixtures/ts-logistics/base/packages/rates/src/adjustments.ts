import { applyBps, inWindow, label, lineItemCode } from '../../core/src/index.ts';
import type { AdjustContext, LineItem } from './types.ts';
import { classifyPostcode } from './zones/classify.ts';

/*
 * Quote adjustments applied after the base rate. Each adjuster receives the
 * same context and returns zero or more line items; the order in which they
 * run is defined by the tenant's pricing profile.
 */

function item(ctx: AdjustContext, kind: string, variant: string, amount: number, source: string): LineItem {
  const code = lineItemCode(kind, variant);
  return { code, label: label(code, ctx.locale), amount, source };
}

/** Monthly fuel index, applied to the transport subtotal. */
export function fuelIndexAdjustment(ctx: AdjustContext): LineItem[] {
  const bps = ctx.rates.fuelIndexBps;
  if (!bps) return [];
  return [item(ctx, 'fuel', 'index', applyBps(ctx.subtotal, bps), 'fuel')];
}

/**
 * Destination zone uplift. The destination postcode is classified into a
 * zone class and the configured uplift for that class is applied to the
 * subtotal. Classes without an uplift produce no line.
 */
export function zoneUplift(ctx: AdjustContext): LineItem[] {
  const zone = classifyPostcode(ctx.destination.country, ctx.destination.postcode);
  const bps = ctx.rates.zoneUpliftBps[zone] ?? 0;
  if (bps <= 0) return [];
  return [item(ctx, 'zone', zone, applyBps(ctx.subtotal, bps), `zone:${zone}`)];
}

/** Seasonal uplift between rates.peak.from and rates.peak.to (MM-DD, inclusive). */
export function peakSeasonAdjustment(ctx: AdjustContext): LineItem[] {
  const { from, to, bps } = ctx.rates.peak;
  if (!bps || !inWindow(ctx.now, from, to)) return [];
  return [item(ctx, 'peak', 'season', applyBps(ctx.subtotal, bps), 'peak')];
}

/** Negotiated discount for contract tenants (tenant.contractDiscountBps). */
export function contractDiscount(ctx: AdjustContext): LineItem[] {
  const bps = ctx.tenant.contractDiscountBps ?? 0;
  if (bps <= 0) return [];
  return [item(ctx, 'discount', 'contract', -applyBps(ctx.subtotal, bps), 'contract')];
}
