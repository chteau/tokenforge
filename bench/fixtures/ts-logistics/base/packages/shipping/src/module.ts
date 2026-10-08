import type { AppConfig, Clock, Container, EventBus, Logger, Store } from '../../core/src/index.ts';
import type { AdjusterRegistry, RateCalculator } from '../../rates/src/index.ts';
import type { CarrierSelector } from '../../carriers/src/index.ts';
import { QuoteRepository } from './quotes/QuoteRepository.ts';
import { QuoteService } from './quotes/QuoteService.ts';
import { ShipmentRepository } from './shipments/ShipmentRepository.ts';
import { ShipmentService } from './shipments/ShipmentService.ts';

export function registerShipping(container: Container, config: AppConfig): void {
  container.register('shipping.quoteRepository', (c) => new QuoteRepository(c.get<Store>('core.store')));
  container.register(
    'shipping.quotes',
    (c) =>
      new QuoteService({
        calculator: c.get<RateCalculator>('rates.calculator'),
        adjusters: c.get<AdjusterRegistry>('rates.adjusters'),
        repo: c.get<QuoteRepository>('shipping.quoteRepository'),
        bus: c.get<EventBus>('core.bus'),
        clock: c.get<Clock>('core.clock'),
        rates: config.rates,
        logger: c.get<Logger>('core.logger').child({ component: 'quotes' }),
      }),
  );
  container.register('shipping.shipmentRepository', (c) => new ShipmentRepository(c.get<Store>('core.store')));
  container.register(
    'shipping.shipments',
    (c) =>
      new ShipmentService({
        quotes: c.get<QuoteService>('shipping.quotes'),
        repo: c.get<ShipmentRepository>('shipping.shipmentRepository'),
        carriers: c.get<CarrierSelector>('carriers.selector'),
        bus: c.get<EventBus>('core.bus'),
        clock: c.get<Clock>('core.clock'),
        customs: config.customs,
      }),
  );
}
