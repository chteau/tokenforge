import type { Middleware } from '../../../packages/core/src/index.ts';
import { tooMany } from '../../../packages/core/src/index.ts';

/** Per-tenant token bucket. Internal tenants are not limited. */
export function rateLimit(opts: { capacity: number; refillPerSec: number; now?: () => number }): Middleware {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const now = opts.now ?? (() => Date.now());
  return async (ctx, next) => {
    const t = ctx.tenant;
    if (!t || t.internal) return next();
    const ts = now();
    const b = buckets.get(t.id) ?? { tokens: opts.capacity, at: ts };
    b.tokens = Math.min(opts.capacity, b.tokens + ((ts - b.at) / 1000) * opts.refillPerSec);
    b.at = ts;
    if (b.tokens < 1) {
      buckets.set(t.id, b);
      throw tooMany();
    }
    b.tokens -= 1;
    buckets.set(t.id, b);
    ctx.responseHeaders['x-ratelimit-remaining'] = String(Math.floor(b.tokens));
    await next();
  };
}
