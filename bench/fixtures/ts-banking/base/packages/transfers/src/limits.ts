import type { User } from "../../auth/src/types.ts";
import { DomainError } from "../../shared/src/errors.ts";
import { startOfLocalDay } from "../../shared/src/dates.ts";
import { type Currency, formatMoney } from "../../shared/src/money.ts";
import type { TransferRepository } from "./types.ts";

/** Default per-customer daily outgoing limit, per currency, in minor units. */
export const DEFAULT_DAILY_LIMITS: Record<Currency, number> = {
  USD: 5_000_00,
  EUR: 5_000_00,
  GBP: 4_000_00,
  CHF: 5_000_00,
  JPY: 700_000,
};

export function dailyLimitFor(user: User, currency: Currency): number {
  return user.dailyTransferLimits[currency] ?? DEFAULT_DAILY_LIMITS[currency];
}

/**
 * Amount already sent today. "Today" is the calendar day in the customer's
 * profile time zone, so the limit resets at local midnight.
 */
export function usedToday(transfers: TransferRepository, user: User, currency: Currency, now: Date): number {
  const since = startOfLocalDay(now, user.timezone);
  return transfers.listCompletedByUserSince(user.id, currency, since).reduce((sum, t) => sum + t.amountMinor, 0);
}

export function remainingToday(transfers: TransferRepository, user: User, currency: Currency, now: Date): number {
  return Math.max(dailyLimitFor(user, currency) - usedToday(transfers, user, currency, now), 0);
}

export function assertWithinDailyLimit(
  transfers: TransferRepository,
  user: User,
  currency: Currency,
  amountMinor: number,
  now: Date,
): void {
  const remaining = remainingToday(transfers, user, currency, now);
  if (amountMinor > remaining) {
    throw new DomainError("DAILY_LIMIT_EXCEEDED", `Daily transfer limit exceeded; ${formatMoney(remaining, currency)} remaining today`, [
      { field: "amount", message: "exceeds your remaining daily limit", remainingMinor: remaining },
    ]);
  }
}
