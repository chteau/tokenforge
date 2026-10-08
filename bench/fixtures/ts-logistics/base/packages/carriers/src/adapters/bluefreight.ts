import { SimulatedCarrier } from './base.ts';
import type { SelectionRequest } from '../types.ts';

export class Bluefreight extends SimulatedCarrier {
  readonly code = 'BLF';
  readonly name = 'Bluefreight';
  readonly markets = ['GB', 'FR', 'NL', 'DE'];
  maxGrams = 1000000;

  supports(req: SelectionRequest): boolean {
    // Bluefreight does not run same-day anywhere
    return req.service !== 'sameday' && super.supports(req);
  }

  protected script() {
    return [
      { status: '10', location: 'shipper' },
      { status: '20', location: 'origin terminal' },
      { status: '35', location: 'linehaul' },
      { status: '50', location: 'destination terminal' },
      { status: '60', location: 'out for delivery' },
    ];
  }
}
