import type { Container, RequestContext } from '../../../packages/core/src/index.ts';
import { json, notFound } from '../../../packages/core/src/index.ts';
import type { ShipmentRepository } from '../../../packages/shipping/src/index.ts';

export async function handleTrack(ctx: RequestContext, container: Container): Promise<void> {
  const repo = container.get<ShipmentRepository>('shipping.shipmentRepository');
  const s = await repo.byTracking(ctx.params.num);
  if (!s) throw notFound();
  json(ctx, 200, { tracking_number: s.trackingNumber, status: s.status.toUpperCase(), last_update: s.lastEventAt ?? s.createdAt });
}
