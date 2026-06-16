import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { DatabasePort, DatabaseTx, SqlParam } from "../ports/database";
import { ensureSyncSchema } from "./schema";
import { readLocalHistoryPage } from "./local-read";

function driver(db: Database.Database): DatabasePort {
  const tx: DatabaseTx = {
    run: async (sql: string, params: SqlParam[] = []) => {
      db.prepare(sql).run(...params);
    },
    query: async (sql: string, params: SqlParam[] = []) =>
      db.prepare(sql).all(...params) as Record<string, unknown>[],
  };
  return {
    ...tx,
    transaction: async (fn) => {
      db.prepare("BEGIN").run();
      try {
        const out = await fn(tx);
        db.prepare("COMMIT").run();
        return out;
      } catch (err) {
        db.prepare("ROLLBACK").run();
        throw err;
      }
    },
  };
}

async function seed(db: DatabasePort, threadId: string, n: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await db.run(
      `INSERT INTO messages (id, thread_id, role, parts_json, trigger_kind, client_msg_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        i,
        threadId,
        i % 2 ? "user" : "assistant",
        JSON.stringify([{ type: "text", text: `m${i}` }]),
        null,
        i === 1 ? "cid-1" : null,
        i * 1000,
      ],
    );
  }
}

describe("readLocalHistoryPage", () => {
  it("returns the newest page oldest-first with a before-cursor when older rows exist", async () => {
    const db = driver(new Database(":memory:"));
    await ensureSyncSchema(db);
    await seed(db, "main-1", 5);

    const page = await readLocalHistoryPage(db, "main-1", 3);
    expect(page?.messages.map((m) => m.id)).toEqual(["3", "4", "5"]);
    expect(page?.nextCursor).toBe(3);
    expect(page?.awaiting).toBeNull();
    expect(page?.active).toBeNull();

    // 行字段还原成 history 形状。
    const full = await readLocalHistoryPage(db, "main-1", 10);
    expect(full?.nextCursor).toBeNull();
    expect(full?.messages[0]).toMatchObject({
      id: "1",
      role: "user",
      clientMsgId: "cid-1",
      createdAt: 1000,
      parts: [{ type: "text", text: "m1" }],
    });
  });

  it("returns null for an empty/unknown thread (caller falls through to network)", async () => {
    const db = driver(new Database(":memory:"));
    await ensureSyncSchema(db);
    expect(await readLocalHistoryPage(db, "nope")).toBeNull();
  });
});
