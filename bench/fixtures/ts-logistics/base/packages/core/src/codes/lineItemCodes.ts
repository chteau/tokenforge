/**
 * External line item codes printed on quotes and invoices. Codes are part of
 * the public API contract (see sdk models) and must not be renamed.
 *
 * Keys are `<kind>:<variant>` as produced by the adjusters.
 */
export const LINE_ITEM_CODES: Record<string, string> = {
  'base:parcel': 'BAS',
  'base:pallet': 'BAP',
  'base:document': 'BAD',
  'fuel:index': 'FSC',
  'zone:A': 'ZNA',
  'zone:B': 'ZNB',
  'zone:R': 'RAS',
  'zone:X': 'XAS',
  'residential:flat': 'RES',
  'peak:season': 'PKS',
  'customs:clearance': 'CCF',
  'customs:duty': 'DTY',
  'insurance:declared': 'INS',
  'discount:contract': 'DSC',
  'tax:vat': 'VAT',
};

export function lineItemCode(kind: string, variant: string): string {
  const code = LINE_ITEM_CODES[`${kind}:${variant}`];
  if (!code) throw new Error(`unknown line item ${kind}:${variant}`);
  return code;
}

export function describeCode(code: string): string | undefined {
  return Object.entries(LINE_ITEM_CODES).find(([, c]) => c === code)?.[0];
}
