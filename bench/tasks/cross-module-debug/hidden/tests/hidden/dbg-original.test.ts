import assert from "node:assert/strict";
import { test } from "node:test";
import { balanceOf, world } from "./dbg-support.ts";

test("DBG-ORIGINAL: refreshes the recipient's dashboard after an incoming transfer", async () => {
  const w = world();
  const alice = await w.login("alice");
  const bob = await w.login("bob");
  await bob.dashboard();
  await alice.transfer("QM-1000-0001", "QM-1000-0005", "15.00");
  assert.equal(balanceOf(await bob.dashboard(), "QM-1000-0005"), 36_500 + 1_500);
});
