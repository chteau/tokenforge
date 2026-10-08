/** Amounts are integers in minor units (pence, cents). */
export interface Money {
  amount: number;
  currency: string;
}

export const MINOR_UNITS: Record<string, number> = { GBP: 2, EUR: 2, USD: 2, SEK: 2, NOK: 2, JPY: 0 };

export function money(amount: number, currency: string): Money {
  if (!Number.isInteger(amount)) throw new Error(`money amount must be an integer, got ${amount}`);
  return { amount, currency };
}

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error(`currency mismatch ${a.currency}/${b.currency}`);
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function sum(items: Money[], currency: string): Money {
  return items.reduce((acc, m) => add(acc, m), money(0, currency));
}

/** Banker's rounding of value * bps / 10000. */
export function applyBps(amount: number, bps: number): number {
  const raw = (amount * bps) / 10000;
  const floor = Math.floor(raw);
  const diff = raw - floor;
  if (Math.abs(diff - 0.5) < 1e-9) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(raw);
}

export function format(m: Money, locale = 'en-GB'): string {
  const digits = MINOR_UNITS[m.currency] ?? 2;
  const value = m.amount / 10 ** digits;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: m.currency }).format(value);
}

export function fromDecimal(value: number, currency: string): Money {
  const digits = MINOR_UNITS[currency] ?? 2;
  return money(Math.round(value * 10 ** digits), currency);
}
