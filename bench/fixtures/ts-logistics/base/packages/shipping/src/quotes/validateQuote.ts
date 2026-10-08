import { Checker, isCountry } from '../../../core/src/index.ts';
import type { QuoteInput } from './types.ts';

const SERVICES = ['economy', 'standard', 'express', 'sameday'] as const;
const KINDS = ['parcel', 'pallet', 'document'] as const;

export function validateQuoteInput(body: unknown): QuoteInput {
  const c = new Checker();
  if (!c.object(body, '$')) c.throwIfInvalid();
  const b = body as Record<string, unknown>;
  for (const side of ['origin', 'destination'] as const) {
    const a = b[side];
    if (c.object(a, side)) {
      const addr = a as Record<string, unknown>;
      c.require(isCountry(addr.country), `${side}.country`, 'must be an ISO 3166 alpha-2 code');
      c.string(addr.postcode, `${side}.postcode`, { min: 3, max: 10 });
      if (addr.residential !== undefined) c.require(typeof addr.residential === 'boolean', `${side}.residential`, 'must be a boolean');
    }
  }
  c.oneOf(b.service, 'service', SERVICES);
  if (!Array.isArray(b.parcels) || b.parcels.length === 0) {
    c.require(false, 'parcels', 'must be a non-empty array');
  } else {
    if (b.parcels.length > 20) c.require(false, 'parcels', 'at most 20 parcels per quote');
    b.parcels.forEach((p: unknown, i: number) => {
      if (!c.object(p, `parcels[${i}]`)) return;
      const parcel = p as Record<string, unknown>;
      c.oneOf(parcel.kind ?? 'parcel', `parcels[${i}].kind`, KINDS);
      c.number(parcel.weightGrams, `parcels[${i}].weightGrams`, { min: 1, max: 1_000_000, integer: true });
    });
    const kinds = new Set((b.parcels as Array<Record<string, unknown>>).map((p) => p.kind ?? 'parcel'));
    c.require(kinds.size <= 1, 'parcels', 'all parcels in a quote must be the same kind');
  }
  if (b.reference !== undefined) c.string(b.reference, 'reference', { max: 64 });
  c.throwIfInvalid('quote request is invalid');
  const parcels = (b.parcels as Array<Record<string, unknown>>).map((p) => ({ ...p, kind: p.kind ?? 'parcel' }));
  return { ...(b as unknown as QuoteInput), parcels: parcels as unknown as QuoteInput['parcels'] };
}
