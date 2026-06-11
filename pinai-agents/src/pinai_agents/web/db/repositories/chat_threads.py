"""Chat thread metadata Repository.

Schema: 035_pai_chat_threads.sql + 053_pai_chat_threads_singleton.sql.

`pai_chat_threads` is our owned metadata for chat sessions whose
actual conversation state lives in `langgraph.checkpoints`. Logical
join by `thread_id` string. Main chat is a singleton per user (one
row, kind='main', enforced by partial UNIQUE index in migration 053);
card chat uses a deterministic `card-thread-<card_id>` key per card.

All methods here run inside a user-scoped tx (BEGIN; SET LOCAL
app.user_id = $uid) so RLS pins reads/writes to one user.
"""

from __future__ import annotations

from typing import Any, Literal

from psycopg.rows import dict_row

from .base import UserScopedRepository

ThreadKind = Literal["main", "card", "proactive"]


class ChatThreadsRepository(UserScopedRepository):
    """CRUD for pai_chat_threads. Methods are RLS-scoped — each call
    must run inside a `user_scoped_tx` for the same user_id."""

    async def insert_thread(
        self,
        *,
        thread_id: str,
        kind: ThreadKind,
        card_id: str | None = None,
    ) -> None:
        """Idempotent insert. ON CONFLICT DO NOTHING because conversation
        init/send may be called twice for the same sessionKey (FE re-mount,
        retry, etc.) and we don't want a 500 — the row is already there.
        """
        async with self.conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_chat_threads
                  (user_id, thread_id, kind, card_id, last_message_at)
                VALUES (%s, %s, %s, %s, NOW())
                ON CONFLICT (user_id, thread_id) DO NOTHING
                """,
                (self.user_id, thread_id, kind, card_id),
            )

    async def get_latest_main_thread_id(self) -> str | None:
        """Return the user's main thread, or None if they have none yet.

        Post-053 there's at most one non-archived main thread per user
        (partial UNIQUE index enforces it), so this is the singleton
        lookup. Sort order is kept conservatively in case any straggler
        rows remain from before the migration cleanup.
        """
        async with self.conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                SELECT thread_id FROM pai_chat_threads
                WHERE user_id = %s AND kind = 'main' AND archived = FALSE
                ORDER BY last_message_at DESC NULLS LAST,
                         message_count DESC,
                         created_at DESC
                LIMIT 1
                """,
                (self.user_id,),
            )
            row = await cur.fetchone()
            return row["thread_id"] if row else None

    async def bump_after_send(self, *, thread_id: str) -> int | None:
        """Update last_message_at + increment count after a conversation send
        is accepted (best-effort thread-list freshness, called by /send).

        Returns the new `message_count`, or None if no row was bumped
        (send beat init somehow) — that case is logged but not raised;
        chat data already landed in langgraph.checkpoints, the metadata
        can be reconciled by the next /init call.
        """
        async with self.conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                UPDATE pai_chat_threads
                SET last_message_at = NOW(),
                    message_count = message_count + 1,
                    updated_at = NOW()
                WHERE user_id = %s AND thread_id = %s
                RETURNING message_count
                """,
                (self.user_id, thread_id),
            )
            row = await cur.fetchone()
            if row is None:
                return None
            return int(row["message_count"])

    async def list_since(
        self,
        *,
        updated_after: str | None = None,
        after_thread_id: str | None = None,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        """Delta page for the local sync engine (`/api/sync/threads`):
        threads changed since the composite cursor (updated_at, thread_id),
        oldest-change first. Soft state (archived) is just another column on
        the upserted row — no tombstones (migration 093). Bootstrap read
        passes no cursor. Ties on updated_at are broken by thread_id so a
        page boundary never skips or repeats a row."""
        async with self.conn.cursor(row_factory=dict_row) as cur:
            if updated_after is None:
                await cur.execute(
                    """
                    SELECT thread_id, kind, card_id, archived, message_count,
                           last_message_at, created_at, updated_at
                    FROM pai_chat_threads
                    WHERE user_id = %s
                    ORDER BY updated_at ASC, thread_id ASC
                    LIMIT %s
                    """,
                    (self.user_id, limit),
                )
            else:
                await cur.execute(
                    """
                    SELECT thread_id, kind, card_id, archived, message_count,
                           last_message_at, created_at, updated_at
                    FROM pai_chat_threads
                    WHERE user_id = %s
                      AND (updated_at, thread_id) > (%s::timestamptz, %s)
                    ORDER BY updated_at ASC, thread_id ASC
                    LIMIT %s
                    """,
                    (self.user_id, updated_after, after_thread_id or "", limit),
                )
            return await cur.fetchall()
