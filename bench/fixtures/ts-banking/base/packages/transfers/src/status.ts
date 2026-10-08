import { invalidTransition } from "../../shared/src/errors.ts";

export type TransferStatus = "pending" | "completed" | "failed" | "reversed";

const ALLOWED: Record<TransferStatus, readonly TransferStatus[]> = {
  pending: ["completed", "failed"],
  completed: ["reversed"],
  failed: [],
  reversed: [],
};

export function canTransition(from: TransferStatus, to: TransferStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: TransferStatus, to: TransferStatus): void {
  if (!canTransition(from, to)) throw invalidTransition("transfer", from, to);
}

export function isTerminal(status: TransferStatus): boolean {
  return ALLOWED[status].length === 0;
}

export const STATUS_LABELS: Record<TransferStatus, string> = {
  pending: "Pending",
  completed: "Completed",
  failed: "Failed",
  reversed: "Reversed",
};
