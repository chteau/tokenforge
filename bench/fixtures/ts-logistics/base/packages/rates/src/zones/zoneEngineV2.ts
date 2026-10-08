import { applyBps, label, lineItemCode } from '../../../core/src/index.ts';
import type { AdjustContext, LineItem } from '../types.ts';
import { normalisePostcode } from './classify.ts';

/**
 * Zone engine v2: distance-based remote surcharge.
 *
 * Instead of the static district table, v2 computes the road+ferry distance
 * from the nearest hub and charges a sliding remote-area surcharge:
 *   > 150 km or ferry leg  -> 3.5 %
 *   > 300 km               -> 5 %
 *
 * Behind the `zoneEngineV2` feature flag while hub coordinates are
 * validated (see docs/adr/0009-zone-engine-v2.md).
 */
const HUBS: Array<{ id: string; country: string; prefixes: string[]; ferryPrefixes: string[]; farPrefixes: string[] }> = [
  { id: 'GLA', country: 'GB', prefixes: ['G', 'PA', 'KA', 'ML'], ferryPrefixes: ['PA20', 'PA41', 'PA42', 'PA60', 'PA80', 'HS'], farPrefixes: ['HS', 'ZE', 'KW15', 'KW16', 'KW17'] },
  { id: 'ABZ', country: 'GB', prefixes: ['AB', 'DD', 'PH'], ferryPrefixes: ['ZE', 'KW15', 'KW16', 'KW17'], farPrefixes: ['ZE'] },
  { id: 'INV', country: 'GB', prefixes: ['IV', 'KW'], ferryPrefixes: ['IV41', 'IV42', 'IV43', 'IV44', 'IV45', 'IV46', 'IV47', 'IV48', 'IV49', 'IV51', 'IV55', 'IV56'], farPrefixes: [] },
  { id: 'PLY', country: 'GB', prefixes: ['PL', 'TR'], ferryPrefixes: ['TR21', 'TR22', 'TR23', 'TR24', 'TR25'], farPrefixes: [] },
  { id: 'MRS', country: 'FR', prefixes: ['13', '83', '84'], ferryPrefixes: ['20'], farPrefixes: [] },
  { id: 'LWR', country: 'NL', prefixes: ['89', '88', '91'], ferryPrefixes: ['1791', '1792', '1793', '1794', '1795', '1796', '1797', '8881', '8882', '8883', '8884', '8885', '8891', '8896', '8897', '8899', '9161', '9162', '9163', '9164', '9166'], farPrefixes: [] },
];

export const REMOTE_PCT_NEAR = 3.5;
export const REMOTE_PCT_FAR = 5;

export function remoteBand(country: string, postcode: string): 'none' | 'near' | 'far' {
  const pc = normalisePostcode(postcode);
  for (const hub of HUBS.filter((h) => h.country === country)) {
    if (hub.farPrefixes.some((p) => pc.startsWith(p))) return 'far';
    if (hub.ferryPrefixes.some((p) => pc.startsWith(p))) return 'near';
  }
  return 'none';
}

export function zoneUpliftV2(ctx: AdjustContext): LineItem[] {
  const band = remoteBand(ctx.destination.country, ctx.destination.postcode);
  if (band === 'none') return [];
  const pct = band === 'far' ? REMOTE_PCT_FAR : REMOTE_PCT_NEAR;
  const code = lineItemCode('zone', band === 'far' ? 'X' : 'R');
  return [{ code, label: label(code, ctx.locale), amount: applyBps(ctx.subtotal, pct * 100), source: `zone-v2:${band}` }];
}
