import type { AppConfig, Container } from '../../core/src/index.ts';
import { isEnabled, type FlagName } from '../../core/src/index.ts';
import { contractDiscount, fuelIndexAdjustment, peakSeasonAdjustment, zoneUplift } from './adjustments.ts';
import { residentialSurcharge } from './surcharge.ts';
import { zoneUpliftV2 } from './zones/zoneEngineV2.ts';
import { RateCalculator } from './RateCalculator.ts';
import { AdjusterRegistry } from './registry.ts';
import type { Adjuster } from './types.ts';
import type { CarrierSelector } from '../../carriers/src/index.ts';

interface AdjusterSpec {
  impl: Adjuster;
  /** replacement implementation used when `flag` is enabled */
  next?: { flag: FlagName; impl: Adjuster };
}

/** Adjusters available to pricing profiles, registered as `adjuster.<name>`. */
const ADJUSTERS: Record<string, AdjusterSpec> = {
  fuel: { impl: fuelIndexAdjustment },
  zone: { impl: zoneUplift, next: { flag: 'zoneEngineV2', impl: zoneUpliftV2 } },
  residential: { impl: residentialSurcharge },
  peak: { impl: peakSeasonAdjustment },
  contractDiscount: { impl: contractDiscount },
};

export function registerRates(container: Container, config: AppConfig): void {
  for (const [name, spec] of Object.entries(ADJUSTERS)) {
    const impl = spec.next && isEnabled(config, spec.next.flag) ? spec.next.impl : spec.impl;
    container.value<Adjuster>(`adjuster.${name}`, impl);
  }
  container.register('rates.calculator', (c) => new RateCalculator(config.rates, c.get<CarrierSelector>('carriers.selector')));
  container.register('rates.adjusters', (c) => new AdjusterRegistry(config.pricing, c));
}

export function adjusterNames(): string[] {
  return Object.keys(ADJUSTERS);
}
