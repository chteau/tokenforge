import { SimulatedCarrier } from './base.ts';

export class NorthwindExpress extends SimulatedCarrier {
  readonly code = 'NWX';
  readonly name = 'Northwind Express';
  readonly markets = ['GB', 'NL', 'DE'];
  maxGrams = 30000;

  protected trackingPrefix(): string {
    return 'NW';
  }

  protected script() {
    return [
      { status: 'MAN', location: 'origin' },
      { status: 'COL', location: 'origin depot' },
      { status: 'HUB', location: 'Daventry hub' },
      { status: 'OFD', location: 'destination depot' },
    ];
  }
}
