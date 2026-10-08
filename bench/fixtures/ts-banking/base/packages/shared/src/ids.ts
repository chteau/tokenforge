import { randomUUID } from "node:crypto";

export type IdPrefix = "usr" | "acc" | "txn" | "trf" | "ntf" | "crd" | "tkt" | "msg" | "stm" | "eml" | "req";

export interface IdGenerator {
  next(prefix: IdPrefix): string;
}

export const randomIds: IdGenerator = {
  next: (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
};

// Deterministic ids for tests and seed data: usr_0001, acc_0002, ...
export function sequentialIds(start = 1): IdGenerator {
  const counters = new Map<string, number>();
  return {
    next(prefix) {
      const n = counters.get(prefix) ?? start;
      counters.set(prefix, n + 1);
      return `${prefix}_${String(n).padStart(4, "0")}`;
    },
  };
}

const ID_PATTERN = /^[a-z]{3}_[A-Za-z0-9]{4,32}$/;

export function looksLikeId(value: string, prefix?: IdPrefix): boolean {
  if (!ID_PATTERN.test(value)) return false;
  return prefix === undefined || value.startsWith(`${prefix}_`);
}
