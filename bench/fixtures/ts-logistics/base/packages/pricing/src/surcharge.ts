import type { PriceLine } from './types.ts';

/** Remote area surcharge, as a percentage of the transport price. */
export const REMOTE_SURCHARGE_PCT = 3.5;

/** Postcode areas treated as remote (Highlands & Islands, Scilly). */
export const REMOTE_AREAS = ['HS', 'ZE', 'KW', 'IV', 'PA', 'PH', 'TR21', 'TR22', 'TR23', 'TR24', 'TR25'];

export const RESIDENTIAL_FEE_PENCE = 120;

export function isRemote(postcode: string): boolean {
  const pc = postcode.toUpperCase().replace(/\s+/g, '');
  return REMOTE_AREAS.some((a) => pc.startsWith(a));
}

/** Adds the remote area surcharge line when the destination is remote. */
export function applyRemoteSurcharge(lines: PriceLine[], postcode: string): PriceLine[] {
  if (!isRemote(postcode)) return lines;
  const transport = lines.filter((l) => l.code === 'BAS' || l.code === 'FSC').reduce((a, l) => a + l.pence, 0);
  return [...lines, { code: 'RAS', description: 'Remote area surcharge', pence: Math.round((transport * REMOTE_SURCHARGE_PCT) / 100) }];
}

export function applyResidentialSurcharge(lines: PriceLine[], residential: boolean | undefined): PriceLine[] {
  if (!residential) return lines;
  return [...lines, { code: 'RES', description: 'Residential delivery', pence: RESIDENTIAL_FEE_PENCE }];
}
