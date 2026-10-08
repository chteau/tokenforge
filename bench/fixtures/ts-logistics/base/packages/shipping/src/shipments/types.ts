import type { Address, Parcel, ServiceLevel } from '../../../rates/src/index.ts';

export type ShipmentStatus = 'booked' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'exception' | 'cancelled';

export interface Shipment {
  id: string;
  tenantId: string;
  quoteId: string;
  status: ShipmentStatus;
  flags: string[];
  carrier: string;
  serviceCode: string;
  trackingNumber: string;
  labelUrl: string;
  origin: Address;
  destination: Address;
  parcels: Parcel[];
  service: ServiceLevel;
  total: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
  lastEventAt?: string;
}
