import type { AppConfig, Container, Handler, Router } from '../../../packages/core/src/index.ts';
import * as quotes from '../controllers/quotes.controller.ts';
import * as shipments from '../controllers/shipments.controller.ts';
import * as tracking from '../controllers/tracking.controller.ts';
import { health, ready } from '../controllers/health.controller.ts';
import { errorHandler } from '../middleware/errors.ts';
import { requestId } from '../middleware/requestId.ts';
import { resolveTenant } from '../middleware/tenant.ts';
import { requireScope } from '../middleware/auth.ts';
import { rateLimit } from '../middleware/rateLimit.ts';
import { V2_ROUTES } from './v2.ts';

const CONTROLLERS: Record<string, Record<string, unknown>> = { quotes, shipments, tracking };

function lookup(action: string): Handler {
  const [controller, fn] = action.split('.');
  const h = CONTROLLERS[controller]?.[fn];
  if (typeof h !== 'function') throw new Error(`route action ${action} does not exist`);
  return h as Handler;
}

/**
 * Builds the gateway's routing table. Order matters: error handling and
 * request ids wrap everything; tenant resolution and rate limiting apply to
 * the versioned API only.
 */
export function mountRoutes(router: Router, _container: Container, config: AppConfig): Router {
  router.use(errorHandler);
  router.use(requestId);

  router.get('/healthz', health);
  router.get('/readyz', ready);

  router.use('/v2', resolveTenant);
  router.use('/v2', rateLimit({ capacity: config.env === 'test' ? 1000 : 60, refillPerSec: config.env === 'test' ? 1000 : 10 }));
  for (const r of V2_ROUTES) {
    router.route(r.method, `/v2${r.path}`, lookup(r.action), r.scope ? [requireScope(r.scope)] : []);
  }
  return router;
}
