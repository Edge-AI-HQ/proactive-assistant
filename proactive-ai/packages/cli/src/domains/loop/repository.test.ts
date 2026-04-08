import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SqliteDatabase } from "../../db/sqlite_adapter.js";
import { LoopRepository, type PendingItemInput } from "./repository.js";

const createTestDb = async (): Promise<{
  db: SqliteDatabase;
  cleanup: () => Promise<void>;
}> => {
  const root = await mkdtemp(join(tmpdir(), "pin-loop-test-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const db = new SqliteDatabase(join(dataDir, "pin.db"));
  return {
    db,
    cleanup: async () => {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
};

const sampleItem = (id: string): PendingItemInput => ({
  id,
  source: "world",
  kind: "headline",
  createdAt: "2026-04-08T10:00:00.000Z",
  availableAt: "2026-04-08T10:00:00.000Z",
  status: "pending",
  processedAt: null,
  payload: {
    id,
    title: `Headline ${id}`,
    provider: "google-news",
  },
});

test("LoopRepository creates incremental context runs and commits processed items", async () => {
  const { db, cleanup } = await createTestDb();

  try {
    const repository = new LoopRepository(db);

    const enqueue = await repository.enqueuePending({
      items: [sampleItem("world-1"), sampleItem("world-2"), sampleItem("world-1")],
      worldCursorUpdatedAt: "2026-04-08T10:00:00.000Z",
    });

    assert.equal(enqueue.insertedCount, 2);
    assert.equal(enqueue.pendingCount, 2);

    const context = await repository.createIncrementalContextRun({
      limit: 50,
      minAgeMs: 0,
    });

    assert.ok(context);
    assert.equal(context?.items.length, 2);
    assert.equal(context?.pendingCount, 2);
    assert.ok(context?.runToken.startsWith("inc_"));

    const beforeCommit = await repository.getLoopStatus();
    assert.equal(beforeCommit.pendingCount, 2);
    assert.equal(beforeCommit.processedCount, 0);
    assert.equal(beforeCommit.openRunCount, 1);

    const committed = await repository.commitContextRun(context!.runToken, "2026-04-08T10:05:00.000Z");
    assert.equal(committed.processedCount, 2);

    const afterCommit = await repository.getLoopStatus();
    assert.equal(afterCommit.pendingCount, 0);
    assert.equal(afterCommit.processedCount, 2);
    assert.equal(afterCommit.openRunCount, 0);
  } finally {
    await cleanup();
  }
});

test("LoopRepository returns null when no ready pending items exist", async () => {
  const { db, cleanup } = await createTestDb();

  try {
    const repository = new LoopRepository(db);
    const context = await repository.createIncrementalContextRun({
      limit: 10,
      minAgeMs: 0,
    });
    assert.equal(context, null);
  } finally {
    await cleanup();
  }
});
