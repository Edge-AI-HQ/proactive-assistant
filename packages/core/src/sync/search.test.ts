/**
 * 本地全文搜索契约：extractSearchText 提取规则、FTS5 命中与 snippet、
 * 特殊字符当短语处理不报错、空查询不触库。
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { ensureSyncSchema } from "./schema";
import { extractSearchText, searchLocalCards, searchLocalMessages } from "./search";
import { betterSqliteDriver } from "./test-driver";

describe("extractSearchText", () => {
  it("keeps text + reasoning parts, drops tool calls and empties", () => {
    expect(
      extractSearchText([
        { type: "reasoning", text: "plan the trip" },
        { type: "toolCall" },
        { type: "text", text: "Booked it" },
        { type: "text", text: "" },
      ]),
    ).toBe("plan the trip\nBooked it");
    expect(extractSearchText([])).toBe("");
  });
});

describe("searchLocalMessages / searchLocalCards", () => {
  async function seeded() {
    const db = betterSqliteDriver(new Database(":memory:"));
    await ensureSyncSchema(db);
    await db.run("INSERT INTO messages_fts (text, thread_id, message_id) VALUES (?, ?, ?)", [
      "Renew the passport before July",
      "main-1",
      "11",
    ]);
    await db.run("INSERT INTO cards_fts (text, card_id) VALUES (?, ?)", [
      "Passport renewal\nexpires soon",
      "c1",
    ]);
    return db;
  }

  it("matches messages and cards with snippets", async () => {
    const db = await seeded();
    const msgs = await searchLocalMessages(db, "passport");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ messageId: "11", threadId: "main-1" });
    expect(msgs[0].snippet).toContain("<b>passport</b>");

    const cards = await searchLocalCards(db, "passport");
    expect(cards).toHaveLength(1);
    expect(cards[0].cardId).toBe("c1");
  });

  it("treats raw user input as a phrase — FTS5 operators/quotes cannot break the query", async () => {
    const db = await seeded();
    await expect(searchLocalMessages(db, 'AND "OR* (passport')).resolves.toEqual([]);
    await expect(searchLocalMessages(db, "  ")).resolves.toEqual([]);
  });
});
