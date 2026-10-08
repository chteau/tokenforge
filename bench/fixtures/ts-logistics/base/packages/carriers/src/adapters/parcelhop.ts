import { SimulatedCarrier } from './base.ts';
import type { SelectionRequest } from '../types.ts';

export class ParcelHop extends SimulatedCarrier {
  readonly code = 'PHP';
  readonly name = 'ParcelHop';
  readonly markets = ['GB'];
  maxGrams = 15000;

  supports(req: SelectionRequest): boolean {
    return req.kind !== 'pallet' && super.supports(req);
  }

  protected script() {
    return [
      { status: 'created' },
      { status: 'picked_up', location: 'sender' },
      { status: 'sorted', location: 'Birmingham sort' },
      { status: 'with_courier' },
    ];
  }
}
