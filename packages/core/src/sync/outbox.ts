/**
 * 通用 mutation outbox（Sync-C）—— ambient outbox 模式的泛化：
 * dedupe_key 幂等入队 + 指数退避重放。行存在即待投递——成功或永久放弃
 * （4xx / TTL 过期）即删行，没有状态列（区别于 ambient 的 synced 审计
 * 保留；本地移动端没有查「失败尸体」的消费方，删行即是表大小控制）。
 *
 * 当前接入面：**静默吞**的写点（card feedback——迁移前 POST 失败直接
 * swallow，弱网丢反馈）。有 UI 错误提示的写点（settings patch 等）不进
 * outbox——用户可见可重试，入队反而造成「界面说失败、后台又成功」的
 * 双写歧义。
 *
 * 并发契约：调用方负责串行（与 sync pass 同一调度队列）。drain 期间的
 * DELETE/UPDATE 若与他人事务交错，会在单连接 driver 上混入对方事务、
 * 随对方 ROLLBACK 复活已投递的行 → 重复投递。
 */
import { proxyPost } from "../transport/http";
import type { DatabasePort } from "../ports/database";

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;
const DRAIN_BATCH = 20;
/** 超过 7 天投递不出去的条目放弃（与 ambient outbox 的 TTL 一致）。 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

let seq = 0;
function outboxId(): string {
  seq += 1;
  return `ob-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 入队一个 POST（幂等：同 dedupeKey 已存在则忽略——重试场景天然合并）。 */
export async function enqueueOutbox(
  db: DatabasePort,
  path: string,
  body: unknown,
  dedupeKey?: string,
): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO outbox (id, path, body_json, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [outboxId(), path, JSON.stringify(body), dedupeKey ?? null, Date.now()],
  );
}

/** 投递到期条目：成功删行；网络失败/5xx 计数 + 指数退避；4xx（协议性
 *  失败，重试无意义）与 TTL 过期永久放弃（删行，计入 dropped）。 */
export async function drainOutbox(
  db: DatabasePort,
): Promise<{ sent: number; failed: number; dropped: number }> {
  const now = Date.now();
  const rows = await db.query(
    `SELECT id, path, body_json, attempt_count, created_at FROM outbox
     WHERE next_retry_at <= ?
     ORDER BY created_at ASC LIMIT ?`,
    [now, DRAIN_BATCH],
  );
  let sent = 0;
  let failed = 0;
  let dropped = 0;
  for (const row of rows) {
    const id = String(row.id);
    if (now - Number(row.created_at) > TTL_MS) {
      await db.run("DELETE FROM outbox WHERE id = ?", [id]);
      dropped += 1;
      continue;
    }
    try {
      const res = await proxyPost(String(row.path), JSON.parse(String(row.body_json)));
      if (res.ok) {
        await db.run("DELETE FROM outbox WHERE id = ?", [id]);
        sent += 1;
        continue;
      }
      if (res.status >= 400 && res.status < 500) {
        await db.run("DELETE FROM outbox WHERE id = ?", [id]);
        dropped += 1;
        continue;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      const attempt = Number(row.attempt_count) + 1;
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
      await db.run(
        `UPDATE outbox SET attempt_count = ?, last_error = ?, next_retry_at = ?
         WHERE id = ?`,
        [attempt, err instanceof Error ? err.message : String(err), now + delay, id],
      );
      failed += 1;
    }
  }
  return { sent, failed, dropped };
}
