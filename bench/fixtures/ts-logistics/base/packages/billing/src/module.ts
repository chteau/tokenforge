import type { AppConfig, Clock, Container, EventBus, Store } from '../../core/src/index.ts';
import type { ShipmentRepository } from '../../shipping/src/index.ts';
import { InvoiceRepository } from './InvoiceRepository.ts';
import { InvoiceService } from './InvoiceService.ts';

export function registerBilling(container: Container, config: AppConfig): void {
  container.register('billing.invoiceRepository', (c) => new InvoiceRepository(c.get<Store>('core.store')));
  container.register(
    'billing.invoices',
    (c) =>
      new InvoiceService({
        shipments: c.get<ShipmentRepository>('shipping.shipmentRepository'),
        invoices: c.get<InvoiceRepository>('billing.invoiceRepository'),
        bus: c.get<EventBus>('core.bus'),
        clock: c.get<Clock>('core.clock'),
        vatBps: config.billing.vatBps,
      }),
  );
}
