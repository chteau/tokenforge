import type { Logger, Middleware } from '../../../packages/core/src/index.ts';
import { HttpError, json } from '../../../packages/core/src/index.ts';

export const errorHandler: Middleware = async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    if (err instanceof HttpError) {
      json(ctx, err.status, { error: { code: err.code, message: err.message, details: err.details }, requestId: ctx.requestId });
      return;
    }
    const logger = ctx.services.get<Logger>('core.logger');
    logger.error('unhandled error', { requestId: ctx.requestId, err: err instanceof Error ? err.stack : String(err) });
    json(ctx, 500, { error: { code: 'internal', message: 'internal error' }, requestId: ctx.requestId });
  }
};
