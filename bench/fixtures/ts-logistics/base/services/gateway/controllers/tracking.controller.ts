import type { RequestContext } from '../../../packages/core/src/index.ts';
import { json, unauthorized } from '../../../packages/core/src/index.ts';
import type { ShipmentService } from '../../../packages/shipping/src/index.ts';
import type { TrackingService } from '../../../packages/tracking/src/index.ts';

/** GET /v2/shipments/:id/tracking */
export async function getTracking(ctx: RequestContext): Promise<void> {
  if (!ctx.tenant) throw unauthorized();
  const shipment = await ctx.services.get<ShipmentService>('shipping.shipments').get(ctx.tenant, ctx.params.id);
  const tracking = ctx.services.get<TrackingService>('tracking.service');
  if (ctx.query.get('refresh') === '1') await tracking.poll(shipment);
  json(ctx, 200, { shipmentId: shipment.id, status: shipment.status, events: tracking.history(shipment.id) });
}
