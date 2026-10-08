import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createJsonFileStore } from "../../server/repositories/json-file-store.ts";
import { createTable } from "../../server/repositories/memory/table.ts";

const dir = mkdtempSync(join(tmpdir(), "qm-store-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("JSON file store", () => {
  it("round-trips registered tables", () => {
    const path = join(dir, "nested", "bank.json");
    const table = createTable<{ id: string; n: number }>("things", (r) => r.id);
    table.insert({ id: "a", n: 1 });
    const store = createJsonFileStore(path);
    store.register("things", table);
    store.save();
    assert.equal(JSON.parse(readFileSync(path, "utf8")).tables.things.length, 1);

    const restored = createTable<{ id: string; n: number }>("things", (r) => r.id);
    const store2 = createJsonFileStore(path);
    store2.register("things", restored);
    assert.equal(store2.load(), true);
    assert.deepEqual(restored.get("a"), { id: "a", n: 1 });
  });

  it("reports a missing file and rejects double registration", () => {
    const store = createJsonFileStore(join(dir, "missing.json"));
    const table = createTable<{ id: string }>("t", (r) => r.id);
    store.register("t", table);
    assert.equal(store.load(), false);
    assert.throws(() => store.register("t", table), /registered twice/);
  });
});
