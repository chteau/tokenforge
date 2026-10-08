/**
 * Public API v2 route table. `action` is `<controller>.<export>`; the
 * controller modules are wired in routes/index.ts.
 */
export interface RouteSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  action: string;
  scope?: string;
}

export const V2_ROUTES: RouteSpec[] = [
  { method: 'POST', path: '/quotes', action: 'quotes.postQuote', scope: 'quotes:write' },
  { method: 'GET', path: '/quotes', action: 'quotes.listQuotes', scope: 'quotes:read' },
  { method: 'GET', path: '/quotes/:id', action: 'quotes.getQuote', scope: 'quotes:read' },
  { method: 'POST', path: '/quotes/:id/accept', action: 'quotes.acceptQuote', scope: 'quotes:write' },
  { method: 'POST', path: '/shipments', action: 'shipments.postShipment', scope: 'shipments:write' },
  { method: 'GET', path: '/shipments/:id', action: 'shipments.getShipment', scope: 'shipments:read' },
  { method: 'POST', path: '/shipments/:id/cancel', action: 'shipments.cancelShipment', scope: 'shipments:write' },
  { method: 'POST', path: '/shipments/:id/release-hold', action: 'shipments.releaseHold', scope: 'shipments:write' },
  { method: 'GET', path: '/shipments/:id/tracking', action: 'tracking.getTracking', scope: 'tracking:read' },
];
