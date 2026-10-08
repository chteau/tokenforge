import type { AccountService } from "../../accounts/src/account-service.ts";
import type { Account } from "../../accounts/src/types.ts";
import type { Actor, UserRepository } from "../../auth/src/types.ts";
import type { Clock } from "../../shared/src/clock.ts";
import { notFound, validationError } from "../../shared/src/errors.ts";
import { formatLocalDate, zonedDateTimeToInstant } from "../../shared/src/dates.ts";
import { formatDecimal, formatMoney } from "../../shared/src/money.ts";
import type { LedgerEntry, LedgerRepository } from "../../transactions/src/types.ts";
import { signedAmount } from "../../transactions/src/types.ts";

export interface Statement {
  accountId: string;
  accountNumber: string;
  currency: Account["currency"];
  period: string; // YYYY-MM
  timezone: string;
  openingBalanceMinor: number;
  closingBalanceMinor: number;
  totalCreditsMinor: number;
  totalDebitsMinor: number;
  entries: LedgerEntry[];
  generatedAt: string;
}

export interface StatementService {
  monthly(actor: Actor, accountId: string, period: string): Statement;
  availablePeriods(actor: Actor, accountId: string): string[];
}

function monthBounds(period: string, timezone: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) throw validationError([{ field: "period", message: "must look like YYYY-MM" }]);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
  return {
    start: zonedDateTimeToInstant(`${period}-01`, "00:00", timezone),
    end: zonedDateTimeToInstant(`${next}-01`, "00:00", timezone),
  };
}

export function createStatementService(deps: {
  accounts: AccountService;
  entries: LedgerRepository;
  users: UserRepository;
  clock: Clock;
}): StatementService {
  const { accounts, entries, users, clock } = deps;

  return {
    monthly(actor, accountId, period) {
      const account = accounts.getForActor(actor, accountId);
      const owner = users.findById(account.ownerId);
      if (!owner) throw notFound("User");
      const { start, end } = monthBounds(period, owner.timezone);
      if (start.getTime() > clock.now().getTime()) {
        throw validationError([{ field: "period", message: "must not be in the future" }]);
      }
      const inPeriod = entries.listByAccountBetween(account.id, start, end);
      const later = entries.listByAccountSince(account.id, end);
      const laterDelta = later.reduce((sum, e) => sum + signedAmount(e), 0);
      const closing = account.balanceMinor - laterDelta;
      const periodDelta = inPeriod.reduce((sum, e) => sum + signedAmount(e), 0);
      return {
        accountId: account.id,
        accountNumber: account.number,
        currency: account.currency,
        period,
        timezone: owner.timezone,
        openingBalanceMinor: closing - periodDelta,
        closingBalanceMinor: closing,
        totalCreditsMinor: inPeriod.filter((e) => e.type === "credit").reduce((s, e) => s + e.amountMinor, 0),
        totalDebitsMinor: inPeriod.filter((e) => e.type === "debit").reduce((s, e) => s + e.amountMinor, 0),
        entries: inPeriod,
        generatedAt: clock.now().toISOString(),
      };
    },

    availablePeriods(actor, accountId) {
      const account = accounts.getForActor(actor, accountId);
      const opened = new Date(account.openedAt);
      const now = clock.now();
      const periods: string[] = [];
      const cursor = new Date(Date.UTC(opened.getUTCFullYear(), opened.getUTCMonth(), 1));
      while (cursor.getTime() <= now.getTime()) {
        periods.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      }
      return periods.reverse().slice(0, 24);
    },
  };
}

/** Plain-text rendering used for the downloadable statement. */
export function renderStatementText(statement: Statement): string {
  const lines = [
    "QUILLMOOR BANK - ACCOUNT STATEMENT",
    `Account: ${statement.accountNumber}`,
    `Period:  ${statement.period} (${statement.timezone})`,
    `Opening balance: ${formatMoney(statement.openingBalanceMinor, statement.currency)}`,
    "",
  ];
  for (const e of statement.entries) {
    const date = formatLocalDate(new Date(e.postedAt), statement.timezone);
    lines.push(`${date.padEnd(14)} ${e.description.slice(0, 48).padEnd(48)} ${formatDecimal(signedAmount(e), e.currency).padStart(12)}`);
  }
  lines.push(
    "",
    `Total credits:   ${formatMoney(statement.totalCreditsMinor, statement.currency)}`,
    `Total debits:    ${formatMoney(statement.totalDebitsMinor, statement.currency)}`,
    `Closing balance: ${formatMoney(statement.closingBalanceMinor, statement.currency)}`,
  );
  return lines.join("\n") + "\n";
}
