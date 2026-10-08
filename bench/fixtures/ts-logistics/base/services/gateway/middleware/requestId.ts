import type { Middleware } from '../../../packages/core/src/index.ts';
import { shortId } from '../../../packages/core/src/index.ts';

export const requestId: Middleware = async (ctx, next) => {
  const incoming = ctx.headers['x-request-id'];
  ctx.requestId = incoming && /^[\w-]{6,64}$/.test(incoming) ? incoming : `req_${shortId(8)}`;
  ctx.responseHeaders['x-request-id'] = ctx.requestId;
  await next();
};
