import type { BookingRequest, BookingResult, CarrierAdapter, CarrierEvent, SelectionRequest } from '../types.ts';

/** Shared behaviour for the in-house simulated carrier adapters. */
export abstract class SimulatedCarrier implements CarrierAdapter {
  abstract readonly code: string;
  abstract readonly name: string;
  abstract readonly markets: string[];
  abstract maxGrams: number;
  protected booked = new Map<string, { req: BookingRequest; at: Date }>();
  protected counter = 0;

  supports(req: SelectionRequest): boolean {
    const [o, d] = req.lane.split('-');
    return this.markets.includes(o) && this.markets.includes(d) && req.grams <= this.maxGrams;
  }

  protected trackingPrefix(): string {
    return this.code;
  }

  async book(req: BookingRequest): Promise<BookingResult> {
    this.counter += 1;
    const trackingNumber = `${this.trackingPrefix()}${String(100000000 + this.counter)}`;
    const at = new Date();
    this.booked.set(trackingNumber, { req, at });
    return {
      carrier: this.code,
      trackingNumber,
      labelUrl: `https://labels.kestrel-freight.example/${this.code.toLowerCase()}/${trackingNumber}.pdf`,
      bookedAt: at.toISOString(),
    };
  }

  async fetchEvents(trackingNumber: string): Promise<CarrierEvent[]> {
    const b = this.booked.get(trackingNumber);
    if (!b) return [];
    const steps = this.script();
    return steps.map((s, i) => ({
      trackingNumber,
      at: new Date(b.at.getTime() + i * 3_600_000).toISOString(),
      status: s.status,
      location: s.location,
      raw: { code: s.status, seq: i },
    }));
  }

  /** carrier-specific raw status script used by the simulator */
  protected abstract script(): Array<{ status: string; location?: string }>;
}
