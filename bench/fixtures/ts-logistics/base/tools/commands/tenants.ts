import { findRoot } from '../../packages/core/src/index.ts';
import { TenantDirectory } from '../../services/gateway/tenants.ts';

export async function runTenants(_args: string[], out: (l: string) => void): Promise<number> {
  const dir = TenantDirectory.fromFile(findRoot(process.cwd()));
  for (const t of dir.all()) out(`${t.id.padEnd(10)} ${t.market} ${t.currency} ${t.pricingProfile.padEnd(12)} ${t.name}`);
  return 0;
}
