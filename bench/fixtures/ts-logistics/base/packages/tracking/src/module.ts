import type { AppConfig, Clock, Container, EventBus, Logger, Store } from '../../core/src/index.ts';
import type { CarrierSelector } from '../../carriers/src/index.ts';
import type { ShipmentRepository, ShipmentService } from '../../shipping/src/index.ts';
import { TrackingService } from './TrackingService.ts';

export function registerTracking(container: Container, config: AppConfig): void {
  container.register(
    'tracking.service',
    (c) =>
      new TrackingService({
        store: c.get<Store>('core.store'),
        shipments: c.get<ShipmentService>('shipping.shipments'),
        shipmentRepo: c.get<ShipmentRepository>('shipping.shipmentRepository'),
        carriers: c.get<CarrierSelector>('carriers.selector'),
        bus: c.get<EventBus>('core.bus'),
        clock: c.get<Clock>('core.clock'),
        logger: c.get<Logger>('core.logger').child({ component: 'tracking' }),
        staleAfterHours: config.tracking.staleAfterHours,
      }),
  );
}
