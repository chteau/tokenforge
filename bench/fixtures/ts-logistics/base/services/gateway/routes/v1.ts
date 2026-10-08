import type { Container, Router } from '../../../packages/core/src/index.ts';
import { handleQuote } from '../handlers/quote.ts';
import { handleTrack } from '../handlers/track.ts';

/**
 * API v1 (2021). Flat routes, account header auth, tariff-era pricing.
 *
 *   POST /v1/quote        -> handleQuote
 *   GET  /v1/track/:num   -> handleTrack
 */
export function registerV1Routes(router: Router, container: Container): Router {
  router.post('/v1/quote', (ctx) => handleQuote(ctx, container));
  router.get('/v1/track/:num', (ctx) => handleTrack(ctx, container));
  return router;
}
