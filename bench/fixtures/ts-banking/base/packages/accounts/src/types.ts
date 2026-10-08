import type { Currency } from "../../shared/src/money.ts";

export type AccountType = "checking" | "savings" | "travel";
export type AccountStatus = "active" | "frozen" | "closed";

export interface Account {
  id: string;
  ownerId: string;
  /** Customer facing account number, e.g. "QM-1000-0001". */
  number: string;
  name: string;
  type: AccountType;
  currency: Currency;
  balanceMinor: number;
  status: AccountStatus;
  openedAt: string;
}

export interface AccountRepository {
  insert(account: Account): Account;
  update(account: Account): Account;
  findById(id: string): Account | undefined;
  findByNumber(number: string): Account | undefined;
  listByOwner(ownerId: string): Account[];
  list(): Account[];
}

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  checking: "Everyday Checking",
  savings: "Harbor Savings",
  travel: "Travel Wallet",
};
