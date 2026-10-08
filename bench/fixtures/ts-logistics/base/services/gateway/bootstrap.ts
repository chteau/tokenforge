import type { AppConfig } from '../../packages/core/src/index.ts';
import { Container, EventBus, JsonlStore, createLogger, systemClock, type Logger } from '../../packages/core/src/index.ts';
import { registerCarriers } from '../../packages/carriers/src/index.ts';
import { registerRates } from '../../packages/rates/src/index.ts';
import { registerShipping } from '../../packages/shipping/src/index.ts';
import { registerTracking } from '../../packages/tracking/src/index.ts';
import { registerBilling } from '../../packages/billing/src/index.ts';
import { registerNotify } from '../../packages/notify/src/index.ts';
import { TenantDirectory } from './tenants.ts';

type Registrar = (c: Container, config: AppConfig) => void;

/** Package registrars, in dependency order. */
const MODULES: Array<[string, Registrar]> = [
  ['carriers', registerCarriers],
  ['rates', registerRates],
  ['shipping', registerShipping],
  ['tracking', registerTracking],
  ['billing', registerBilling],
  ['notify', registerNotify],
];

export interface BuildOptions {
  root: string;
  logger?: Logger;
  /** pre-registered services that win over the defaults (tests) */
  overrides?: (c: Container) => void;
}

export function buildContainer(config: AppConfig, opts: BuildOptions): Container {
  const c = new Container();
  const logger = opts.logger ?? createLogger({ base: { svc: 'gateway' } });
  c.value('core.config', config);
  c.value('core.logger', logger);
  c.value('core.clock', systemClock);
  c.register('core.store', () => new JsonlStore(config.storage.dataDir));
  c.register('core.bus', (k) => new EventBus({ onError: (err, e) => k.get<Logger>('core.logger').error('listener failed', { type: e.type, err: String(err) }) }));
  c.register('gateway.tenants', () => TenantDirectory.fromFile(opts.root));
  for (const [name, register] of MODULES) {
    register(c, config);
    logger.debug('module registered', { module: name });
  }
  opts.overrides?.(c);
  return c;
}
