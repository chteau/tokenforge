import { applyBps } from '../../core/src/index.ts';

export interface TaxLine {
  country: string;
  bps: number;
  net: number;
  tax: number;
}

/** VAT is charged in the market of the tenant; exports are zero-rated. */
export function vatFor(net: number, tenantMarket: string, destinationCountry: string, vatBps: Record<string, number>): TaxLine {
  const zeroRated = tenantMarket !== destinationCountry && !(tenantMarket !== 'GB' && destinationCountry !== 'GB');
  const bps = zeroRated ? 0 : (vatBps[tenantMarket] ?? 0);
  return { country: tenantMarket, bps, net, tax: applyBps(net, bps) };
}
