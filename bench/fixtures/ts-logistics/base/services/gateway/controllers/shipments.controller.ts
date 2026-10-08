import type { RequestContext } from '../../../packages/core/src/index.ts';
import { badRequest, json, unauthorized } from '../../../packages/core/src/index.ts';
import type { ShipmentService } from '../../../packages/shipping/src/index.ts';

const svc = (ctx: RequestContext) => ctx.services.get<ShipmentService>('shipping.shipments');
const tenantOf = (ctx: RequestContext) => {
  if (!ctx.tenant) throw unauthorized();
  return ctx.tenant;
};

/** POST /v2/shipments  { quoteId, option? } */
export async function postShipment(ctx: RequestContext): Promise<void> {
  const body = (ctx.body ?? {}) as { quoteId?: unknown; option?: unknown };
  if (typeof body.quoteId !== 'string') throw badRequest('quoteId is required');
  const option = typeof body.option === 'string' ? body.option : undefined;
  json(ctx, 201, await svc(ctx).bookFromQuote(tenantOf(ctx), body.quoteId, { option }));
}

export async function getShipment(ctx: RequestContext): Promise<void> {
  json(ctx, 200, await svc(ctx).get(tenantOf(ctx), ctx.params.id));
}

export async function cancelShipment(ctx: RequestContext): Promise<void> {
  json(ctx, 200, await svc(ctx).cancel(tenantOf(ctx), ctx.params.id));
}

export async function releaseHold(ctx: RequestContext): Promise<void> {
  json(ctx, 200, await svc(ctx).releaseCustomsHold(tenantOf(ctx), ctx.params.id));
}
