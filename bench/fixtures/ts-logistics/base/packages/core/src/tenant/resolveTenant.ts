import { readFileSync } from 'node:fs';
import type { TenantContext } from '../http/context.ts';

/**
 * Tenant lookup used by the original monolith. Resolves a tenant from the
 * `X-Kestrel-Account` header against the static accounts file.
 *
 * @deprecated superseded by the gateway tenant middleware; kept so that the
 * legacy batch importer (tools/import-accounts) keeps compiling.
 */
export interface LegacyAccount {
  account: string;
  name: string;
  country: string;
  tariff: string;
}

let cache: LegacyAccount[] | undefined;

export function loadAccounts(path: string): LegacyAccount[] {
  cache ??= JSON.parse(readFileSync(path, 'utf8')) as LegacyAccount[];
  return cache;
}

export function resolveTenant(headers: Record<string, string>, accounts: LegacyAccount[]): TenantContext | undefined {
  const id = headers['x-kestrel-account'];
  if (!id) return undefined;
  const acct = accounts.find((a) => a.account === id);
  if (!acct) return undefined;
  return {
    id: acct.account,
    name: acct.name,
    market: acct.country,
    currency: acct.country === 'GB' ? 'GBP' : 'EUR',
    // the monolith priced everything through the tariff tables
    pricingProfile: `tariff:${acct.tariff}`,
    scopes: ['quotes:write', 'shipments:write'],
    internal: false,
  };
}
