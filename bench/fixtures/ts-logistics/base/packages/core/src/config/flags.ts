import type { AppConfig } from './loadConfig.ts';

/**
 * Feature flags. Flags default to off; a flag missing from config is treated
 * as disabled. Tenants may not toggle flags (see ADR-0007).
 */
export const KNOWN_FLAGS = [
  'zoneEngineV2',
  'carrierFailover',
  'asyncInvoices',
  'webhookSigning',
  'trackingPushIngest',
] as const;

export type FlagName = (typeof KNOWN_FLAGS)[number];

export function isEnabled(config: Pick<AppConfig, 'features'>, flag: FlagName): boolean {
  return config.features?.[flag] === true;
}

export function enabledFlags(config: Pick<AppConfig, 'features'>): FlagName[] {
  return KNOWN_FLAGS.filter((f) => isEnabled(config, f));
}
