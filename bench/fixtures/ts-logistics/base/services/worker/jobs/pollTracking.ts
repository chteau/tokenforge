import type { Container, Logger } from '../../../packages/core/src/index.ts';
import type { TrackingService } from '../../../packages/tracking/src/index.ts';

export async function pollTracking(container: Container): Promise<{ polled: number; updated: number }> {
  const res = await container.get<TrackingService>('tracking.service').pollAll();
  container.get<Logger>('core.logger').info('tracking poll', { polled: res.polled, updated: res.updated, stale: res.stale.length });
  return res;
}
