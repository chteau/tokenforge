import type { Parcel } from './types.ts';

/** Volumetric weight in grams for a divisor in cm^3/kg. */
export function volumetricGrams(p: Parcel, divisor: number): number {
  if (!p.dimensions) return 0;
  const { lengthCm, widthCm, heightCm } = p.dimensions;
  return Math.ceil(((lengthCm * widthCm * heightCm) / divisor) * 1000);
}

export function chargeableGrams(parcels: Parcel[], divisor: number): number {
  return parcels.reduce((acc, p) => acc + Math.max(p.weightGrams, volumetricGrams(p, divisor)), 0);
}

/** Rounds up to the next 500 g step, minimum 500 g. */
export function roundWeight(grams: number): number {
  return Math.max(500, Math.ceil(grams / 500) * 500);
}
