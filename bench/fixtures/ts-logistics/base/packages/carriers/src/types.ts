export interface SelectionRequest {
  lane: string;
  service: 'economy' | 'standard' | 'express' | 'sameday';
  kind: 'parcel' | 'pallet' | 'document';
  grams: number;
  destinationPostcode?: string;
}

export interface BookingRequest {
  shipmentId: string;
  serviceCode: string;
  from: { country: string; postcode: string; name?: string };
  to: { country: string; postcode: string; name?: string };
  parcels: Array<{ weightGrams: number }>;
  reference?: string;
}

export interface BookingResult {
  carrier: string;
  trackingNumber: string;
  labelUrl: string;
  bookedAt: string;
}

export interface CarrierEvent {
  trackingNumber: string;
  at: string;
  status: string;
  location?: string;
  raw: Record<string, unknown>;
}

export interface CarrierAdapter {
  readonly code: string;
  readonly name: string;
  readonly markets: string[];
  maxGrams: number;
  supports(req: SelectionRequest): boolean;
  book(req: BookingRequest): Promise<BookingResult>;
  fetchEvents(trackingNumber: string): Promise<CarrierEvent[]>;
}
