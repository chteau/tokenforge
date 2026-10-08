import type { AppConfig, RequestContext } from '../../../packages/core/src/index.ts';
import { enabledFlags, json } from '../../../packages/core/src/index.ts';

const started = Date.now();

export async function health(ctx: RequestContext): Promise<void> {
  json(ctx, 200, { ok: true, uptimeSec: Math.round((Date.now() - started) / 1000) });
}

export async function ready(ctx: RequestContext): Promise<void> {
  const config = ctx.services.get<AppConfig>('core.config');
  json(ctx, 200, { ok: true, env: config.env, flags: enabledFlags(config) });
}
