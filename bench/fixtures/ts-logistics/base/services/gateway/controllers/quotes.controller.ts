import type { RequestContext } from '../../../packages/core/src/index.ts';
import { json, unauthorized } from '../../../packages/core/src/index.ts';
import type { QuoteService } from '../../../packages/shipping/src/index.ts';
import { validateQuoteInput } from '../../../packages/shipping/src/index.ts';

function service(ctx: RequestContext): QuoteService {
  return ctx.services.get<QuoteService>('shipping.quotes');
}

function tenantOf(ctx: RequestContext) {
  if (!ctx.tenant) throw unauthorized();
  return ctx.tenant;
}

/** POST /v2/quotes */
export async function postQuote(ctx: RequestContext): Promise<void> {
  const tenant = tenantOf(ctx);
  const input = validateQuoteInput(ctx.body);
  const quote = await service(ctx).createQuote(input, tenant);
  json(ctx, 201, quote);
}

/** GET /v2/quotes/:id */
export async function getQuote(ctx: RequestContext): Promise<void> {
  json(ctx, 200, await service(ctx).getQuote(tenantOf(ctx), ctx.params.id));
}

/** GET /v2/quotes?status= */
export async function listQuotes(ctx: RequestContext): Promise<void> {
  const status = ctx.query.get('status') ?? undefined;
  json(ctx, 200, { data: await service(ctx).listQuotes(tenantOf(ctx), status) });
}

/** POST /v2/quotes/:id/accept */
export async function acceptQuote(ctx: RequestContext): Promise<void> {
  json(ctx, 200, await service(ctx).acceptQuote(tenantOf(ctx), ctx.params.id));
}
