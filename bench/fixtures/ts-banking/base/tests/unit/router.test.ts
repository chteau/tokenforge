import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRouter } from "../../server/http/router.ts";
import { parseBody, parseCookies, bearerToken } from "../../server/http/request.ts";
import { json } from "../../server/http/response.ts";
import type { Route } from "../../server/http/types.ts";

const route = (method: Route["method"], path: string): Route => ({
  method,
  path,
  kind: "api",
  auth: "public",
  handler: () => json(200, { path }),
});

describe("router", () => {
  const router = createRouter([
    route("GET", "/api/accounts"),
    route("GET", "/api/accounts/:accountId"),
    route("GET", "/api/accounts/:accountId/transactions"),
    route("POST", "/api/accounts/:accountId/cards"),
  ]);

  it("matches static and parameterised paths", () => {
    const m = router.match("GET", "/api/accounts/acc_0001/transactions");
    assert.equal(m.kind, "found");
    if (m.kind === "found") assert.deepEqual(m.params, { accountId: "acc_0001" });
    assert.equal(router.match("GET", "/api/accounts/").kind, "found");
  });

  it("reports method-not-allowed and not-found", () => {
    const m = router.match("DELETE", "/api/accounts/acc_1/cards");
    assert.deepEqual(m, { kind: "method-not-allowed", allowed: ["POST"] });
    assert.equal(router.match("GET", "/api/nothing").kind, "not-found");
  });

  it("rejects duplicate routes", () => {
    assert.throws(() => createRouter([route("GET", "/a"), route("GET", "/a")]), /Duplicate route/);
  });
});

describe("request parsing", () => {
  it("parses cookies", () => {
    assert.deepEqual(parseCookies("a=1; qm_session=abc%3D; broken"), { a: "1", qm_session: "abc=" });
  });

  it("parses JSON and form bodies", () => {
    assert.deepEqual(parseBody('{"a":1}', "application/json"), { a: 1 });
    assert.deepEqual(parseBody("a=1&b=x+y", "application/x-www-form-urlencoded"), { a: "1", b: "x y" });
    assert.equal(parseBody("", "application/json"), undefined);
    assert.throws(() => parseBody("{", "application/json"), /Malformed JSON/);
  });

  it("extracts bearer tokens", () => {
    assert.equal(bearerToken("Bearer abc.def"), "abc.def");
    assert.equal(bearerToken("Basic xyz"), null);
  });
});
