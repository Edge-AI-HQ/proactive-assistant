"""Chat message log Repository — append-only conversation history.

Schema: 079_pai_chat_messages.sql. This is the SSOT for chat history
*display*, decoupled from langgraph.checkpoints (the agent's running
state). One row per conversation turn; `parts` holds the exact
HistoryMessage parts shape that chat/routes/history.py:_build_history
emits and the frontend already renders.

RLS-scoped: every method must run inside a `user_scoped_tx` for the same
user_id (see base.UserScopedRepository). `id` is a global IDENTITY, so it
doubles as the newest-first pagination cursor.
"""

from __future__ import annotations

from typing import Any, Literal

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .base import UserScopedRepository

Role = Literal["user", "assistant"]


class ChatMessagesRepository(UserScopedRepository):
    """CRUD for pai_chat_messages. Append-only per (user, thread)."""

    async def append_turn(
        self, *, thread_id: str, role: Role, parts: list[dict[str, Any]],
    ) -> int:
        """Append one turn. Returns the new row id (== conversation order)."""
        async with self.conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                INSERT INTO pai_chat_messages (user_id, thread_id, role, parts)
                VALUES (%s, %s, %s, %s)
                RETURNING id
                """,
                (self.user_id, thread_id, role, Jsonb(parts)),
            )
            row = await cur.fetchone()
            return int(row["id"])

    async def bulk_append(
        self, *, thread_id: str, turns: list[dict[str, Any]],
    ) -> int:
        """Insert many turns in order (lazy-backfill from checkpoint history).

        `turns` are HistoryMessage dicts ({role, parts, ...}); executemany
        preserves order so `id` reflects conversation order. Returns count.
        """
        if not turns:
            return 0
        async with self.conn.cursor() as cur:
            await cur.executemany(
                """
                INSERT INTO pai_chat_messages (user_id, thread_id, role, parts)
                VALUES (%s, %s, %s, %s)
                """,
                [
                    (self.user_id, thread_id, t["role"], Jsonb(t["parts"]))
                    for t in turns
                ],
            )
        return len(turns)

    async def get_page(
        self, *, thread_id: str, before_id: int | None = None, limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Newest-first page of turns. `before_id` is an exclusive cursor for
        "load older" (pass the smallest id from the previous page). Returns
        rows with id / role / parts / created_at, newest first."""
        async with self.conn.cursor(row_factory=dict_row) as cur:
            if before_id is None:
                await cur.execute(
                    """
                    SELECT id, role, parts, created_at
                    FROM pai_chat_messages
                    WHERE user_id = %s AND thread_id = %s
                    ORDER BY id DESC
                    LIMIT %s
                    """,
                    (self.user_id, thread_id, limit),
                )
            else:
                await cur.execute(
                    """
                    SELECT id, role, parts, created_at
                    FROM pai_chat_messages
                    WHERE user_id = %s AND thread_id = %s AND id < %s
                    ORDER BY id DESC
                    LIMIT %s
                    """,
                    (self.user_id, thread_id, before_id, limit),
                )
            return await cur.fetchall()

    async def latest_id(self, *, thread_id: str) -> int | None:
        """Max id for a thread, or None if it has no rows yet. Used by /init
        for the `existing` flag and by /history as the lazy-backfill sentinel
        (None → thread predates pai_chat_messages, backfill from checkpoint)."""
        async with self.conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                SELECT MAX(id) AS max_id
                FROM pai_chat_messages
                WHERE user_id = %s AND thread_id = %s
                """,
                (self.user_id, thread_id),
            )
            row = await cur.fetchone()
            return int(row["max_id"]) if row and row["max_id"] is not None else None

    async def last_user_text(self, *, thread_id: str) -> str | None:
        """Plain text of the most recent user turn (for the edit-vs-regenerate
        decision in chat_send). Reads the first text part of that turn."""
        async with self.conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                SELECT parts -> 0 ->> 'text' AS text
                FROM pai_chat_messages
                WHERE user_id = %s AND thread_id = %s AND role = 'user'
                ORDER BY id DESC
                LIMIT 1
                """,
                (self.user_id, thread_id),
            )
            row = await cur.fetchone()
            return row["text"] if row else None

    async def delete_tail(self, *, thread_id: str, count: int) -> int:
        """Delete the most-recent `count` rows of a thread. Used to keep the
        log consistent with chat's RemoveMessage state surgery on
        regenerate (delete 1: stale assistant) / edit (delete 2: stale
        user + assistant) before the fresh turn(s) are appended."""
        if count <= 0:
            return 0
        async with self.conn.cursor() as cur:
            await cur.execute(
                """
                DELETE FROM pai_chat_messages
                WHERE id IN (
                    SELECT id FROM pai_chat_messages
                    WHERE user_id = %s AND thread_id = %s
                    ORDER BY id DESC
                    LIMIT %s
                )
                """,
                (self.user_id, thread_id, count),
            )
            return cur.rowcount
