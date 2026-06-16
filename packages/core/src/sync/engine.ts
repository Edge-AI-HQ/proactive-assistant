/**
 * 同步引擎（Sync-B2，影子模式）—— /api/sync/* delta 协议的客户端：
 * per-domain 游标管理 + 分页拉取 + 幂等 upsert 进本地库，
 * 「行写入 + 游标推进」同事务原子提交。
 *
 * server-authoritative：本地库是可全删重建的镜像，冲突不存在（messages
 * append-only；threads 软状态随行 upsert）。**并发契约：调用方负责把
 * 所有 sync/drain 操作串行**（Capacitor 等单连接 driver 上并发显式事务
 * 会嵌套/交错，见 capacitor-database.ts 头注释）。HTTP 经注入的 transport
 * （proxyFetch），SQLite 经注入的 DatabasePort——引擎本体纯 TS 三端共用，
 * 回放测试用 better-sqlite3 真库跑（engine.test.ts）。
 * 设计 SSOT：research/2026-06-11-local-sync-engine.mdx §4.2。
 */
import { proxyFetch } from "../transport/http";
import { fetchCards } from "../api/cards";
import type { DatabasePort, SqlParam } from "../ports/database";
import { ensureSyncSchema } from "./schema";
import { extractSearchText } from "./search";
import type { ConversationHistoryMessage } from "../api/conversation";

const PAGE_LIMIT = 500;
/** 单域单次 sync 的页数保险丝——防御协议 bug（hasMore 永真/游标不前进）
 *  导致的死循环；正常 bootstrap 一个 thread 远小于此。 */
const MAX_PAGES_PER_RUN = 50;

export type SyncLogger = (msg: string, extra?: Record<string, unknown>) => void;

interface SyncedThreadRow {
  threadId: string;
  kind: string;
  cardId: string | null;
  archived: boolean;
  messageCount: number;
  lastMessageAt: string | null;
  updatedAt: string;
}

interface MessagesDeltaPage {
  ok: boolean;
  rows: ConversationHistoryMessage[];
  cursor: number;
  hasMore: boolean;
}

interface ThreadsDeltaPage {
  ok: boolean;
  rows: SyncedThreadRow[];
  cursor: string | null;
  hasMore: boolean;
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await proxyFetch(path);
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

export class SyncEngine {
  private readonly db: DatabasePort;
  private readonly log: SyncLogger;
  private schemaReady = false;

  constructor(opts: { db: DatabasePort; log?: SyncLogger }) {
    this.db = opts.db;
    this.log = opts.log ?? (() => {});
  }

  private async ensureReady(): Promise<void> {
    if (this.schemaReady) return;
    await ensureSyncSchema(this.db);
    this.schemaReady = true;
  }

  private async getCursor(domain: string): Promise<string | null> {
    const rows = await this.db.query(
      "SELECT cursor FROM sync_state WHERE domain = ?",
      [domain],
    );
    const c = rows[0]?.cursor;
    return typeof c === "string" ? c : null;
  }

  /** Thread 元数据增量（per-user 全量小表）。 */
  async syncThreads(): Promise<{ pulled: number }> {
    await this.ensureReady();
    let cursor = await this.getCursor("threads");
    let pulled = 0;
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const qs = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (cursor) qs.set("cursor", cursor);
      const data = await fetchJson<ThreadsDeltaPage>(`/sync/threads?${qs}`);
      if (data.rows.length > 0) {
        await this.db.transaction(async (tx) => {
          for (const t of data.rows) {
            await tx.run(
              `INSERT OR REPLACE INTO threads
                 (thread_id, kind, card_id, archived, message_count, last_message_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                t.threadId,
                t.kind,
                t.cardId,
                t.archived ? 1 : 0,
                t.messageCount,
                t.lastMessageAt,
                t.updatedAt,
              ],
            );
          }
          if (data.cursor) {
            await tx.run(
              "INSERT OR REPLACE INTO sync_state (domain, cursor, synced_at) VALUES (?, ?, ?)",
              ["threads", data.cursor, Date.now()],
            );
          }
        });
        pulled += data.rows.length;
        cursor = data.cursor;
      }
      if (!data.hasMore) break;
    }
    this.log("sync:threads done", { pulled });
    return { pulled };
  }

  /** 单个 thread 的消息增量（id cursor；lazy incomplete model——只同步
   *  调用方点名的 thread，不全量扫库）。 */
  async syncMessages(threadId: string): Promise<{ pulled: number }> {
    await this.ensureReady();
    const domain = `messages:${threadId}`;
    let since = Number((await this.getCursor(domain)) ?? 0);
    let pulled = 0;
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const qs = new URLSearchParams({
        session: threadId,
        since: String(since),
        limit: String(PAGE_LIMIT),
      });
      const data = await fetchJson<MessagesDeltaPage>(`/sync/messages?${qs}`);
      if (data.rows.length > 0) {
        await this.db.transaction(async (tx) => {
          for (const m of data.rows) {
            await tx.run(
              `INSERT OR REPLACE INTO messages
                 (id, thread_id, role, parts_json, trigger_kind, client_msg_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                Number(m.id),
                threadId,
                m.role,
                JSON.stringify(m.parts ?? []),
                null, // trigger_kind: 无（proactive 退役后不再有 tick turn）
                m.clientMsgId ?? null,
                m.createdAt ?? null,
              ],
            );
            // FTS 同事务维护（fts5 无 upsert：delete+insert by message_id）。
            // 行 append-only 下 delete 通常空转，重放/全删重建时保证不重。
            await tx.run("DELETE FROM messages_fts WHERE message_id = ?", [String(m.id)]);
            const text = extractSearchText(m.parts ?? []);
            if (text) {
              await tx.run(
                "INSERT INTO messages_fts (text, thread_id, message_id) VALUES (?, ?, ?)",
                [text, threadId, String(m.id)],
              );
            }
          }
          await tx.run(
            "INSERT OR REPLACE INTO sync_state (domain, cursor, synced_at) VALUES (?, ?, ?)",
            [domain, String(data.cursor), Date.now()],
          );
        });
        pulled += data.rows.length;
        since = data.cursor;
      }
      if (!data.hasMore) break;
    }
    this.log("sync:messages done", { threadId, pulled });
    return { pulled };
  }

  /** Cards 镜像（Sync-C）：/cards 是「最新 200 张」的有界投影（outcome
   *  可变、join 自 feedback），delta 化投影不值得——全量 upsert 小表 +
   *  FTS 全量重建（几十 KB 级）。读路径仍走 TQ+persister（Sync-A），
   *  本表的用途是 FTS 索引源与未来更大容量。 */
  async syncCards(limit = 200): Promise<{ pulled: number; newCardIds: string[] }> {
    await this.ensureReady();
    const entries = await fetchCards(limit);
    let newCardIds: string[] = [];
    await this.db.transaction(async (tx) => {
      const existing = new Set(
        (await tx.query("SELECT card_id FROM cards")).map((r) => String(r.card_id)),
      );
      // 「新卡」= 相对已有镜像的增量；空镜像（首轮 bootstrap）没有增量
      // 语义——全部判旧，消费方（桌面通知）天然不被首轮轰炸。
      newCardIds =
        existing.size === 0
          ? []
          : entries.map((e) => e.card.id).filter((id) => !existing.has(id));
      await tx.run("DELETE FROM cards");
      await tx.run("DELETE FROM cards_fts");
      for (const e of entries) {
        await tx.run(
          `INSERT INTO cards
             (card_id, payload_json, run_id, run_completed_at, score_json,
              latest_outcome, outcome_at, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            e.card.id,
            JSON.stringify(e.card),
            e.runId,
            e.runCompletedAt,
            e.score ? JSON.stringify(e.score) : null,
            e.latestOutcome,
            e.outcomeAt,
            Date.now(),
          ],
        );
        const text = [e.card.title, e.card.summary, e.card.whyNow]
          .filter(Boolean)
          .join("\n");
        if (text) {
          await tx.run("INSERT INTO cards_fts (text, card_id) VALUES (?, ?)", [
            text,
            e.card.id,
          ]);
        }
      }
    });
    this.log("sync:cards done", { pulled: entries.length, new: newCardIds.length });
    return { pulled: entries.length, newCardIds };
  }

  /** 影子模式的可观测快照：本地库各表行数 + 游标（与服务端人工比对）。 */
  async stats(): Promise<Record<string, unknown>> {
    await this.ensureReady();
    const [threads] = await this.db.query("SELECT COUNT(*) AS n FROM threads");
    const [messages] = await this.db.query("SELECT COUNT(*) AS n FROM messages");
    const [cards] = await this.db.query("SELECT COUNT(*) AS n FROM cards");
    const [outbox] = await this.db.query("SELECT COUNT(*) AS n FROM outbox");
    const cursors = await this.db.query(
      "SELECT domain, cursor FROM sync_state ORDER BY domain",
    );
    return {
      threads: threads?.n,
      messages: messages?.n,
      cards: cards?.n,
      outboxPending: outbox?.n,
      cursors,
    };
  }
}
