import { join } from 'node:path';
import { silentLogger } from '../../../packages/core/src/index.ts';
import { start, type Gateway } from '../main.ts';

export const root = join(import.meta.dirname, '..', '..', '..');

export const KEYS = {
  acme: 'kf_live_acme_7f3e',
  fjord: 'kf_live_fjord_19aa',
  lumen: 'kf_live_lumen_c210',
  polder: 'kf_live_polder_88b0',
  ops: 'kf_internal_ops_0001',
};

export async function startTestGateway(overrides: Record<string, unknown> = {}): Promise<Gateway> {
  return start({ root, env: 'test', logger: silentLogger, overrides });
}

export async function call(g: Gateway, method: string, path: string, opts: { key?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(g.url + path, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.key ? { 'x-api-key': opts.key } : {}), ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

export function quoteBody(destination: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    origin: { country: 'GB', postcode: 'B1 1AA' },
    destination,
    parcels: [{ weightGrams: 2500 }],
    service: 'standard',
    ...extra,
  };
}
