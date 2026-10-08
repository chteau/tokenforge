export interface PriceRequest {
  weightKg: number;
  toPostcode: string;
  toCountry?: string;
  service: 'economy' | 'standard' | 'express';
  residential?: boolean;
  monthlyVolume?: number;
}

export interface PriceLine {
  code: string;
  description: string;
  pence: number;
}

export interface PricedQuote {
  lines: PriceLine[];
  totalPence: number;
}
