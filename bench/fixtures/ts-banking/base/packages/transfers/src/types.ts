import type { Currency } from "../../shared/src/money.ts";
import type { TransferStatus } from "./status.ts";

export type TransferChannel = "api" | "web";

export interface Transfer {
  id: string;
  /** The customer who initiated the transfer (owner of the source account). */
  userId: string;
  fromAccountId: string;
  toAccountId: string;
  amountMinor: number;
  currency: Currency;
  memo: string;
  status: TransferStatus;
  failureReason: string | null;
  idempotencyKey: string;
  /** Fingerprint of the request body, used to detect idempotency-key reuse with a different payload. */
  requestHash: string;
  channel: TransferChannel;
  createdAt: string;
  completedAt: string | null;
  reversedAt: string | null;
}

export interface TransferRepository {
  insert(transfer: Transfer): Transfer;
  update(transfer: Transfer): Transfer;
  findById(id: string): Transfer | undefined;
  findByIdempotencyKey(userId: string, key: string): Transfer | undefined;
  /** Newest first. */
  listByUser(userId: string): Transfer[];
  /** Completed transfers initiated by `userId` in `currency` with createdAt >= since. */
  listCompletedByUserSince(userId: string, currency: Currency, since: Date): Transfer[];
}

export interface CreateTransferInput {
  fromAccountId: string;
  /** Destination account id or customer-facing account number. */
  toAccount: string;
  /** Decimal amount in the source account currency, e.g. "25.00". */
  amount: string;
  memo?: string;
  idempotencyKey: string;
  channel?: TransferChannel;
}
