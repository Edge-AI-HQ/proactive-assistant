import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteDatabase } from "../../../core/db/sqlite_adapter.js";
import { FeedbackRepository } from "../../../core/domains/feedback/repository.js";

const createTestDb = async (): Promise<{
  db: SqliteDatabase;
  cleanup: () => Promise<void>;
}> => {
  const root = await mkdtemp(join(tmpdir(), "pin-feedback-test-"));
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

describe("FeedbackRepository", () => {
  test("create and getById", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const repo = new FeedbackRepository(db);
      const record = await repo.create({
        kind: "card_action",
        action: "confirm",
        basket: "work",
        channel: "telegram",
        source: "user_direct",
        pushId: "push_001",
        intentCardId: "ic_001",
      });

      assert.ok(record.id.startsWith("fe_"));
      assert.equal(record.kind, "card_action");
      assert.equal(record.action, "confirm");
      assert.equal(record.basket, "work");
      assert.equal(record.channel, "telegram");
      assert.equal(record.source, "user_direct");
      assert.equal(record.pushId, "push_001");
      assert.equal(record.intentCardId, "ic_001");

      const fetched = await repo.getById(record.id);
      assert.ok(fetched);
      assert.equal(fetched.id, record.id);
    } finally {
      await cleanup();
    }
  });

  test("create text_feedback with conversation association", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const repo = new FeedbackRepository(db);
      const record = await repo.create({
        kind: "text_feedback",
        source: "user_derived",
        basket: "health",
        text: "User does not want health reminders",
        conversationId: "conv_abc",
        messageId: "msg_456",
      });

      assert.equal(record.kind, "text_feedback");
      assert.equal(record.source, "user_derived");
      assert.equal(record.text, "User does not want health reminders");
      assert.equal(record.conversationId, "conv_abc");
      assert.equal(record.messageId, "msg_456");
    } finally {
      await cleanup();
    }
  });

  test("getById returns null for missing ID", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const repo = new FeedbackRepository(db);
      const result = await repo.getById("nonexistent");
      assert.equal(result, null);
    } finally {
      await cleanup();
    }
  });

  test("list with filters", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const repo = new FeedbackRepository(db);

      await repo.create({ kind: "card_action", action: "confirm", basket: "work" });
      await repo.create({ kind: "card_action", action: "modify", basket: "work" });
      await repo.create({ kind: "card_open", basket: "health" });
      await repo.create({ kind: "dismiss", basket: "work" });
      await repo.create({ kind: "text_feedback", source: "agent_analysis", basket: "work" });

      const all = await repo.list({ limit: 50 });
      assert.equal(all.length, 5);

      const workOnly = await repo.list({ basket: "work", limit: 50 });
      assert.equal(workOnly.length, 4);

      const confirmOnly = await repo.list({ action: "confirm", limit: 50 });
      assert.equal(confirmOnly.length, 1);

      const cardActions = await repo.list({ kind: "card_action", limit: 50 });
      assert.equal(cardActions.length, 2);

      const agentFeedback = await repo.list({ source: "agent_analysis", limit: 50 });
      assert.equal(agentFeedback.length, 1);

      const limited = await repo.list({ limit: 2 });
      assert.equal(limited.length, 2);
    } finally {
      await cleanup();
    }
  });

  test("list with intentCardId filter", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const repo = new FeedbackRepository(db);

      await repo.create({ kind: "card_open", intentCardId: "ic_001" });
      await repo.create({ kind: "card_action", action: "confirm", intentCardId: "ic_001" });
      await repo.create({ kind: "card_open", intentCardId: "ic_002" });

      const ic001 = await repo.list({ intentCardId: "ic_001", limit: 50 });
      assert.equal(ic001.length, 2);
    } finally {
      await cleanup();
    }
  });

  test("stats computes gross and qualified hit counts", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const repo = new FeedbackRepository(db);

      // Gross hits: card_open, card_action(*), explicit_rating(thumbs_up)
      await repo.create({ kind: "card_open", basket: "work" });
      await repo.create({ kind: "card_action", action: "confirm", basket: "work" });
      await repo.create({ kind: "card_action", action: "modify", basket: "health" });
      await repo.create({ kind: "card_action", action: "later", basket: "work" });
      await repo.create({ kind: "explicit_rating", action: "thumbs_up", basket: "work" });
      // Not gross hits:
      await repo.create({ kind: "explicit_rating", action: "thumbs_down", basket: "work" });
      await repo.create({ kind: "dismiss", basket: "family" });
      await repo.create({ kind: "snooze", basket: "work" });
      await repo.create({ kind: "text_feedback", source: "agent_analysis", basket: "work" });

      const stats = await repo.stats({});

      assert.equal(stats.totalCount, 9);
      assert.equal(stats.grossHitCount, 5); // card_open + 3*card_action + thumbs_up
      assert.equal(stats.qualifiedHitCount, 2); // confirm + thumbs_up

      assert.equal(stats.kindDistribution["card_open"], 1);
      assert.equal(stats.kindDistribution["card_action"], 3);
      assert.equal(stats.kindDistribution["explicit_rating"], 2);
      assert.equal(stats.kindDistribution["dismiss"], 1);
      assert.equal(stats.kindDistribution["snooze"], 1);
      assert.equal(stats.kindDistribution["text_feedback"], 1);

      assert.equal(stats.actionDistribution["confirm"], 1);
      assert.equal(stats.actionDistribution["modify"], 1);
      assert.equal(stats.actionDistribution["later"], 1);
      assert.equal(stats.actionDistribution["thumbs_up"], 1);
      assert.equal(stats.actionDistribution["thumbs_down"], 1);

      assert.equal(stats.basketDistribution["work"], 7);
      assert.equal(stats.basketDistribution["health"], 1);
      assert.equal(stats.basketDistribution["family"], 1);
    } finally {
      await cleanup();
    }
  });

  test("stats with basket filter", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const repo = new FeedbackRepository(db);

      await repo.create({ kind: "card_action", action: "confirm", basket: "work" });
      await repo.create({ kind: "card_open", basket: "health" });
      await repo.create({ kind: "dismiss", basket: "work" });

      const workStats = await repo.stats({ basket: "work" });
      assert.equal(workStats.totalCount, 2);
      assert.equal(workStats.grossHitCount, 1); // confirm
      assert.equal(workStats.qualifiedHitCount, 1); // confirm
    } finally {
      await cleanup();
    }
  });
});
