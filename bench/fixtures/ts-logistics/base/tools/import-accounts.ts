#!/usr/bin/env node
/**
 * One-off migration: converts monolith accounts (config/accounts.legacy.json)
 * into gateway tenant records. Prints JSON; review before pasting into
 * config/tenants.json.
 */
import { join } from 'node:path';
import { findRoot } from '../packages/core/src/index.ts';
import { loadAccounts, resolveTenant } from '../packages/core/src/tenant/resolveTenant.ts';

const PROFILE_FOR_TARIFF: Record<string, string> = {
  T2019: 'standard',
  'T2019-C': 'contract',
  'T2019-EU': 'standard',
};

export function convert(root: string): unknown[] {
  const accounts = loadAccounts(join(root, 'config', 'accounts.legacy.json'));
  return accounts.map((a) => {
    const t = resolveTenant({ 'x-kestrel-account': a.account }, accounts);
    if (!t) throw new Error(`account ${a.account} did not resolve`);
    return {
      id: `tn_${a.name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12)}`,
      name: t.name,
      market: t.market,
      currency: t.currency,
      pricingProfile: PROFILE_FOR_TARIFF[a.tariff] ?? 'standard',
      apiKeys: [],
      scopes: t.scopes,
    };
  });
}

if (import.meta.main) {
  console.log(JSON.stringify(convert(findRoot(process.cwd())), null, 2));
}
