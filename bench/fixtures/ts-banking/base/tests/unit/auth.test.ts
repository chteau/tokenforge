import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkPasswordPolicy, hashPassword, verifyPassword } from "../../packages/auth/src/password.ts";
import { can, requirePermission } from "../../packages/auth/src/roles.ts";
import { SESSION_IDLE_MS, createSessionManager } from "../../packages/auth/src/sessions.ts";
import { createManualClock } from "../../packages/shared/src/clock.ts";
import { createMemorySessionRepository } from "../../server/repositories/memory/sessions.ts";

describe("password hashing", () => {
  it("verifies the right password only", async () => {
    const hash = await hashPassword("tide-pool-7781", { N: 1024, r: 8, p: 1 });
    assert.match(hash, /^scrypt\$1024\$8\$1\$/);
    assert.equal(await verifyPassword("tide-pool-7781", hash), true);
    assert.equal(await verifyPassword("tide-pool-7782", hash), false);
    assert.equal(await verifyPassword("anything", "not-a-hash"), false);
  });

  it("enforces the password policy", () => {
    assert.equal(checkPasswordPolicy("short1").length, 1);
    assert.equal(checkPasswordPolicy("long-enough-but-no-digit").length, 1);
    assert.deepEqual(checkPasswordPolicy("long-enough-with-digit-9"), []);
  });
});

describe("roles", () => {
  it("grants staff permissions by role", () => {
    assert.ok(can({ role: "admin" }, "accounts:deposit"));
    assert.ok(can({ role: "support" }, "tickets:reply:any"));
    assert.ok(!can({ role: "support" }, "accounts:deposit"));
    assert.throws(() => requirePermission({ role: "customer" }, "ops:cache"));
  });
});

describe("sessions", () => {
  it("expires idle sessions", () => {
    const clock = createManualClock("2026-01-01T00:00:00Z");
    const manager = createSessionManager({ sessions: createMemorySessionRepository(), clock });
    const s = manager.create("usr_1");
    clock.advance(SESSION_IDLE_MS - 1);
    assert.ok(manager.resolve(s.token));
    clock.advance(SESSION_IDLE_MS);
    assert.equal(manager.resolve(s.token), undefined);
  });

  it("revokes all sessions of a user", () => {
    const clock = createManualClock("2026-01-01T00:00:00Z");
    const manager = createSessionManager({ sessions: createMemorySessionRepository(), clock });
    const a = manager.create("usr_1");
    manager.create("usr_1");
    const other = manager.create("usr_2");
    assert.equal(manager.revokeAll("usr_1"), 2);
    assert.equal(manager.resolve(a.token), undefined);
    assert.ok(manager.resolve(other.token));
  });
});
