"""RunRepository — one execution's lifecycle + HITL awaiting_input state.

A Run is created when a worker drains a session (or a batch one-shot fires).
Terminal: succeeded / failed / cancelled. HITL: a run pauses at
`awaiting_input` (stop_reason='requires_action', pending_action holds the
blocked tool_use_id); a tool decision resumes it. Stale `running` rows are
reaped by a free function on service_tx (mirrors reap_stale_runs for the
scheduler).

See docs/plans/2026-06-04-agentrun-control-plane.mdx §五/§七.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from psycopg import AsyncConnection
from psycopg.rows import DictRow, dict_row

from ..db.repositories.base import UserScopedRepository


@dataclass(slots=True)
class Run:
    id: str
    session_id: str | None
    agent_kind: str
    trigger: str
    status: str
    stop_reason: str | None
    pending_action: dict[str, Any] | None
    result: dict[str, Any] | None
    error: str | None


def _row_to_run(r: dict[str, Any]) -> Run:
    return Run(
        id=str(r["id"]),
        session_id=r.get("session_id"),
        agent_kind=r["agent_kind"],
        trigger=r["trigger"],
        status=r["status"],
        stop_reason=r.get("stop_reason"),
        pending_action=r.get("pending_action"),
        result=r.get("result"),
        error=r.get("error"),
    )


class RunRepository(UserScopedRepository):
    async def create(
        self,
        *,
        session_id: str | None,
        agent_kind: str,
        trigger: str,
        parent_run_id: str | None = None,
    ) -> str:
        """Create a Run already in `running` (the worker creates it at drain
        time and starts immediately). Returns the run_id (UUID)."""
        async with self._conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                INSERT INTO pai_agent_runs
                  (session_id, user_id, agent_kind, parent_run_id, trigger, status, started_at)
                VALUES (%s, %s, %s, %s, %s, 'running', NOW())
                RETURNING id
                """,
                (session_id, self._user_id, agent_kind, parent_run_id, trigger),
            )
            row = await cur.fetchone()
        if row is None:
            msg = "agent run create returned no row"
            raise RuntimeError(msg)
        return str(row["id"])

    async def complete(self, *, run_id: str, result: dict[str, Any] | None = None) -> None:
        await self._terminal(run_id, "succeeded", result=result, stop_reason="end_turn")

    async def fail(self, *, run_id: str, error: str) -> None:
        await self._terminal(run_id, "failed", error=error, stop_reason="error")

    async def cancel(self, *, run_id: str, reason: str) -> None:
        await self._terminal(run_id, "cancelled", cancel_reason=reason, stop_reason="cancelled")

    async def _terminal(
        self,
        run_id: str,
        status: str,
        *,
        result: dict[str, Any] | None = None,
        error: str | None = None,
        cancel_reason: str | None = None,
        stop_reason: str | None = None,
    ) -> None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_agent_runs
                SET status = %s, stop_reason = %s, result = %s::jsonb,
                    error = %s, cancel_reason = %s, ended_at = NOW()
                WHERE id = %s AND user_id = %s
                """,
                (
                    status,
                    stop_reason,
                    json.dumps(result) if result is not None else None,
                    error,
                    cancel_reason,
                    run_id,
                    self._user_id,
                ),
            )

    async def set_awaiting(self, *, run_id: str, pending_action: dict[str, Any]) -> None:
        """Pause a run at a HITL tool decision (langgraph interrupt())."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_agent_runs
                SET status = 'awaiting_input', stop_reason = 'requires_action',
                    pending_action = %s::jsonb
                WHERE id = %s AND user_id = %s
                """,
                (json.dumps(pending_action), run_id, self._user_id),
            )

    async def resume_running(self, *, run_id: str) -> None:
        """Move a paused run back to running on resume (Command(resume=))."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_agent_runs
                SET status = 'running', stop_reason = NULL, pending_action = NULL
                WHERE id = %s AND user_id = %s AND status = 'awaiting_input'
                """,
                (run_id, self._user_id),
            )

    async def get(self, *, run_id: str) -> Run | None:
        async with self._conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                "SELECT * FROM pai_agent_runs WHERE id = %s AND user_id = %s",
                (run_id, self._user_id),
            )
            row = await cur.fetchone()
        return _row_to_run(row) if row is not None else None

    async def get_awaiting(self, *, session_id: str) -> Run | None:
        """The session's run paused on a tool decision, if any."""
        async with self._conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                SELECT * FROM pai_agent_runs
                WHERE session_id = %s AND user_id = %s AND status = 'awaiting_input'
                ORDER BY created_at DESC LIMIT 1
                """,
                (session_id, self._user_id),
            )
            row = await cur.fetchone()
        return _row_to_run(row) if row is not None else None

    async def get_active(self, *, session_id: str) -> Run | None:
        """The session's most recent non-terminal run (pending / running /
        awaiting_input), for cancel to target. None if all runs are terminal."""
        async with self._conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                SELECT * FROM pai_agent_runs
                WHERE session_id = %s AND user_id = %s
                  AND status IN ('pending', 'running', 'awaiting_input')
                ORDER BY created_at DESC LIMIT 1
                """,
                (session_id, self._user_id),
            )
            row = await cur.fetchone()
        return _row_to_run(row) if row is not None else None


async def reap_stale_runs(
    conn: AsyncConnection[DictRow], *, ttl_seconds: int, limit: int = 100
) -> int:
    """Fail `running` rows whose start is older than ttl (worker crashed
    mid-relay). service_tx, cross-user. Returns count reaped. Mirrors
    scheduled_tasks.reap_stale_runs. Does NOT touch awaiting_input (those
    are legitimately paused on a human)."""
    async with conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(
            """
            UPDATE pai_agent_runs
            SET status = 'failed', stop_reason = 'error',
                error = 'run lease expired (worker crashed)', ended_at = NOW()
            WHERE id IN (
              SELECT id FROM pai_agent_runs
              WHERE status = 'running'
                AND started_at < NOW() - (%s::int * INTERVAL '1 second')
              LIMIT %s
            )
            """,
            (ttl_seconds, limit),
        )
        return cur.rowcount or 0
