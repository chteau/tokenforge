import type { Address, LineItem, Parcel, ServiceLevel } from '../../../rates/src/index.ts';

export interface QuoteInput {
  origin: Address;
  destination: Address;
  parcels: Parcel[];
  service: ServiceLevel;
  reference?: string;
}

export type QuoteStatus = 'open' | 'accepted' | 'expired' | 'void';

export interface Quote {
  id: string;
  tenantId: string;
  status: QuoteStatus;
  createdAt: string;
  expiresAt: string;
  origin: Address;
  destination: Address;
  parcels: Parcel[];
  service: ServiceLevel;
  carrier: string;
  transitDays: number;
  currency: string;
  lineItems: LineItem[];
  total: number;
  pricingProfile: string;
  reference?: string;
}
