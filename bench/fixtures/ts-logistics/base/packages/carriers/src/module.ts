import type { AppConfig, Container } from '../../core/src/index.ts';
import { isEnabled } from '../../core/src/index.ts';
import { Bluefreight } from './adapters/bluefreight.ts';
import { NorthwindExpress } from './adapters/northwind.ts';
import { ParcelHop } from './adapters/parcelhop.ts';
import { PriorityCarrierSelector } from './select.ts';

export function registerCarriers(container: Container, config: AppConfig): void {
  container.register('carriers.adapters', () => [new ParcelHop(), new NorthwindExpress(), new Bluefreight()]);
  container.register(
    'carriers.selector',
    (c) => new PriorityCarrierSelector(c.get('carriers.adapters'), { failover: isEnabled(config, 'carrierFailover') }),
  );
}
