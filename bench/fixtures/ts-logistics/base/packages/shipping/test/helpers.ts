import { join } from 'node:path';
import { Container, EventBus, JsonlStore, fixedClock, loadConfig, silentLogger, type AppConfig } from '../../core/src/index.ts';
import { registerCarriers } from '../../carriers/src/index.ts';
import { registerRates } from '../../rates/src/index.ts';
import { registerShipping } from '../src/index.ts';

export const root = join(import.meta.dirname, '..', '..', '..');

export function container(opts: { now?: string; overrides?: Record<string, unknown> } = {}): { c: Container; config: AppConfig } {
  const config = loadConfig({ root, env: 'test', processEnv: {}, overrides: opts.overrides });
  const c = new Container();
  c.value('core.logger', silentLogger);
  c.value('core.clock', fixedClock(opts.now ?? '2026-03-10T09:00:00Z'));
  c.value('core.store', new JsonlStore(':memory:'));
  c.value('core.bus', new EventBus());
  registerCarriers(c, config);
  registerRates(c, config);
  registerShipping(c, config);
  return { c, config };
}

export const ACME = {
  id: 'tn_acme',
  name: 'Acme',
  market: 'GB',
  currency: 'GBP',
  pricingProfile: 'standard',
  scopes: ['*'],
  internal: false,
};
