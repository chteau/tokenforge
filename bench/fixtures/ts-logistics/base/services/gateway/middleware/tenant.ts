import type { RequestContext, Next } from '../../../packages/core/src/index.ts';
import { unauthorized, forbidden } from '../../../packages/core/src/index.ts';
import type { TenantDirectory } from '../tenants.ts';

function apiKeyFrom(headers: Record<string, string>): string | undefined {
  if (headers['x-api-key']) return headers['x-api-key'];
  const auth = headers['authorization'];
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return undefined;
}

/**
 * Identifies the calling tenant from its API key and attaches the tenant
 * context used by every downstream service (market, currency, pricing
 * profile, scopes).
 */
export async function resolveTenant(ctx: RequestContext, next: Next): Promise<void> {
  const key = apiKeyFrom(ctx.headers);
  if (!key) throw unauthorized();
  const directory = ctx.services.get<TenantDirectory>('gateway.tenants');
  const record = directory.findByApiKey(key);
  if (!record) throw unauthorized();

  let pricingProfile = record.pricingProfile;
  const requested = ctx.headers['x-pricing-profile'];
  if (requested) {
    // only internal tenants may price as another profile (ops tooling, support)
    if (!record.internal) throw forbidden('x-pricing-profile is restricted to internal callers');
    pricingProfile = requested;
  }

  ctx.tenant = {
    id: record.id,
    name: record.name,
    market: record.market,
    currency: record.currency,
    pricingProfile,
    scopes: record.scopes,
    internal: record.internal === true,
    ...(record.contractDiscountBps ? { contractDiscountBps: record.contractDiscountBps } : {}),
  };
  ctx.state.tenantId = record.id;
  await next();
}
