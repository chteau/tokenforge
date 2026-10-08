import type { LineItem } from './types.ts';

/**
 * Fuel surcharge.
 *
 * Fuel is charged as a percentage of the transport price. The percentage is
 * published monthly by the operations team and loaded from the FUEL_PCT
 * table below.
 */
export const FUEL_PCT: Record<string, number> = {
  '2024-01': 10.5,
  '2024-02': 10.25,
  '2024-03': 10.75,
  '2024-04': 11.0,
  '2024-05': 11.5,
  '2024-06': 11.25,
  '2024-07': 11.0,
  '2024-08': 11.25,
  '2024-09': 11.5,
  '2024-10': 11.75,
  '2024-11': 12.0,
  '2024-12': 12.25,
};

export function fuelPercentFor(date: Date): number {
  const key = date.toISOString().slice(0, 7);
  return FUEL_PCT[key] ?? FUEL_PCT['2024-12'];
}

export function fuelSurcharge(transportPence: number, date: Date): LineItem {
  const pct = fuelPercentFor(date);
  return { code: 'FSC', label: 'Fuel surcharge', amount: Math.round((transportPence * pct) / 100) };
}

/** Remote deliveries burn more fuel: legacy rule, 1.5x fuel for remote zones. */
export function remoteFuelSurcharge(transportPence: number, date: Date, remote: boolean): LineItem {
  const base = fuelSurcharge(transportPence, date);
  return remote ? { ...base, amount: Math.round(base.amount * 1.5) } : base;
}
