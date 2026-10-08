import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Container } from '../di/container.ts';

export interface TenantContext {
  id: string;
  name: string;
  market: string;
  currency: string;
  pricingProfile: string;
  scopes: string[];
  internal: boolean;
}

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  requestId: string;
  tenant?: TenantContext;
  services: Container;
  state: Record<string, unknown>;
  status: number;
  responseBody: unknown;
  responseHeaders: Record<string, string>;
}

export type Next = () => Promise<void>;
export type Middleware = (ctx: RequestContext, next: Next) => Promise<void>;
export type Handler = (ctx: RequestContext) => Promise<void>;

export function json(ctx: RequestContext, status: number, body: unknown): void {
  ctx.status = status;
  ctx.responseBody = body;
  ctx.responseHeaders['content-type'] = 'application/json; charset=utf-8';
}
