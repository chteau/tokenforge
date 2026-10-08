import type { ServiceLevel, PackageKind } from './types.ts';

export interface Band {
  id: string;
  maxGrams: number;
  /** price in minor units per service level */
  price: Record<ServiceLevel, number>;
}

// Domestic GB parcel bands (2025 rate card). EU markets apply the lane
// multiplier from LANE_MULTIPLIER below.
export const PARCEL_BANDS: Band[] = [
  { id: 'P1', maxGrams: 1000, price: { economy: 395, standard: 495, express: 895, sameday: 1695 } },
  { id: 'P2', maxGrams: 2000, price: { economy: 445, standard: 575, express: 995, sameday: 1795 } },
  { id: 'P5', maxGrams: 5000, price: { economy: 595, standard: 745, express: 1245, sameday: 2095 } },
  { id: 'P10', maxGrams: 10000, price: { economy: 795, standard: 995, express: 1595, sameday: 2495 } },
  { id: 'P15', maxGrams: 15000, price: { economy: 995, standard: 1245, express: 1945, sameday: 2895 } },
  { id: 'P20', maxGrams: 20000, price: { economy: 1195, standard: 1495, express: 2295, sameday: 3295 } },
  { id: 'P30', maxGrams: 30000, price: { economy: 1595, standard: 1995, express: 2995, sameday: 3995 } },
];

export const PALLET_BANDS: Band[] = [
  { id: 'QP', maxGrams: 250000, price: { economy: 3900, standard: 4500, express: 6900, sameday: 12900 } },
  { id: 'HP', maxGrams: 500000, price: { economy: 5400, standard: 6200, express: 8900, sameday: 15900 } },
  { id: 'FP', maxGrams: 1000000, price: { economy: 6900, standard: 7900, express: 10900, sameday: 19900 } },
];

export const DOCUMENT_BANDS: Band[] = [
  { id: 'D1', maxGrams: 500, price: { economy: 245, standard: 325, express: 645, sameday: 1295 } },
  { id: 'D2', maxGrams: 2000, price: { economy: 345, standard: 425, express: 745, sameday: 1395 } },
];

export const BANDS: Record<PackageKind, Band[]> = {
  parcel: PARCEL_BANDS,
  pallet: PALLET_BANDS,
  document: DOCUMENT_BANDS,
};

/** origin-destination market multiplier, in basis points of the GB card */
export const LANE_MULTIPLIER: Record<string, number> = {
  'GB-GB': 10000,
  'GB-FR': 16500,
  'GB-NL': 16000,
  'GB-DE': 16500,
  'FR-FR': 11500,
  'FR-GB': 17000,
  'NL-NL': 10500,
  'NL-GB': 16500,
  'NL-DE': 12000,
  'FR-NL': 13000,
};

export const TRANSIT_DAYS: Record<ServiceLevel, number> = { economy: 4, standard: 2, express: 1, sameday: 0 };
