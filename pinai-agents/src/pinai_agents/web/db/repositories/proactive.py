"""Proactive window cursor — per-(user, thread) timeline ingestion cursor.

Schema: 069_pai_proactive_inbox_state.sql (only pai_proactive_state survives;
the inbox + processing lease moved to the Agent Core kernel in RC-1, and the
events ledger was dropped in 084 as a zero-reader table).

What's left is just the ingestion cursor (pai_proactive_state.last_tick_at):
build_heartbeat_message reads it to know the timeline window since the last
heartbeat, and the scheduler advances it once the heartbeat is enqueued. Every
method must run inside a `user_scoped_tx` for the same user_id.
"""

from __future__ import annotations

from datetime import datetime

from psycopg.rows import dict_row

from .base import UserScopedRepository


class ProactiveRepository(UserScopedRepository):
    """RLS-scoped access to the proactive window cursor (pai_proactive_state).

    RC-1 moved the inbox + processing lease to the Agent Core kernel
    (pai_agent_messages + pai_agent_sessions); 084 dropped the events ledger.
    What remains is the per-thread ingestion cursor
    (pai_proactive_state.last_tick_at). Every method must run inside a
    `user_scoped_tx` for the same user_id.
    """

    async def _ensure_state(self, thread_id: str) -> None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO pai_proactive_state (user_id, thread_id) VALUES (%s, %s) "
                "ON CONFLICT (user_id, thread_id) DO NOTHING",
                (self._user_id, thread_id),
            )

    async def get_last_tick_at(self, *, thread_id: str) -> datetime:
        await self._ensure_state(thread_id)
        async with self._conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                "SELECT last_tick_at FROM pai_proactive_state "
                "WHERE user_id = %s AND thread_id = %s",
                (self._user_id, thread_id),
            )
            row = await cur.fetchone()
        if row is None:
            msg = "proactive state missing after ensure"
            raise RuntimeError(msg)
        return row["last_tick_at"]

    async def advance_last_tick_at(self, to: datetime, *, thread_id: str) -> None:
        """Move the window cursor forward when a tick turn is enqueued.
        Guarded so an out-of-order write can't rewind the cursor."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_proactive_state
                SET last_tick_at = GREATEST(last_tick_at, %s), updated_at = NOW()
                WHERE user_id = %s AND thread_id = %s
                """,
                (to, self._user_id, thread_id),
            )
