import type { Container, PricingConfig } from '../../core/src/index.ts';
import type { Adjuster } from './types.ts';

export class UnknownProfile extends Error {}

/**
 * Maps a tenant pricing profile to the ordered list of adjusters to run.
 * Profiles live in config (pricing.profiles); each entry is a container key
 * registered by registerRates().
 */
export class AdjusterRegistry {
  private readonly pricing: PricingConfig;
  private readonly container: Container;
  private cache = new Map<string, Adjuster[]>();

  constructor(pricing: PricingConfig, container: Container) {
    this.pricing = pricing;
    this.container = container;
  }

  profiles(): string[] {
    return Object.keys(this.pricing.profiles).sort();
  }

  resolve(profile: string | undefined): Adjuster[] {
    const name = profile && profile in this.pricing.profiles ? profile : this.pricing.defaultProfile;
    const hit = this.cache.get(name);
    if (hit) return hit;
    const keys = this.pricing.profiles[name];
    if (!keys) throw new UnknownProfile(`pricing profile ${name} is not configured`);
    const chain = keys.map((key) => {
      const adj = this.container.get<Adjuster>(key);
      if (typeof adj !== 'function') throw new Error(`${key} is not an adjuster`);
      return adj;
    });
    this.cache.set(name, chain);
    return chain;
  }

  describe(profile: string): string[] {
    return (this.pricing.profiles[profile] ?? []).slice();
  }
}
