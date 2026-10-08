// Money is always an integer number of minor units (cents, pence, yen) plus an
// ISO 4217 currency code. Never store or compute balances with floats.

export const SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP", "CHF", "JPY"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

const MINOR_DIGITS: Record<Currency, number> = { USD: 2, EUR: 2, GBP: 2, CHF: 2, JPY: 0 };

export interface Money {
  amountMinor: number;
  currency: Currency;
}

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export function minorDigits(currency: Currency): number {
  return MINOR_DIGITS[currency];
}

/**
 * Parse a decimal amount string such as "12.5", "1200" or "0.99" into minor
 * units. Returns null when the string is not a plain non-negative decimal or
 * has more fractional digits than the currency allows.
 */
export function parseAmount(input: string, currency: Currency): number | null {
  const trimmed = input.trim();
  const digits = MINOR_DIGITS[currency];
  const match = /^(\d{1,12})(?:\.(\d+))?$/.exec(trimmed);
  if (!match) return null;
  const whole = match[1] ?? "0";
  const frac = match[2] ?? "";
  if (frac.length > digits) return null;
  const minor = Number(whole) * 10 ** digits + Number(frac.padEnd(digits, "0") || "0");
  return Number.isSafeInteger(minor) ? minor : null;
}

/** "12.50", "-3.00", "1500" (JPY). No grouping separators, no symbol. */
export function formatDecimal(amountMinor: number, currency: Currency): string {
  const digits = MINOR_DIGITS[currency];
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor);
  if (digits === 0) return `${sign}${abs}`;
  const factor = 10 ** digits;
  const whole = Math.floor(abs / factor);
  const frac = String(abs % factor).padStart(digits, "0");
  return `${sign}${whole}.${frac}`;
}

const formatters = new Map<Currency, Intl.NumberFormat>();

/** Human readable: "$1,234.56", "€12.00", "¥1,500". */
export function formatMoney(amountMinor: number, currency: Currency): string {
  let fmt = formatters.get(currency);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: MINOR_DIGITS[currency],
      maximumFractionDigits: MINOR_DIGITS[currency],
    });
    formatters.set(currency, fmt);
  }
  return fmt.format(amountMinor / 10 ** MINOR_DIGITS[currency]);
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error(`Cannot add ${a.currency} and ${b.currency}`);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function sumByCurrency(items: readonly Money[]): Map<Currency, number> {
  const totals = new Map<Currency, number>();
  for (const item of items) {
    totals.set(item.currency, (totals.get(item.currency) ?? 0) + item.amountMinor);
  }
  return totals;
}
