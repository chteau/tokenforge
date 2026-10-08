import type { Middleware } from '../../../packages/core/src/index.ts';
import { forbidden, unauthorized } from '../../../packages/core/src/index.ts';

export function requireScope(scope: string): Middleware {
  return async (ctx, next) => {
    if (!ctx.tenant) throw unauthorized();
    const scopes = ctx.tenant.scopes;
    if (!scopes.includes('*') && !scopes.includes(scope)) throw forbidden(`missing scope ${scope}`);
    await next();
  };
}
