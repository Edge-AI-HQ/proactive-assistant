import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PinDatabaseManager } from "./database.js";

test("profile database supports exec and query helpers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-sqlite-"));

  try {
    const manager = new PinDatabaseManager({ dataRoot: root });
    await manager.init();
    const db = manager.open("pin");

    db.exec("create table test_items (id text primary key, value text not null)");
    db.exec("insert into test_items (id, value) values (?, ?)", ["a", "hello"]);

    const row = db.get<{ value: string }>(
      "select value from test_items where id = ?",
      ["a"],
    );

    assert.equal(row?.value, "hello");
    assert.deepEqual(
      db.all<{ id: string }>("select id from test_items order by id asc"),
      [{ id: "a" }],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
