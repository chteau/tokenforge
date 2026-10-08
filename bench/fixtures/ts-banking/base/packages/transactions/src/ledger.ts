import type { AccountRepository } from "../../accounts/src/types.ts";
import type { Clock } from "../../shared/src/clock.ts";
import { DomainError, notFound } from "../../shared/src/errors.ts";
import type { IdGenerator } from "../../shared/src/ids.ts";
import type { EntryCategory, EntryType, LedgerEntry, LedgerRepository } from "./types.ts";

export interface PostInput {
  type: EntryType;
  amountMinor: number;
  description: string;
  counterparty: string | null;
  reference: string | null;
  transferId: string | null;
  category: EntryCategory;
  /** Defaults to clock.now(); only seed/import code back-dates entries. */
  postedAt?: Date;
}

export interface TransferPosting {
  fromAccountId: string;
  toAccountId: string;
  amountMinor: number;
  transferId: string;
  reference: string | null;
  debitDescription: string;
  creditDescription: string;
  debitCounterparty: string;
  creditCounterparty: string;
}

export interface Ledger {
  /** Append one entry and update the account balance. Debits may not overdraw. */
  post(accountId: string, input: PostInput): LedgerEntry;
  /** Debit + credit for a transfer; both legs or neither. */
  postTransfer(posting: TransferPosting): { debit: LedgerEntry; credit: LedgerEntry };
}

export interface LedgerDeps {
  entries: LedgerRepository;
  accounts: AccountRepository;
  clock: Clock;
  ids: IdGenerator;
}

export function createLedger(deps: LedgerDeps): Ledger {
  const { entries, accounts, clock, ids } = deps;

  function post(accountId: string, input: PostInput): LedgerEntry {
    const account = accounts.findById(accountId);
    if (!account) throw notFound("Account");
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new DomainError("VALIDATION_ERROR", "Ledger amounts must be positive integers");
    }
    const delta = input.type === "credit" ? input.amountMinor : -input.amountMinor;
    const balanceAfterMinor = account.balanceMinor + delta;
    if (balanceAfterMinor < 0) {
      throw new DomainError("INSUFFICIENT_FUNDS", "Insufficient funds", [
        { field: "amount", message: "exceeds the available balance", availableMinor: account.balanceMinor },
      ]);
    }
    accounts.update({ ...account, balanceMinor: balanceAfterMinor });
    return entries.append({
      id: ids.next("txn"),
      accountId,
      postedAt: (input.postedAt ?? clock.now()).toISOString(),
      type: input.type,
      amountMinor: input.amountMinor,
      currency: account.currency,
      description: input.description,
      counterparty: input.counterparty,
      reference: input.reference,
      category: input.category,
      balanceAfterMinor,
      transferId: input.transferId,
    });
  }

  return {
    post,
    postTransfer(p) {
      const from = accounts.findById(p.fromAccountId);
      const to = accounts.findById(p.toAccountId);
      if (!from || !to) throw notFound("Account");
      if (from.balanceMinor < p.amountMinor) {
        throw new DomainError("INSUFFICIENT_FUNDS", "Insufficient funds", [
          { field: "amount", message: "exceeds the available balance", availableMinor: from.balanceMinor },
        ]);
      }
      const debit = post(from.id, {
        type: "debit",
        amountMinor: p.amountMinor,
        description: p.debitDescription,
        counterparty: p.debitCounterparty,
        reference: p.reference,
        transferId: p.transferId,
        category: "transfer",
      });
      const credit = post(to.id, {
        type: "credit",
        amountMinor: p.amountMinor,
        description: p.creditDescription,
        counterparty: p.creditCounterparty,
        reference: p.reference,
        transferId: p.transferId,
        category: "transfer",
      });
      return { debit, credit };
    },
  };
}
