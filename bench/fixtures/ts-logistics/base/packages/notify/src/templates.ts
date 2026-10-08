export interface Rendered {
  subject: string;
  text: string;
}

type Tpl = (p: Record<string, unknown>) => Rendered;

export const TEMPLATES: Record<string, Tpl> = {
  'shipment.booked': (p) => ({
    subject: `Shipment ${p.shipmentId} booked`,
    text: `Your shipment ${p.shipmentId} has been booked.${(p.flags as string[] | undefined)?.includes('HOLD_CUSTOMS') ? ' It is on hold until customs documents are uploaded.' : ''}`,
  }),
  'shipment.delivered': (p) => ({ subject: `Delivered: ${p.shipmentId}`, text: `Shipment ${p.shipmentId} was delivered at ${p.at}.` }),
  'shipment.exception': (p) => ({ subject: `Delivery problem: ${p.shipmentId}`, text: `The carrier reported an exception for ${p.shipmentId}.` }),
  'invoice.issued': (p) => ({ subject: `Invoice ${p.invoiceId}`, text: `A new invoice (${p.invoiceId}) is available.` }),
  'tracking.stale': (p) => ({ subject: 'Stale shipments', text: `No carrier updates for: ${(p.shipmentIds as string[]).join(', ')}` }),
};

export function render(type: string, payload: Record<string, unknown>): Rendered | undefined {
  return TEMPLATES[type]?.(payload);
}
