import { FR_DEPARTMENTS, GB_DISTRICTS, NL_RANGES } from './data/districts.gen.ts';

/**
 * Zone classes:
 *   A  mainland, next-day network
 *   B  mainland, outer network (one extra linehaul)
 *   R  remote: islands and highlands served by partner carriers
 *   X  extended: overseas territories, ferry-only areas
 */
export type ZoneClass = 'A' | 'B' | 'R' | 'X';

export function normalisePostcode(postcode: string): string {
  return postcode.toUpperCase().replace(/\s+/g, '').trim();
}

/** GB outward code: everything except the last three characters. */
export function outwardCode(postcode: string): string {
  const pc = normalisePostcode(postcode);
  return pc.length > 4 ? pc.slice(0, -3) : pc;
}

function classifyGB(postcode: string): ZoneClass {
  const outward = outwardCode(postcode);
  const hit = GB_DISTRICTS[outward];
  if (hit) return hit;
  // unknown district: fall back to the area letters
  const area = outward.replace(/\d.*$/, '');
  return GB_DISTRICTS[`${area}*`] ?? 'A';
}

function classifyFR(postcode: string): ZoneClass {
  const pc = normalisePostcode(postcode);
  const dept = pc.startsWith('97') || pc.startsWith('98') ? pc.slice(0, 3) : pc.slice(0, 2);
  return FR_DEPARTMENTS[dept] ?? 'A';
}

function classifyNL(postcode: string): ZoneClass {
  const digits = Number(normalisePostcode(postcode).slice(0, 4));
  if (!Number.isFinite(digits)) return 'A';
  for (const [lo, hi, zone] of NL_RANGES) if (digits >= lo && digits <= hi) return zone;
  return 'A';
}

export function classifyPostcode(country: string, postcode: string): ZoneClass {
  switch (country.toUpperCase()) {
    case 'GB':
      return classifyGB(postcode);
    case 'FR':
      return classifyFR(postcode);
    case 'NL':
      return classifyNL(postcode);
    default:
      return 'B';
  }
}
