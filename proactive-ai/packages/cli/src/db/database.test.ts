import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PinDatabaseManager,
  resolvePinDataRoot,
} from "./database.js";

test("resolvePinDataRoot prefers explicit PIN_DATA_ROOT", () => {
  const root = resolvePinDataRoot({
    env: { PIN_DATA_ROOT: "/tmp/pin-data" },
    homeDir: "/Users/test",
  });

  assert.equal(root, "/tmp/pin-data");
});

test("PinDatabaseManager init creates data directory metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-db-"));

  try {
    const manager = new PinDatabaseManager({ dataRoot: root });
    const state = await manager.init();

    assert.equal(state.dataRoot, root);
    assert.equal(state.databases.pin.endsWith("pin.db"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
