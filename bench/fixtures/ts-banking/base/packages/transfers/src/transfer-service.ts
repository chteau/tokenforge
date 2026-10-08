import { createHash } from "node:crypto";
import type { AccountService } from "../../accounts/src/account-service.ts";
import type { Account } from "../../accounts/src/types.ts";
import { requirePermission } from "../../auth/src/roles.ts";
import type { Actor, UserRepository } from "../../auth/src/types.ts";
import type { NotificationService } from "../../notifications/src/notification-service.ts";
import type { Clock } from "../../shared/src/clock.ts";
import { DomainError, notFound, validationError } from "../../shared/src/errors.ts";
import type { DomainEvents, EventBus } from "../../shared/src/events.ts";
import type { IdGenerator } from "../../shared/src/ids.ts";
import { formatMoney, parseAmount } from "../../shared/src/money.ts";
import type { Ledger } from "../../transactions/src/ledger.ts";
import { assertWithinDailyLimit, remainingToday } from "./limits.ts";
import { assertTransition } from "./status.ts";
import type { CreateTransferInput, Transfer, TransferRepository } from "./types.ts";

export const MAX_MEMO_LENGTH = 140;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_:.-]{8,64}$/;

/** A validated transfer request that has not been executed yet. */
export interface PreparedTransfer {
  from: Account;
  to: Account;
  amountMinor: number;
  memo: string;
  remainingTodayMinor: number;
}

export interface CreateTransferResult {
  transfer: Transfer;
  /** True when the idempotency key matched an earlier identical request. */
  replayed: boolean;
}

export interface TransferService {
  /** Validate a request (ownership, destination, currency, amount) without moving money. */
  prepare(actor: Actor, input: Omit<CreateTransferInput, "idempotencyKey">): PreparedTransfer;
  /**
   * Execute an internal transfer. Enforces ownership, account status, currency,
   * the customer's daily limit and available funds. Idempotent per
   * (user, idempotencyKey).
   */
  createTransfer(actor: Actor, input: CreateTransferInput): CreateTransferResult;
  listForUser(actor: Actor): Transfer[];
  getForActor(actor: Actor, transferId: string): Transfer;
  reverse(actor: Actor, transferId: string, reason: string): Transfer;
}

export interface TransferServiceDeps {
  transfers: TransferRepository;
  accounts: AccountService;
  users: UserRepository;
  ledger: Ledger;
  notifications: NotificationService;
  clock: Clock;
  ids: IdGenerator;
  events: EventBus<DomainEvents>;
}

export function fingerprint(parts: Record<string, string | number>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function createTransferService(deps: TransferServiceDeps): TransferService {
  const { transfers, accounts, users, ledger, notifications, clock, ids, events } = deps;

  function prepare(actor: Actor, input: Omit<CreateTransferInput, "idempotencyKey">): PreparedTransfer {
    const from = accounts.requireOwned(actor, input.fromAccountId);
    const to = accounts.resolveDestination(input.toAccount);
    if (from.id === to.id) {
      throw validationError([{ field: "toAccount", message: "must be different from the source account" }]);
    }
    if (from.status !== "active") throw new DomainError("ACCOUNT_FROZEN", "Source account is not active");
    if (to.status !== "active") throw new DomainError("ACCOUNT_FROZEN", "Destination account is not active");
    if (from.currency !== to.currency) {
      throw new DomainError("CURRENCY_MISMATCH", `Cannot transfer ${from.currency} to a ${to.currency} account`);
    }
    const amountMinor = parseAmount(input.amount, from.currency);
    if (amountMinor === null || amountMinor <= 0) {
      throw validationError([{ field: "amount", message: "must be a positive amount in the account currency" }]);
    }
    const memo = (input.memo ?? "").trim();
    if (memo.length > MAX_MEMO_LENGTH) {
      throw validationError([{ field: "memo", message: `must be at most ${MAX_MEMO_LENGTH} characters` }]);
    }
    const user = users.findById(actor.userId);
    if (!user) throw notFound("User");
    return { from, to, amountMinor, memo, remainingTodayMinor: remainingToday(transfers, user, from.currency, clock.now()) };
  }

  function ownerName(userId: string): string {
    return users.findById(userId)?.displayName ?? "Quillmoor customer";
  }

  return {
    prepare,

    createTransfer(actor, input) {
      if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
        throw validationError([{ field: "idempotencyKey", message: "must be 8-64 characters of A-Z a-z 0-9 _ : . -" }]);
      }
      const prepared = prepare(actor, input);
      const { from, to, amountMinor, memo } = prepared;
      const requestHash = fingerprint({ from: from.id, to: to.id, amountMinor, memo });

      const existing = transfers.findByIdempotencyKey(actor.userId, input.idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different transfer");
        }
        return { transfer: existing, replayed: true };
      }

      const user = users.findById(actor.userId);
      if (!user) throw notFound("User");
      const now = clock.now();
      assertWithinDailyLimit(transfers, user, from.currency, amountMinor, now);
      if (from.balanceMinor < amountMinor) {
        throw new DomainError("INSUFFICIENT_FUNDS", "Insufficient funds", [
          { field: "amount", message: "exceeds the available balance", availableMinor: from.balanceMinor },
        ]);
      }

      let transfer = transfers.insert({
        id: ids.next("trf"),
        userId: actor.userId,
        fromAccountId: from.id,
        toAccountId: to.id,
        amountMinor,
        currency: from.currency,
        memo,
        status: "pending",
        failureReason: null,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        channel: input.channel ?? "api",
        createdAt: now.toISOString(),
        completedAt: null,
        reversedAt: null,
      });

      try {
        ledger.postTransfer({
          fromAccountId: from.id,
          toAccountId: to.id,
          amountMinor,
          transferId: transfer.id,
          reference: memo || null,
          debitDescription: memo ? `Transfer to ${to.number}: ${memo}` : `Transfer to ${to.number}`,
          creditDescription: memo ? `Transfer from ${from.number}: ${memo}` : `Transfer from ${from.number}`,
          debitCounterparty: ownerName(to.ownerId),
          creditCounterparty: ownerName(from.ownerId),
        });
      } catch (error) {
        assertTransition(transfer.status, "failed");
        transfers.update({
          ...transfer,
          status: "failed",
          failureReason: error instanceof DomainError ? error.code : "INTERNAL",
        });
        throw error;
      }

      assertTransition(transfer.status, "completed");
      transfer = transfers.update({ ...transfer, status: "completed", completedAt: clock.now().toISOString() });

      events.emit("accountsChanged", {
        changes: [from, to].map((account) => ({ ownerId: account.ownerId, accountId: account.id })),
        reason: "transfer",
      });

      const amountText = formatMoney(amountMinor, from.currency);
      notifications.notify(from.ownerId, {
        kind: "transfer_sent",
        title: "Transfer sent",
        body: `You sent ${amountText} from ${from.name} to ${to.number}.`,
      });
      if (to.ownerId !== from.ownerId) {
        notifications.notify(to.ownerId, {
          kind: "transfer_received",
          title: "Money received",
          body: `${ownerName(from.ownerId)} sent you ${amountText}.`,
        });
      }
      return { transfer, replayed: false };
    },

    listForUser(actor) {
      return transfers.listByUser(actor.userId);
    },

    getForActor(actor, transferId) {
      const transfer = transfers.findById(transferId);
      if (!transfer || (transfer.userId !== actor.userId && actor.role !== "admin")) throw notFound("Transfer");
      return transfer;
    },

    reverse(actor, transferId, reason) {
      requirePermission(actor, "transfers:reverse");
      const transfer = transfers.findById(transferId);
      if (!transfer) throw notFound("Transfer");
      assertTransition(transfer.status, "reversed");
      ledger.postTransfer({
        fromAccountId: transfer.toAccountId,
        toAccountId: transfer.fromAccountId,
        amountMinor: transfer.amountMinor,
        transferId: transfer.id,
        reference: `Reversal: ${reason}`,
        debitDescription: `Reversal of ${transfer.id}`,
        creditDescription: `Reversal of ${transfer.id}`,
        debitCounterparty: "Quillmoor Bank",
        creditCounterparty: "Quillmoor Bank",
      });
      const updated = transfers.update({ ...transfer, status: "reversed", reversedAt: clock.now().toISOString() });
      const fromOwner = accounts.resolveDestination(transfer.fromAccountId).ownerId;
      const toOwner = accounts.resolveDestination(transfer.toAccountId).ownerId;
      events.emit("accountsChanged", {
        changes: [
          { ownerId: fromOwner, accountId: transfer.fromAccountId },
          { ownerId: toOwner, accountId: transfer.toAccountId },
        ],
        reason: "reversal",
      });
      notifications.notify(transfer.userId, {
        kind: "transfer_reversed",
        title: "Transfer reversed",
        body: `Your transfer of ${formatMoney(transfer.amountMinor, transfer.currency)} was reversed: ${reason}`,
      });
      return updated;
    },
  };
}
