import type { Actor } from "../../auth/src/types.ts";
import { can, requirePermission } from "../../auth/src/roles.ts";
import type { Clock } from "../../shared/src/clock.ts";
import { DomainError, notFound, validationError } from "../../shared/src/errors.ts";
import type { DomainEvents, EventBus } from "../../shared/src/events.ts";
import type { IdGenerator } from "../../shared/src/ids.ts";
import { type Currency, parseAmount } from "../../shared/src/money.ts";
import type { Ledger } from "../../transactions/src/ledger.ts";
import type { LedgerEntry } from "../../transactions/src/types.ts";
import type { Account, AccountRepository, AccountType } from "./types.ts";

export interface AccountService {
  listForUser(actor: Actor, userId?: string): Account[];
  /** Read access: the owner, or staff with accounts:read:any. Others get NOT_FOUND. */
  getForActor(actor: Actor, accountId: string): Account;
  /** Money movement: only the owner. Others (including staff) get NOT_FOUND. */
  requireOwned(actor: Actor, accountId: string): Account;
  /** Resolve a destination by id or customer-facing number. */
  resolveDestination(idOrNumber: string): Account;
  open(actor: Actor, input: { ownerId: string; name: string; type: AccountType; currency: Currency }): Account;
  deposit(actor: Actor, accountId: string, input: { amount: string; description: string }): LedgerEntry;
  setFrozen(actor: Actor, accountId: string, frozen: boolean): Account;
  rename(actor: Actor, accountId: string, name: string): Account;
}

export interface AccountServiceDeps {
  accounts: AccountRepository;
  ledger: Ledger;
  clock: Clock;
  ids: IdGenerator;
  events: EventBus<DomainEvents>;
}

export function createAccountService(deps: AccountServiceDeps): AccountService {
  const { accounts, ledger, clock, ids, events } = deps;

  function nextAccountNumber(): string {
    const n = accounts.list().length + 1;
    return `QM-1000-${String(n).padStart(4, "0")}`;
  }

  function getForActor(actor: Actor, accountId: string): Account {
    const account = accounts.findById(accountId);
    if (!account || (account.ownerId !== actor.userId && !can(actor, "accounts:read:any"))) {
      throw notFound("Account");
    }
    return account;
  }

  function requireOwned(actor: Actor, accountId: string): Account {
    const account = accounts.findById(accountId);
    if (!account || account.ownerId !== actor.userId) throw notFound("Account");
    return account;
  }

  return {
    listForUser(actor, userId) {
      const target = userId ?? actor.userId;
      if (target !== actor.userId) requirePermission(actor, "accounts:read:any");
      return accounts
        .listByOwner(target)
        .filter((a) => a.status !== "closed")
        .sort((a, b) => a.openedAt.localeCompare(b.openedAt) || a.id.localeCompare(b.id));
    },

    getForActor,
    requireOwned,

    resolveDestination(idOrNumber) {
      const key = idOrNumber.trim();
      const account = accounts.findById(key) ?? accounts.findByNumber(key.toUpperCase());
      if (!account || account.status === "closed") throw notFound("Destination account");
      return account;
    },

    open(actor, input) {
      requirePermission(actor, "accounts:freeze");
      const account: Account = {
        id: ids.next("acc"),
        ownerId: input.ownerId,
        number: nextAccountNumber(),
        name: input.name,
        type: input.type,
        currency: input.currency,
        balanceMinor: 0,
        status: "active",
        openedAt: clock.now().toISOString(),
      };
      return accounts.insert(account);
    },

    deposit(actor, accountId, input) {
      requirePermission(actor, "accounts:deposit");
      const account = accounts.findById(accountId);
      if (!account) throw notFound("Account");
      if (account.status !== "active") throw new DomainError("ACCOUNT_FROZEN", "Account is not active");
      const amountMinor = parseAmount(input.amount, account.currency);
      if (amountMinor === null || amountMinor <= 0) {
        throw validationError([{ field: "amount", message: "must be a positive amount" }]);
      }
      const entry = ledger.post(account.id, {
        type: "credit",
        amountMinor,
        description: input.description,
        counterparty: "Quillmoor Bank",
        reference: null,
        transferId: null,
        category: "deposit",
      });
      events.emit("accountsChanged", {
        changes: [{ ownerId: account.ownerId, accountId: account.id }],
        reason: "deposit",
      });
      return entry;
    },

    setFrozen(actor, accountId, frozen) {
      requirePermission(actor, "accounts:freeze");
      const account = accounts.findById(accountId);
      if (!account) throw notFound("Account");
      if (account.status === "closed") throw new DomainError("CONFLICT", "Account is closed");
      const updated = accounts.update({ ...account, status: frozen ? "frozen" : "active" });
      events.emit("accountsChanged", { changes: [{ ownerId: account.ownerId, accountId }], reason: "status" });
      return updated;
    },

    rename(actor, accountId, name) {
      const account = requireOwned(actor, accountId);
      const trimmed = name.trim();
      if (trimmed.length < 1 || trimmed.length > 40) {
        throw validationError([{ field: "name", message: "must be between 1 and 40 characters" }]);
      }
      const updated = accounts.update({ ...account, name: trimmed });
      events.emit("accountsChanged", { changes: [{ ownerId: account.ownerId, accountId }], reason: "rename" });
      return updated;
    },
  };
}
