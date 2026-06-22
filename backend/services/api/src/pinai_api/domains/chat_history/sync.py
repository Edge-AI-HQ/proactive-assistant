"""/api/sync/* — 本地同步引擎的 delta 拉取协议（Sync-B1）。

设计 SSOT：research/2026-06-11-local-sync-engine.mdx §4.2。客户端本地库
（SQLite）经这里做 cursor 增量同步：bootstrap = 无 cursor 首拉，之后每次
带上次返回的 cursor 拿"自那以后"的变更；server-authoritative，客户端本地
库永远可全删重建。响应统一 { ok, rows, cursor, hasMore } 形状。

  GET /messages?session=&since=&limit= → pai_chat_messages 增量（per-thread）。
      行 append-only 不可变 → 单调 id 即 cursor，无 tombstone。行形状与
      /api/conversation/history 完全一致（共享 row_to_history_message）。
  GET /threads?cursor=&limit= → pai_chat_threads 增量（per-user 全量小表）。
      复合 cursor "updated_at|thread_id"（不透明字符串，原样回传）；软状态
      （archived）随行 upsert，无 tombstone。

鉴权与隔离：current_user + user_scoped_tx（RLS）——查询天然只见本用户的
行；不存在的 / 他人的 thread_id 返回空页而非 404（与增量语义一致：没有
新变更与无权可见不可区分，客户端行为相同）。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from pinai_db.rls import user_scoped_tx

from ...platform.auth.deps import User, current_user, get_pool
from ...platform.db.repositories.chat_messages import ChatMessagesRepository, row_to_history_message
from ...platform.db.repositories.chat_threads import ChatThreadsRepository

router = APIRouter(prefix="/api/sync", tags=["sync"])

_CURSOR_SEP = "|"


def _thread_row_to_payload(row: dict[str, Any]) -> dict[str, Any]:
    """A pai_chat_threads row → the sync wire shape (camelCase)."""
    return {
        "threadId": row["thread_id"],
        "kind": row["kind"],
        "cardId": row.get("card_id"),
        "archived": bool(row["archived"]),
        "messageCount": int(row.get("message_count") or 0),
        "lastMessageAt": (
            row["last_message_at"].isoformat() if row.get("last_message_at") else None
        ),
        "updatedAt": row["updated_at"].isoformat(),
    }


def encode_threads_cursor(row: dict[str, Any]) -> str:
    """复合 cursor：updated_at ISO + thread_id（tie-break）。thread_id 是
    我们自己生成的 key（main-<uid>-… / card-thread-…），不含分隔符。"""
    return f"{row['updated_at'].isoformat()}{_CURSOR_SEP}{row['thread_id']}"


def decode_threads_cursor(cursor: str | None) -> tuple[str | None, str | None]:
    """逆 encode；坏 cursor（手工篡改/版本漂移）按 bootstrap 处理——增量
    协议的容错语义：宁可多拉一遍（幂等 upsert 吸收）也不 500。"""
    if not cursor:
        return None, None
    head, sep, tail = cursor.partition(_CURSOR_SEP)
    if not sep or not head:
        return None, None
    return head, tail


@router.get("/messages")
async def sync_messages(
    session: str = Query(..., min_length=1, max_length=200),
    since: int = Query(default=0, ge=0),
    limit: int = Query(default=500, ge=1, le=1000),
    user: User = Depends(current_user),
    pool: Any = Depends(get_pool),
) -> dict[str, Any]:
    """Thread 消息增量：id > since 的行，oldest first（客户端按序 append 进
    本地库）。cursor 推进到本页最大 id；空页回传原 since。注意与 /history
    的分工：history 是「向旧翻页」（before 游标，UI 按需 hydrate），这里是
    「向新增量」（since 游标，同步引擎写库）——同一张表的两个读方向。"""
    async with user_scoped_tx(pool, user.id) as conn:
        repo = ChatMessagesRepository(user_id=user.id, conn=conn)
        rows = await repo.get_since(thread_id=session, since_id=since, limit=limit)
    return {
        "ok": True,
        "rows": [row_to_history_message(r) for r in rows],
        "cursor": int(rows[-1]["id"]) if rows else since,
        "hasMore": len(rows) == limit,
    }


@router.get("/threads")
async def sync_threads(
    cursor: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=500, ge=1, le=1000),
    user: User = Depends(current_user),
    pool: Any = Depends(get_pool),
) -> dict[str, Any]:
    """Thread 元数据增量：(updated_at, thread_id) > cursor 的行，oldest-change
    first。bump_after_send / 未来的 archive 路径都会推进 updated_at，所以
    状态变化（含软删的 archived 翻转）就是一次普通 upsert 增量。"""
    updated_after, after_thread_id = decode_threads_cursor(cursor)
    async with user_scoped_tx(pool, user.id) as conn:
        repo = ChatThreadsRepository(user_id=user.id, conn=conn)
        rows = await repo.list_since(
            updated_after=updated_after,
            after_thread_id=after_thread_id,
            limit=limit,
        )
    return {
        "ok": True,
        "rows": [_thread_row_to_payload(r) for r in rows],
        "cursor": encode_threads_cursor(rows[-1]) if rows else cursor,
        "hasMore": len(rows) == limit,
    }
