import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/server/store.js";

test("SQLite permits one owner and rolls back a failed nested operation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "siyin-store-"));
  const path = join(dir, "state.sqlite");
  let store = new SqliteStore(path);
  try {
    store.put("saved", { value: 1 });
    assert.throws(() => new SqliteStore(path), /locked/);
    assert.throws(
      () =>
        store.transaction(() => {
          store.put("saved", { value: 2 });
          store.transaction(() => {
            store.put("nested", true);
          });
          throw new Error("rollback");
        }),
      /rollback/,
    );
    assert.deepEqual(store.get("saved"), { value: 1 });
    assert.equal(store.get("nested"), undefined);
    store.close();
    store = new SqliteStore(path);
    assert.deepEqual(store.get("saved"), { value: 1 });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
