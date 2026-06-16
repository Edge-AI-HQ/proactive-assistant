/**
 * 本地同步库的读 API（Sync-B3）—— 把本地 messages 行还原成
 * `/api/conversation/history` 的 page 形状，供读路径「本地优先 + 网络
 * race」消费（B3b）。`awaiting`/`active` 是运行时状态不入库，恒为 null
 * ——读切换设计里这两个字段仍由网络 page 提供。
 */
import type {
  ConversationHistoryMessage,
  ConversationHistoryPage,
} from "../api/conversation";
import type { DatabasePort } from "../ports/database";

function rowToMessage(row: Record<string, unknown>): ConversationHistoryMessage {
  const out: ConversationHistoryMessage = {
    id: String(row.id),
    role: row.role as ConversationHistoryMessage["role"],
    parts: JSON.parse(String(row.parts_json ?? "[]")),
  };
  if (typeof row.created_at === "number") out.createdAt = row.created_at;
  if (typeof row.client_msg_id === "string" && row.client_msg_id) {
    out.clientMsgId = row.client_msg_id;
  }
  return out;
}

/** 最新一页（与 history 端点同语义：newest `limit` 条按 oldest-first 返回；
 *  `nextCursor` 是更旧历史的 before 游标，没有更旧时为 null）。空库返回
 *  null（调用方直接走网络，不渲染空首屏）。 */
export async function readLocalHistoryPage(
  db: DatabasePort,
  threadId: string,
  limit = 200,
): Promise<ConversationHistoryPage | null> {
  const rows = await db.query(
    `SELECT id, role, parts_json, trigger_kind, client_msg_id, created_at
     FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?`,
    [threadId, limit],
  );
  if (rows.length === 0) return null;
  const oldestFirst = rows.slice().reverse();
  const oldestId = Number(oldestFirst[0].id);
  const older = await db.query(
    "SELECT 1 FROM messages WHERE thread_id = ? AND id < ? LIMIT 1",
    [threadId, oldestId],
  );
  return {
    messages: oldestFirst.map(rowToMessage),
    nextCursor: older.length > 0 ? oldestId : null,
    awaiting: null,
    active: null,
  };
}
