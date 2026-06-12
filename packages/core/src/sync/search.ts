/**
 * 本地全文搜索（Sync-C）—— FTS5 over messages + cards。索引由引擎在
 * 写入时同步维护（messages：syncMessages 事务内 delete+insert；cards：
 * syncCards 全量重建）。搜索 API 是命令式纯函数——UI 入口是后续产品
 * 迭代，core 先就绪。
 */
import type { DatabasePort } from "../ports/database";

/** 从 message parts 提取可检索文本（text/reasoning；工具调用不索引）。
 *  参数取最小结构型——history part 与 streaming part 两个 union 都能进。 */
export function extractSearchText(
  parts: ReadonlyArray<{ type: string; text?: string }>,
): string {
  return parts
    .flatMap((p) =>
      (p.type === "text" || p.type === "reasoning") && p.text ? [p.text] : [],
    )
    .join("\n")
    .trim();
}

export interface MessageSearchHit {
  messageId: string;
  threadId: string;
  snippet: string;
}

export interface CardSearchHit {
  cardId: string;
  snippet: string;
}

/** FTS5 query 语法对裸引号/操作符敏感——包成短语匹配，用户输入原样可搜。 */
function ftsQuote(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

export async function searchLocalMessages(
  db: DatabasePort,
  query: string,
  limit = 20,
): Promise<MessageSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const rows = await db.query(
    `SELECT message_id, thread_id,
            snippet(messages_fts, 0, '<b>', '</b>', '…', 12) AS snip
     FROM messages_fts WHERE messages_fts MATCH ? LIMIT ?`,
    [ftsQuote(q), limit],
  );
  return rows.map((r) => ({
    messageId: String(r.message_id),
    threadId: String(r.thread_id),
    snippet: String(r.snip ?? ""),
  }));
}

export async function searchLocalCards(
  db: DatabasePort,
  query: string,
  limit = 20,
): Promise<CardSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const rows = await db.query(
    `SELECT card_id, snippet(cards_fts, 0, '<b>', '</b>', '…', 12) AS snip
     FROM cards_fts WHERE cards_fts MATCH ? LIMIT ?`,
    [ftsQuote(q), limit],
  );
  return rows.map((r) => ({
    cardId: String(r.card_id),
    snippet: String(r.snip ?? ""),
  }));
}
