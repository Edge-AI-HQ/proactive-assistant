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

from pinai_contracts.agent_run import MessageSource
from pinai_db.base import UserScopedRepository
from psycopg.rows import dict_row


@dataclass(slots=True)
class Message:
    id: int
    session_id: str
    role: str
    source: str
    content: str | None
    meta: dict[str, Any] | None
    enqueued_at: datetime
    # The producer's dedupe key, doubling as the message's identity across
    # views: the FE sends its client message id here, and it flows through to
    # pai_chat_messages.client_msg_id + /history `active.userEntries` so the
    # optimistic bubble reconciles by id, not text. Internal producers use
    # their own keys (card-bootstrap-<id>); None when the producer sent none.
    idempotency_key: str | None = None
    # Set when a worker has claimed this row for a run. Unconsumed rows with
    # run_id=None are still editable queued inputs.
    run_id: str | None = None


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
                SELECT id, session_id, role, source, content, meta, enqueued_at,
                       idempotency_key, run_id
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
                idempotency_key=r.get("idempotency_key"),
                run_id=r.get("run_id"),
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

    async def mark_claimed(self, *, message_ids: list[int], run_id: str) -> None:
        """Stamp the run that has claimed these mailbox rows before the chat
        call starts. The rows stay unconsumed until the run finishes, so crash
        replay still works; queued-message edits/deletes can use run_id IS
        NULL to avoid touching input that is already inside the active run."""
        if not message_ids:
            return
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_agent_messages
                SET run_id = %s
                WHERE user_id = %s AND id = ANY(%s) AND consumed_at IS NULL
                """,
                (run_id, self._user_id, message_ids),
            )

    async def update_pending_user_message(
        self,
        *,
        session_id: str,
        client_msg_id: str,
        content: str,
    ) -> bool:
        """Edit a user-authored queued message that has not been claimed by a
        run yet. Returns False when the message is absent, already processing,
        consumed, or not a user message."""
        async with self._conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                UPDATE pai_agent_messages
                SET content = %s
                WHERE session_id = %s
                  AND user_id = %s
                  AND source = 'user'
                  AND idempotency_key = %s
                  AND consumed_at IS NULL
                  AND run_id IS NULL
                RETURNING id
                """,
                (content, session_id, self._user_id, client_msg_id),
            )
            row = await cur.fetchone()
        return row is not None

    async def delete_pending_user_message(
        self,
        *,
        session_id: str,
        client_msg_id: str,
    ) -> bool:
        """Delete a user-authored queued message before a run claims it."""
        async with self._conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                DELETE FROM pai_agent_messages
                WHERE session_id = %s
                  AND user_id = %s
                  AND source = 'user'
                  AND idempotency_key = %s
                  AND consumed_at IS NULL
                  AND run_id IS NULL
                RETURNING id
                """,
                (session_id, self._user_id, client_msg_id),
            )
            row = await cur.fetchone()
        return row is not None
