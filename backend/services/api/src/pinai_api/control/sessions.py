"""SessionRepository — actor instance + per-session drain lease.

Generalizes proactive's per-thread lease (migration 075) to every
conversational agent. The lease serializes a worker's drain of one session
cluster-wide; fencing means write/refresh ops check `lease_owner`, so an
owner whose lease expired and was stolen cannot keep writing.

Per-user ops go through `SessionRepository` (user_scoped_tx). The worker's
cross-user fallback scan is a free function on `service_tx` — mirrors
scheduled_tasks.claim_due_tasks.

See docs/plans/2026-06-04-agentrun-control-plane.mdx §四.2.
"""

from __future__ import annotations

from pinai_db.base import UserScopedRepository
from psycopg import AsyncConnection
from psycopg.rows import DictRow, dict_row


class SessionRepository(UserScopedRepository):
    async def ensure_session(self, *, session_id: str, agent_kind: str) -> None:
        """Idempotently create the session row (first message opens it)."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_agent_sessions (session_id, user_id, agent_kind)
                VALUES (%s, %s, %s)
                ON CONFLICT (session_id) DO NOTHING
                """,
                (session_id, self._user_id, agent_kind),
            )

    async def acquire_lease(self, *, session_id: str, owner: str, ttl_seconds: int) -> bool:
        """Win this session's drain lease iff free or expired. Returns True
        if this owner now holds it. The single conditional UPDATE makes
        "same session never drained by two workers" true cluster-wide."""
        async with self._conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                UPDATE pai_agent_sessions
                SET lease_owner = %s,
                    lease_expires_at = NOW() + (%s::int * INTERVAL '1 second'),
                    updated_at = NOW()
                WHERE session_id = %s AND user_id = %s
                  AND (lease_owner IS NULL OR lease_expires_at < NOW())
                RETURNING session_id
                """,
                (owner, ttl_seconds, session_id, self._user_id),
            )
            return (await cur.fetchone()) is not None

    async def refresh_lease(self, *, session_id: str, owner: str, ttl_seconds: int) -> bool:
        """Fencing heartbeat — extend only if we still own the lease.
        Returns False if stolen (caller must stop relaying / writing)."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_agent_sessions
                SET lease_expires_at = NOW() + (%s::int * INTERVAL '1 second'),
                    updated_at = NOW()
                WHERE session_id = %s AND user_id = %s AND lease_owner = %s
                """,
                (ttl_seconds, session_id, self._user_id, owner),
            )
            return (cur.rowcount or 0) > 0

    async def release_lease_if_empty(self, *, session_id: str, owner: str) -> bool:
        """Release only if the mailbox has no pending message. Returns True
        if released (drain loop may exit); False means a message arrived
        between the empty-check and here — keep looping. Single statement
        closes the enqueue-vs-release race."""
        async with self._conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                UPDATE pai_agent_sessions
                SET lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
                WHERE session_id = %s AND user_id = %s AND lease_owner = %s
                  AND NOT EXISTS (
                    SELECT 1 FROM pai_agent_messages
                    WHERE session_id = %s AND consumed_at IS NULL
                  )
                RETURNING session_id
                """,
                (session_id, self._user_id, owner, session_id),
            )
            return (await cur.fetchone()) is not None

    async def release_lease(self, *, session_id: str, owner: str) -> None:
        """Unconditional release (crash / cancel recovery). Pending messages
        stay pending for the next lease holder."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_agent_sessions
                SET lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
                WHERE session_id = %s AND user_id = %s AND lease_owner = %s
                """,
                (session_id, self._user_id, owner),
            )


async def scan_actionable_sessions(
    conn: AsyncConnection[DictRow], *, limit: int = 50
) -> list[tuple[str, int]]:
    """Worker interval-fallback scan (service_tx, cross-user): sessions that
    have pending messages and a free/expired lease. Returns (session_id,
    user_id). This is the correctness backstop — pg_notify is only a
    low-latency optimization; a dropped notify is recovered here. Mirrors
    scheduled_tasks.claim_due_tasks's role for the scheduler."""
    async with conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(
            """
            SELECT DISTINCT s.session_id, s.user_id
            FROM pai_agent_sessions s
            WHERE (s.lease_owner IS NULL OR s.lease_expires_at < NOW())
              AND EXISTS (
                SELECT 1 FROM pai_agent_messages m
                WHERE m.session_id = s.session_id AND m.consumed_at IS NULL
              )
            LIMIT %s
            """,
            (limit,),
        )
        rows = await cur.fetchall()
    return [(r["session_id"], int(r["user_id"])) for r in rows]


async def lookup_session(
    conn: AsyncConnection[DictRow], *, session_id: str
) -> tuple[int, str] | None:
    """Resolve session_id → (user_id, agent_kind), for the worker drain path
    (service_tx, cross-user). The wake/cancel signals carry only a
    session_id; the worker looks up owner + kind here before acquiring the
    user-scoped lease. None if the session doesn't exist."""
    async with conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(
            "SELECT user_id, agent_kind FROM pai_agent_sessions WHERE session_id = %s",
            (session_id,),
        )
        row = await cur.fetchone()
    return (int(row["user_id"]), row["agent_kind"]) if row is not None else None
