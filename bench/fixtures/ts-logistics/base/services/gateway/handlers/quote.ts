import type { Container, RequestContext } from '../../../packages/core/src/index.ts';
import { badRequest, json, newId } from '../../../packages/core/src/index.ts';
import { RateCalculator } from '../../../packages/pricing/src/index.ts';
import type { PriceRequest } from '../../../packages/pricing/src/index.ts';

const calculator = new RateCalculator();

/**
 * v1 quote handler: prices a single parcel with the pricing engine
 * (fuel, remote area surcharge, residential) and returns pence totals.
 */
export async function handleQuote(ctx: RequestContext, _container: Container): Promise<void> {
  const b = (ctx.body ?? {}) as Partial<PriceRequest>;
  if (typeof b.weightKg !== 'number' || typeof b.toPostcode !== 'string') throw badRequest('weightKg and toPostcode are required');
  const priced = calculator.calculate({ weightKg: b.weightKg, toPostcode: b.toPostcode, service: b.service ?? 'standard', residential: b.residential });
  json(ctx, 200, {
    quote_ref: newId('v1q'),
    lines: priced.lines.map((l) => ({ code: l.code, text: l.description, pence: l.pence })),
    total_pence: priced.totalPence,
  });
}
