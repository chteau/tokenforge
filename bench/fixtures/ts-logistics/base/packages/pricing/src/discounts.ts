import type { PriceLine } from './types.ts';

export const VOLUME_TIERS: Array<{ minParcels: number; pct: number }> = [
  { minParcels: 5000, pct: 12 },
  { minParcels: 1000, pct: 8 },
  { minParcels: 250, pct: 4 },
];

export function volumeDiscount(lines: PriceLine[], monthlyVolume = 0): PriceLine[] {
  const tier = VOLUME_TIERS.find((t) => monthlyVolume >= t.minParcels);
  if (!tier) return lines;
  const base = lines.find((l) => l.code === 'BAS')?.pence ?? 0;
  return [...lines, { code: 'DSC', description: `Volume discount ${tier.pct}%`, pence: -Math.round((base * tier.pct) / 100) }];
}
