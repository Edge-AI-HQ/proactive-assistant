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

# Persisted turn roles. 'user' / 'assistant' are the visible conversation;
# 'heartbeat' is a proactive tick's input (the ~30s ambient heartbeat text fed to
# the agent) — a debug-only row so a reconnect / Debug-toggle can rebuild the
# proactive Debug transcript from the table (live frames are never persisted).
# 079 + 083.
Role = Literal["user", "assistant", "heartbeat"]
# How an assistant turn was triggered. 'user' for every main-chat turn and the
# user side of a proactive exchange; 'tick' for a heartbeat-triggered proactive
# assistant turn (the frontend marks those debug-only unless they reached out).
Trigger = Literal["user", "tick"]


def row_to_history_message(row: dict[str, Any]) -> dict[str, Any]:
    """A pai_chat_messages row → the frontend HistoryMessage shape. `trigger`
    rides along so the proactive page can mark tick-triggered assistant turns
    (absent / 'user' for main + card). Shared by /api/conversation/history and
    /api/sync/messages — one resource, one shape."""
    out: dict[str, Any] = {"id": str(row["id"]), "role": row["role"], "parts": row["parts"]}
    trigger = row.get("trigger")
    if trigger and trigger != "user":
        out["trigger"] = trigger
    created = row.get("created_at")
    if created is not None:
        out["createdAt"] = int(created.timestamp() * 1000)
    client_msg_id = row.get("client_msg_id")
    if client_msg_id:
        out["clientMsgId"] = client_msg_id
    return out


class ChatMessagesRepository(UserScopedRepository):
    """CRUD for pai_chat_messages. Append-only per (user, thread)."""

    async def append_turn(
        self,
        *,
        thread_id: str,
        role: Role,
        parts: list[dict[str, Any]],
        trigger: Trigger = "user",
        client_msg_id: str | None = None,
    ) -> int:
        """Append one turn. Returns the new row id (== conversation order).
        `client_msg_id` is the producer's idempotency key (the FE's client
        message id for a user turn) — stamped so the FE reconciles its
        optimistic bubble by identity; None for assistant/heartbeat rows."""
        async with self.conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                INSERT INTO pai_chat_messages
                  (user_id, thread_id, role, parts, trigger, client_msg_id)
                VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (self.user_id, thread_id, role, Jsonb(parts), trigger, client_msg_id),
            )
            row = await cur.fetchone()
            if row is None:  # INSERT ... RETURNING id always yields a row
                msg = "append: INSERT did not return an id"
                raise RuntimeError(msg)
            return int(row["id"])

    async def bulk_append(
        self,
        *,
        thread_id: str,
        turns: list[dict[str, Any]],
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
                INSERT INTO pai_chat_messages (user_id, thread_id, role, parts, trigger)
                VALUES (%s, %s, %s, %s, %s)
                """,
                [
                    (
                        self.user_id,
                        thread_id,
                        t["role"],
                        Jsonb(t["parts"]),
                        t.get("trigger", "user"),
                    )
                    for t in turns
                ],
            )
        return len(turns)

    async def get_page(
        self,
        *,
        thread_id: str,
        before_id: int | None = None,
        limit: int = 50,
        include_debug: bool = True,
    ) -> list[dict[str, Any]]:
        """Newest-first page of turns. `before_id` is an exclusive cursor for
        "load older" (pass the smallest id from the previous page). Returns
        rows with id / role / parts / trigger / created_at / client_msg_id,
        newest first.

        `include_debug=False` drops proactive debug-only rows so the default
        (non-Debug) view matches the live transcript: heartbeat input rows and
        'silent' tick turns (trigger='tick' with no notify_user) are hidden,
        while tick turns that reached out (a notify_user part) stay visible.
        Main-chat / card threads have no such rows, so the filter is a no-op
        there. The clause is a fixed literal (no user input) — safe to inline."""
        # A tick turn stays visible iff it carries a notify_user tool-call part.
        # The containment matches the part shape ChatTurnRecorder emits and keeps
        # this in sync with FE `partsHaveNotifyUser` (both gate on
        # type == 'tool-call' AND toolName). Perf: this is a
        # per-row JSONB filter after the (user_id, thread_id, id DESC) index
        # ordering — a thread with many silent ticks scans them to fill a page;
        # heavy proactive threads need debug-row retention (see migration 083).
        debug_clause = (
            ""
            if include_debug
            else (
                " AND role <> 'heartbeat'"
                " AND (trigger <> 'tick' OR parts @>"
                ' \'[{"type": "tool-call", "toolName": "notify_user"}]\'::jsonb)'
            )
        )
        async with self.conn.cursor(row_factory=dict_row) as cur:
            if before_id is None:
                await cur.execute(
                    f"""
                    SELECT id, role, parts, trigger, created_at, client_msg_id
                    FROM pai_chat_messages
                    WHERE user_id = %s AND thread_id = %s{debug_clause}
                    ORDER BY id DESC
                    LIMIT %s
                    """,
                    (self.user_id, thread_id, limit),
                )
            else:
                await cur.execute(
                    f"""
                    SELECT id, role, parts, trigger, created_at, client_msg_id
                    FROM pai_chat_messages
                    WHERE user_id = %s AND thread_id = %s AND id < %s{debug_clause}
                    ORDER BY id DESC
                    LIMIT %s
                    """,
                    (self.user_id, thread_id, before_id, limit),
                )
            return await cur.fetchall()

    async def get_since(
        self,
        *,
        thread_id: str,
        since_id: int = 0,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        """Delta page for the local sync engine (`/api/sync/messages`):
        rows with id > since_id, OLDEST first so the client applies them in
        append order. `since_id=0` is the bootstrap read. Rows are immutable
        (append-only log), so a monotonically advancing id cursor replays the
        thread exactly once — no tombstones, no updated_at needed. Uses the
        same (user_id, thread_id, id) index as get_page, scanned ascending."""
        async with self.conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                SELECT id, role, parts, trigger, created_at, client_msg_id
                FROM pai_chat_messages
                WHERE user_id = %s AND thread_id = %s AND id > %s
                ORDER BY id ASC
                LIMIT %s
                """,
                (self.user_id, thread_id, since_id, limit),
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
