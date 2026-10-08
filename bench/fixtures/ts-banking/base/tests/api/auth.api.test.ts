import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setup } from "../support/harness.ts";

describe("auth API", () => {
  it("logs in with seed credentials and returns the public profile", async () => {
    const t = setup();
    const res = await t.app.inject({ method: "POST", url: "/api/auth/login", body: { username: "Alice", password: "alice-harbor-2026" } });
    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.user.username, "alice");
    assert.equal(body.user.passwordHash, undefined);
    assert.ok(body.token.length > 20);
  });

  it("rejects bad credentials and locks out after repeated failures", async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) {
      const res = await t.app.inject({ method: "POST", url: "/api/auth/login", body: { username: "bob", password: "wrong" } });
      assert.equal(res.status, 401);
    }
    const locked = await t.app.inject({ method: "POST", url: "/api/auth/login", body: { username: "bob", password: "bob-harbor-2026" } });
    assert.equal(locked.status, 429);
    t.clock.advance(16 * 60_000);
    const ok = await t.app.inject({ method: "POST", url: "/api/auth/login", body: { username: "bob", password: "bob-harbor-2026" } });
    assert.equal(ok.status, 200);
  });

  it("requires a session for protected routes", async () => {
    const t = setup();
    const res = await t.app.inject({ method: "GET", url: "/api/me" });
    assert.equal(res.status, 401);
    assert.equal(res.json().error.code, "UNAUTHENTICATED");
  });

  it("validates the login body", async () => {
    const t = setup();
    const res = await t.app.inject({ method: "POST", url: "/api/auth/login", body: { username: "" } });
    assert.equal(res.status, 400);
    assert.deepEqual(
      res.json().error.details.map((d: { field: string }) => d.field),
      ["username", "password"],
    );
  });

  it("updates the profile and logs out", async () => {
    const t = setup();
    const alice = await t.login("alice");
    const patched = await alice.patch("/api/me", { timezone: "Europe/Lisbon" });
    assert.equal(patched.status, 200);
    assert.equal(patched.json().user.timezone, "Europe/Lisbon");
    const bad = await alice.patch("/api/me", { timezone: "Atlantis/Capital" });
    assert.equal(bad.status, 400);
    assert.equal((await alice.post("/api/auth/logout")).status, 204);
    assert.equal((await alice.get("/api/me")).status, 401);
  });

  it("returns 404 JSON for unknown routes and 405 for wrong methods", async () => {
    const t = setup();
    assert.equal((await t.app.inject({ method: "GET", url: "/api/nope" })).status, 404);
    const res = await t.app.inject({ method: "DELETE", url: "/api/auth/login" });
    assert.equal(res.status, 405);
    assert.equal(res.headers["allow"], "POST");
  });
});
