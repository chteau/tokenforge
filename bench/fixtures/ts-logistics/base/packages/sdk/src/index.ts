import { Transport, type TransportOptions } from '../gen/transport.gen.ts';
import { QuotesClient } from '../gen/quotesClient.gen.ts';
import { ShipmentsClient } from '../gen/shipmentsClient.gen.ts';
import { TrackingClient } from '../gen/trackingClient.gen.ts';

export * from '../gen/models.gen.ts';
export { ApiRequestError, Transport } from '../gen/transport.gen.ts';
export type { TransportOptions } from '../gen/transport.gen.ts';

export class KestrelClient {
  readonly quotes: QuotesClient;
  readonly shipments: ShipmentsClient;
  readonly tracking: TrackingClient;

  constructor(opts: TransportOptions) {
    const t = new Transport(opts);
    this.quotes = new QuotesClient(t);
    this.shipments = new ShipmentsClient(t);
    this.tracking = new TrackingClient(t);
  }
}
