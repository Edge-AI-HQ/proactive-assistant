"""MailboxRepository — the per-session input queue.

ANY input is one Message: user messages, system heartbeats, cron triggers,
HITL tool decisions. `role` is what the LLM sees (always 'user'); `source`
is what the worker routes/accounts on. A Run consumes ALL pending messages
at once (`claim_pending`) — this is the merge: a user's rapid follow-ups
become one next drain. consume-on-completion: `mark_consumed` is called
only after the Run returns, so a crash leaves them pending for replay.

See docs/plans/2026-06-04-agentrun-control-plane.mdx §四.3.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from psycopg.rows import dict_row

from ...shared.agent_run import MessageSource
from ..db.repositories.base import UserScopedRepository


@dataclass(slots=True)
class Message:
    id: int
    session_id: str
    role: str
    source: str
    content: str | None
    meta: dict[str, Any] | None
    enqueued_at: datetime


class MailboxRepository(UserScopedRepository):
    async def enqueue(
        self,
        *,
        session_id: str,
        source: MessageSource,
        content: str | None = None,
        meta: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
        role: str = "user",
    ) -> int | None:
        """Append one message. Returns its id, or None if the
        idempotency_key already exists for this session (deduped re-delivery
        / FE retry)."""
        async with self._conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                INSERT INTO pai_agent_messages
                  (session_id, user_id, role, source, content, meta, idempotency_key)
                VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s)
                ON CONFLICT (session_id, idempotency_key)
                  WHERE idempotency_key IS NOT NULL DO NOTHING
                RETURNING id
                """,
                (
                    session_id,
                    self._user_id,
                    role,
                    source,
                    content,
                    json.dumps(meta) if meta is not None else None,
                    idempotency_key,
                ),
            )
            row = await cur.fetchone()
        return int(row["id"]) if row is not None else None

    async def claim_pending(self, *, session_id: str) -> list[Message]:
        """Merge: ALL unconsumed messages for this session, FIFO. Single-
        consumer is guaranteed by the per-session lease, so no row-lock
        here. Empty list when nothing pending."""
        async with self._conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                SELECT id, session_id, role, source, content, meta, enqueued_at
                FROM pai_agent_messages
                WHERE session_id = %s AND user_id = %s AND consumed_at IS NULL
                ORDER BY id ASC
                """,
                (session_id, self._user_id),
            )
            rows = await cur.fetchall()
        return [
            Message(
                id=int(r["id"]),
                session_id=r["session_id"],
                role=r["role"],
                source=r["source"],
                content=r.get("content"),
                meta=r.get("meta"),
                enqueued_at=r["enqueued_at"],
            )
            for r in rows
        ]

    async def peek_pending(self, *, session_id: str) -> list[Message]:
        """Read-only view of the unconsumed queue (same rows claim_pending
        returns — neither mutates; consumption is stamped at mark_consumed).
        Backs /history's in-flight turn rebuild: consume-on-completion means a
        running turn's input rows stay pending until finalize, so this IS the
        durable source for the in-flight user message(s) across a refresh."""
        return await self.claim_pending(session_id=session_id)

    async def mark_consumed(self, *, message_ids: list[int], run_id: str | None) -> None:
        """consume-on-completion: stamp the merged batch after the Run returns,
        recording which run consumed them (audit). run_id=None marks a message
        consumed without a run — e.g. a stale tool_decision dropped when no run
        is awaiting (CC14)."""
        if not message_ids:
            return
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_agent_messages
                SET consumed_at = NOW(), run_id = %s
                WHERE user_id = %s AND id = ANY(%s)
                """,
                (run_id, self._user_id, message_ids),
            )
