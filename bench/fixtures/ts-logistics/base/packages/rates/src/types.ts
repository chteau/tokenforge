import type { RatesConfig, TenantContext } from '../../core/src/index.ts';

export type ServiceLevel = 'economy' | 'standard' | 'express' | 'sameday';
export type PackageKind = 'parcel' | 'pallet' | 'document';

export interface Dimensions {
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

export interface Parcel {
  kind: PackageKind;
  weightGrams: number;
  dimensions?: Dimensions;
  declaredValue?: number;
}

export interface Address {
  country: string;
  postcode: string;
  city?: string;
  line1?: string;
  residential?: boolean;
}

export interface LineItem {
  code: string;
  label: string;
  amount: number;
  /** internal: which adjuster produced the line, kept for audits */
  source?: string;
}

export interface BaseRate {
  carrier: string;
  service: ServiceLevel;
  chargeableGrams: number;
  band: string;
  amount: number;
  currency: string;
  transitDays: number;
}

export interface AdjustContext {
  tenant: TenantContext & { contractDiscountBps?: number };
  origin: Address;
  destination: Address;
  parcels: Parcel[];
  base: BaseRate;
  /** sum of base amounts, the figure percentage adjusters apply to */
  subtotal: number;
  currency: string;
  locale: string;
  rates: RatesConfig;
  now: Date;
}

export type Adjuster = (ctx: AdjustContext) => LineItem[];
