import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { User } from "../../packages/auth/src/types.ts";
import { DomainError } from "../../packages/shared/src/errors.ts";
import { assertWithinDailyLimit, dailyLimitFor, remainingToday } from "../../packages/transfers/src/limits.ts";
import { assertTransition, canTransition, isTerminal } from "../../packages/transfers/src/status.ts";
import type { Transfer } from "../../packages/transfers/src/types.ts";
import { createMemoryTransferRepository } from "../../server/repositories/memory/transfers.ts";

const user: User = {
  id: "usr_9001",
  username: "tess",
  email: "tess@example.test",
  displayName: "Tess",
  role: "customer",
  passwordHash: "x",
  timezone: "America/New_York",
  dailyTransferLimits: { USD: 1_000_00 },
  emailNotifications: false,
  failedLoginAttempts: 0,
  lockedUntil: null,
  createdAt: "2026-01-01T00:00:00Z",
};

function transfer(id: string, createdAt: string, amountMinor: number, status: Transfer["status"] = "completed"): Transfer {
  return {
    id,
    userId: user.id,
    fromAccountId: "acc_1111",
    toAccountId: "acc_2222",
    amountMinor,
    currency: "USD",
    memo: "",
    status,
    failureReason: null,
    idempotencyKey: `key-${id}`,
    requestHash: "h",
    channel: "api",
    createdAt,
    completedAt: createdAt,
    reversedAt: null,
  };
}

describe("transfer status machine", () => {
  it("allows only forward transitions", () => {
    assert.ok(canTransition("pending", "completed"));
    assert.ok(canTransition("completed", "reversed"));
    assert.ok(!canTransition("failed", "completed"));
    assert.ok(isTerminal("reversed"));
    assert.throws(() => assertTransition("reversed", "completed"), (e: unknown) => e instanceof DomainError && e.code === "INVALID_TRANSITION");
  });
});

describe("daily limits", () => {
  it("uses per-user overrides and defaults", () => {
    assert.equal(dailyLimitFor(user, "USD"), 1_000_00);
    assert.equal(dailyLimitFor(user, "JPY"), 700_000);
  });

  it("counts only today's completed transfers in the customer's time zone", () => {
    const repo = createMemoryTransferRepository();
    repo.insert(transfer("trf_0001", "2026-10-07T03:59:00Z", 500_00)); // Oct 6 local
    repo.insert(transfer("trf_0002", "2026-10-07T04:00:00Z", 300_00)); // Oct 7 00:00 local
    repo.insert(transfer("trf_0003", "2026-10-07T12:00:00Z", 900_00, "failed"));
    const now = new Date("2026-10-07T20:00:00Z");
    assert.equal(remainingToday(repo, user, "USD", now), 700_00);
    assert.doesNotThrow(() => assertWithinDailyLimit(repo, user, "USD", 700_00, now));
    assert.throws(
      () => assertWithinDailyLimit(repo, user, "USD", 700_01, now),
      (e: unknown) => e instanceof DomainError && e.code === "DAILY_LIMIT_EXCEEDED",
    );
  });
});
