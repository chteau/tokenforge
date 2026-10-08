import { lookupTariff } from './tariffTable.ts';
import { outOfHoursSurcharge, remoteAreaSurcharge } from './surcharge.ts';

export interface TariffQuoteRequest {
  account: string;
  tariff: string;
  weightKg: number;
  postcode: string;
  outOfHours?: boolean;
}

export interface TariffQuote {
  account: string;
  tariff: string;
  lines: Array<{ code: string; text: string; pence: number }>;
  totalPence: number;
}

export function quoteWithTariff(req: TariffQuoteRequest): TariffQuote {
  const base = lookupTariff(req.tariff, req.weightKg);
  const lines = [{ code: 'BAS', text: 'Carriage', pence: base }];
  const remote = remoteAreaSurcharge(base, req.postcode);
  if (remote > 0) lines.push({ code: 'RAS', text: 'Remote area surcharge', pence: remote });
  const ooh = outOfHoursSurcharge(Boolean(req.outOfHours));
  if (ooh > 0) lines.push({ code: 'OOH', text: 'Out of hours', pence: ooh });
  return { account: req.account, tariff: req.tariff, lines, totalPence: lines.reduce((a, l) => a + l.pence, 0) };
}
