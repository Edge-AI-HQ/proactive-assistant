/**
 * DatabasePort-backed ambient outbox(平台无关)。注入 DatabasePort(RN=expo-sqlite /
 * 未来 Electron 等)实现 durable ambient-signal 队列——app kill 不丢未传信号。
 *
 * 复用 ambient-outbox 的 record-shaping + dedupe helpers(makeRecord /
 * shouldReplaceExistingOutboxRecord);schema / SQL 对照 web SqliteOutboxStore
 * (proactive-ai-frontend/services/ambient/outbox.ts),但**去掉 web 的历史数据
 * migration**(health resync / transcript cleanup —— 那是 web 存量用户的一次性迁移,
 * RN 全新无脏数据)。web 暂留自己的 @capacitor-community/sqlite 版;此实现走 DatabasePort
 * 抽象,未来 web 也可切。
 */
import type { DatabasePort } from "../ports/database";
import type { PersonalSignalInput } from "../domain/signals";
import {
  DEFAULT_TTL_MS,
  makeRecord,
  shouldReplaceExistingOutboxRecord,
  SYNCED_RETENTION_MS,
  type OutboxRecord,
  type OutboxStatus,
  type OutboxStore,
} from "./ambient-outbox";

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ambient_outbox (
  id TEXT PRIMARY KEY,
  item TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_retry_at INTEGER,
  inserted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER,
  synced_owner_user_id TEXT,
  synced_backend_url TEXT
)`;
const CREATE_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS ix_ambient_outbox_pending ON ambient_outbox (status, next_retry_at)";

export class SqliteOutboxStore implements OutboxStore {
  readonly kind = "sqlite" as const;
  private ready: Promise<void> | null = null;

  constructor(private readonly db: DatabasePort) {}

  private ensureSchema(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await this.db.run(CREATE_TABLE_SQL);
        await this.db.run(CREATE_INDEX_SQL);
      })().catch((err) => {
        this.ready = null; // 失败可重试
        throw err;
      });
    }
    return this.ready;
  }

  async enqueue(items: PersonalSignalInput[]): Promise<number> {
    if (items.length === 0) return 0;
    await this.ensureSchema();
    const now = Date.now();
    let inserted = 0;
    for (const item of items) {
      const record = makeRecord(item, now);
      const existing = await this.getByDedupeKey(record.dedupeKey);
      if (existing) {
        // dedupe:仅 transcript candidate window 的"更新鲜"版本才替换(core 语义)。
        if (!shouldReplaceExistingOutboxRecord(existing, record)) continue;
        await this.db.run(
          `UPDATE ambient_outbox
           SET item = ?, status = 'pending', attempt_count = 0, last_error = NULL,
               next_retry_at = NULL, updated_at = ?, synced_at = NULL,
               synced_owner_user_id = NULL, synced_backend_url = NULL
           WHERE dedupe_key = ?`,
          [JSON.stringify(record.item), now, record.dedupeKey],
        );
        inserted += 1;
        continue;
      }
      await this.db.run(
        `INSERT INTO ambient_outbox
           (id, item, dedupe_key, status, attempt_count, last_error, next_retry_at,
            inserted_at, updated_at, synced_at, synced_owner_user_id, synced_backend_url)
         VALUES (?, ?, ?, 'pending', 0, NULL, NULL, ?, ?, NULL, NULL, NULL)`,
        [record.id, JSON.stringify(record.item), record.dedupeKey, now, now],
      );
      inserted += 1;
    }
    return inserted;
  }

  private async getByDedupeKey(dedupeKey: string): Promise<OutboxRecord | null> {
    const rows = await this.db.query(
      "SELECT * FROM ambient_outbox WHERE dedupe_key = ? LIMIT 1",
      [dedupeKey],
    );
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  async pending(
    limit: number,
    now = Date.now(),
    ownerUserId: string | null = null,
    backendUrl: string | null = null,
  ): Promise<OutboxRecord[]> {
    await this.ensureSchema();
    const statusClause =
      ownerUserId || backendUrl
        ? `((status = 'pending' OR status = 'failed')
            OR (status = 'synced'
                AND (
                  (? IS NOT NULL AND (synced_owner_user_id IS NULL OR synced_owner_user_id <> ?))
                  OR (? IS NOT NULL AND (synced_backend_url IS NULL OR synced_backend_url <> ?))
                )))`
        : "(status = 'pending' OR status = 'failed')";
    const values =
      ownerUserId || backendUrl
        ? [ownerUserId, ownerUserId, backendUrl, backendUrl, now, limit]
        : [now, limit];
    const rows = await this.db.query(
      `SELECT * FROM ambient_outbox
       WHERE ${statusClause}
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY inserted_at ASC
       LIMIT ?`,
      values,
    );
    return rows.map(rowToRecord);
  }

  async markSynced(
    ids: string[],
    at = Date.now(),
    ownerUserId: string | null = null,
    backendUrl: string | null = null,
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.ensureSchema();
    const placeholders = ids.map(() => "?").join(",");
    await this.db.run(
      `UPDATE ambient_outbox
       SET status = 'synced', synced_at = ?, last_error = NULL, next_retry_at = NULL,
           synced_owner_user_id = ?, synced_backend_url = ?, updated_at = ?
       WHERE id IN (${placeholders})`,
      [at, ownerUserId, backendUrl, at, ...ids],
    );
  }

  async markFailed(ids: string[], error: string, nextRetryAt: number): Promise<void> {
    if (ids.length === 0) return;
    await this.ensureSchema();
    const placeholders = ids.map(() => "?").join(",");
    await this.db.run(
      `UPDATE ambient_outbox
       SET status = 'failed', attempt_count = attempt_count + 1,
           last_error = ?, next_retry_at = ?, updated_at = ?
       WHERE id IN (${placeholders})`,
      [error.slice(0, 500), nextRetryAt, Date.now(), ...ids],
    );
  }

  async prune(now = Date.now()): Promise<number> {
    await this.ensureSchema();
    // DatabasePort.run 不返回 changes,故先 count 再删,返回删除数。
    const where =
      "(status = 'synced' AND synced_at IS NOT NULL AND synced_at < ?) OR (inserted_at < ?)";
    const params = [now - SYNCED_RETENTION_MS, now - DEFAULT_TTL_MS];
    const rows = await this.db.query(`SELECT COUNT(*) AS n FROM ambient_outbox WHERE ${where}`, params);
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) await this.db.run(`DELETE FROM ambient_outbox WHERE ${where}`, params);
    return n;
  }

  async count(
    ownerUserId: string | null = null,
    backendUrl: string | null = null,
  ): Promise<number> {
    await this.ensureSchema();
    const rows =
      ownerUserId || backendUrl
        ? await this.db.query(
            `SELECT COUNT(*) AS n FROM ambient_outbox
             WHERE status <> 'synced'
                OR (? IS NOT NULL AND (synced_owner_user_id IS NULL OR synced_owner_user_id <> ?))
                OR (? IS NOT NULL AND (synced_backend_url IS NULL OR synced_backend_url <> ?))`,
            [ownerUserId, ownerUserId, backendUrl, backendUrl],
          )
        : await this.db.query("SELECT COUNT(*) AS n FROM ambient_outbox WHERE status <> 'synced'");
    return Number(rows[0]?.n ?? 0);
  }
}

function rowToRecord(row: Record<string, unknown>): OutboxRecord {
  const itemJson = typeof row.item === "string" ? row.item : "{}";
  let parsedItem: PersonalSignalInput;
  try {
    parsedItem = JSON.parse(itemJson) as PersonalSignalInput;
  } catch {
    parsedItem = { kind: "unknown", title: "", summary: "" };
  }
  const nullableNumber = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);
  const nullableString = (v: unknown): string | null =>
    v === null || v === undefined ? null : String(v);
  return {
    id: String(row.id),
    item: parsedItem,
    dedupeKey: String(row.dedupe_key ?? ""),
    status: (row.status as OutboxStatus) ?? "pending",
    attemptCount: Number(row.attempt_count ?? 0),
    lastError: nullableString(row.last_error),
    nextRetryAt: nullableNumber(row.next_retry_at),
    insertedAt: Number(row.inserted_at ?? Date.now()),
    updatedAt: Number(row.updated_at ?? row.inserted_at ?? Date.now()),
    syncedAt: nullableNumber(row.synced_at),
    syncedOwnerUserId: nullableString(row.synced_owner_user_id),
    syncedBackendUrl: nullableString(row.synced_backend_url),
  };
}
