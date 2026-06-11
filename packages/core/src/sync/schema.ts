/**
 * 本地同步库 schema（Sync-B2）—— 编号 migration 数组 + PRAGMA user_version
 * runner，三端同一套（同步引擎文档 §2.4：规避 ORM migration 的端差异）。
 *
 * 表设计镜像服务端形状但非 1:1 全列（够渲染与增量即可）；本地库永远可
 * 全删重建（server-authoritative），所以 migration 只前进、坏库直接重灌。
 */
import type { DatabasePort, DatabaseTx } from "../ports/database";

const MIGRATIONS: readonly string[] = [
  // v1 — Sync-B 域：threads / messages / 游标。
  `
  CREATE TABLE IF NOT EXISTS sync_state (
    domain TEXT PRIMARY KEY,
    cursor TEXT NOT NULL,
    synced_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS threads (
    thread_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    card_id TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    last_message_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL,
    parts_json TEXT NOT NULL,
    trigger_kind TEXT,
    client_msg_id TEXT,
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS ix_messages_thread ON messages (thread_id, id);
  `,
];

async function userVersion(db: DatabaseTx): Promise<number> {
  const rows = await db.query("PRAGMA user_version");
  const v = rows[0]?.user_version;
  return typeof v === "number" ? v : Number(v ?? 0);
}

/** 把本地库推进到最新 schema 版本。幂等；多语句 migration 逐句执行
 *  （capacitor 的 run 单语句限制）。 */
export async function ensureSyncSchema(db: DatabasePort): Promise<void> {
  const current = await userVersion(db);
  for (let v = current; v < MIGRATIONS.length; v++) {
    await db.transaction(async (tx) => {
      const statements = MIGRATIONS[v]
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of statements) {
        await tx.run(stmt);
      }
      // PRAGMA 不吃绑定参数；版本号来自常量数组索引，无注入面。
      await tx.run(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export const SYNC_SCHEMA_VERSION = MIGRATIONS.length;
