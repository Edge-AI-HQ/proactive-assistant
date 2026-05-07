"""Chat thread metadata Repository.

Schema: 035_pai_chat_threads.sql.

`pai_chat_threads` is our owned metadata for chat sessions whose
actual conversation state lives in `langgraph.checkpoints`. Logical
join by `thread_id` string. See migration 035 for the lifecycle
contract (init inserts, send bumps, list reads).

All methods here run inside a user-scoped tx (BEGIN; SET LOCAL
app.user_id = $uid) so RLS pins reads/writes to one user.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from psycopg.rows import dict_row

from .base import UserScopedRepository

ThreadKind = Literal["main", "card"]


@dataclass(slots=True)
class ChatThreadRow:
    user_id: int
    thread_id: str
    kind: ThreadKind
    card_id: str | None
    title: str | None
    archived: bool
    created_at: datetime
    last_message_at: datetime | None
    message_count: int


class ChatThreadsRepository(UserScopedRepository):
    """CRUD for pai_chat_threads. Methods are RLS-scoped — each call
    must run inside a `user_scoped_tx` for the same user_id."""

    async def insert_thread(
        self,
        *,
        thread_id: str,
        kind: ThreadKind,
        card_id: str | None = None,
        title: str | None = None,
    ) -> None:
        """Idempotent insert. ON CONFLICT DO NOTHING because chat-stream/init
        may be called twice for the same sessionKey (FE re-mount, retry,
        etc.) and we don't want a 500 — the row is already there, that's fine.
        """
        async with self.conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_chat_threads
                  (user_id, thread_id, kind, card_id, title, last_message_at)
                VALUES (%s, %s, %s, %s, %s, NOW())
                ON CONFLICT (user_id, thread_id) DO NOTHING
                """,
                (self.user_id, thread_id, kind, card_id, title),
            )

    async def get_latest_main_thread_id(self) -> str | None:
        """Return the user's most-recently-active main thread, or None.

        Used by chat-stream/init when the FE has no localStorage cache —
        instead of minting a fresh thread (which orphans the user's
        history), we look up the latest existing one.

        Sort order:
          1. last_message_at DESC NULLS LAST — real recent activity wins
          2. message_count DESC — tiebreaker when timestamps tie (this
             matters most right after the 035 backfill, where all rows
             share the migration's NOW() — the longest conversation
             wins, which is what the user almost certainly wants back)
          3. created_at DESC — final tiebreaker for fully-tied rows
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

    async def list_threads(
        self,
        *,
        kind: ThreadKind | None = None,
        include_archived: bool = False,
        limit: int = 50,
    ) -> list[ChatThreadRow]:
        """List the user's threads, latest-active first.

        For a sidebar / picker UI. Reads only this metadata table —
        does NOT JOIN langgraph.checkpoints (that table is opaque to
        us; conversation content lookup goes through chat /agent/chat/
        history when needed).
        """
        clauses = ["user_id = %s"]
        params: list[object] = [self.user_id]
        if kind is not None:
            clauses.append("kind = %s")
            params.append(kind)
        if not include_archived:
            clauses.append("archived = FALSE")
        params.append(limit)
        async with self.conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                f"""
                SELECT user_id, thread_id, kind, card_id, title,
                       archived, created_at, last_message_at, message_count
                FROM pai_chat_threads
                WHERE {" AND ".join(clauses)}
                ORDER BY last_message_at DESC NULLS LAST, created_at DESC
                LIMIT %s
                """,
                params,
            )
            rows = await cur.fetchall()
        return [ChatThreadRow(**row) for row in rows]

    async def bump_after_send(self, *, thread_id: str) -> None:
        """Update last_message_at + increment count after a chat-stream/send
        finishes. Called from web's send route once the SSE stream completes.

        No-op if the row doesn't exist (e.g. send beat init somehow) — that
        case is logged but not raised; chat data already landed in
        langgraph.checkpoints, the metadata can be reconciled by next list.
        """
        async with self.conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_chat_threads
                SET last_message_at = NOW(),
                    message_count = message_count + 1
                WHERE user_id = %s AND thread_id = %s
                """,
                (self.user_id, thread_id),
            )

    async def archive_thread(self, *, thread_id: str) -> bool:
        """Soft-delete. Returns True if a row was archived, False if no
        such thread (or already archived). LangGraph checkpoints are kept
        — archive is reversible by flipping the bit back."""
        async with self.conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_chat_threads
                SET archived = TRUE
                WHERE user_id = %s AND thread_id = %s AND archived = FALSE
                """,
                (self.user_id, thread_id),
            )
            return (cur.rowcount or 0) > 0

    async def update_title(self, *, thread_id: str, title: str) -> None:
        """Set the human-readable title (e.g. user-edited or
        first-message-derived)."""
        async with self.conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_chat_threads
                SET title = %s
                WHERE user_id = %s AND thread_id = %s
                """,
                (title, self.user_id, thread_id),
            )
