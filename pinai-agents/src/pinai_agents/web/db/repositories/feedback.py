"""FeedbackRepository — pai_feedback_events writer + reader.

The frontend POSTs every card action through /api/feedback. Schema:
011_pai_memory_signals.sql.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .base import UserScopedRepository


@dataclass(slots=True)
class FeedbackRow:
    id: str
    kind: str
    action: str | None
    push_id: str | None
    intent_card_id: str | None
    intent_key: str | None
    source: str
    basket: str | None
    value: str | None
    text: str | None
    metadata: dict[str, Any]
    conversation_id: str | None
    message_id: str | None
    channel: str | None
    created_at: datetime

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> FeedbackRow:
        meta = row["metadata"]
        if not isinstance(meta, dict):
            meta = json.loads(meta) if meta else {}
        return cls(
            id=row["id"], kind=row["kind"], action=row.get("action"),
            push_id=row.get("push_id"),
            intent_card_id=row.get("intent_card_id"),
            intent_key=row.get("intent_key"),
            source=row["source"], basket=row.get("basket"),
            value=row.get("value"), text=row.get("text"),
            metadata=meta,
            conversation_id=row.get("conversation_id"),
            message_id=row.get("message_id"),
            channel=row.get("channel"),
            created_at=row["created_at"],
        )


class FeedbackRepository(UserScopedRepository):
    async def log(
        self,
        *,
        kind: str,
        action: str | None = None,
        push_id: str | None = None,
        intent_card_id: str | None = None,
        intent_key: str | None = None,
        source: str = "user_direct",
        basket: str | None = None,
        value: str | None = None,
        text: str | None = None,
        metadata: dict[str, Any] | None = None,
        conversation_id: str | None = None,
        message_id: str | None = None,
        channel: str | None = None,
    ) -> FeedbackRow:
        fid = f"fb_{uuid.uuid4().hex[:16]}"
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_feedback_events
                  (user_id, id, kind, action, push_id, intent_card_id, intent_key,
                   source, basket, value, text, metadata,
                   conversation_id, message_id, channel)
                VALUES (%s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s::jsonb,
                        %s, %s, %s)
                RETURNING *
                """,
                (
                    self._user_id, fid, kind, action, push_id, intent_card_id, intent_key,
                    source, basket, value, text,
                    json.dumps(metadata or {}),
                    conversation_id, message_id, channel,
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = "feedback insert returned no row"
            raise RuntimeError(msg)
        return FeedbackRow.from_record(row)

    async def list(
        self,
        *,
        kind: str | None = None,
        action: str | None = None,
        since: datetime | None = None,
        limit: int = 100,
    ) -> list[FeedbackRow]:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT * FROM pai_feedback_events
                WHERE user_id = %s
                  AND (%s::text IS NULL OR kind = %s)
                  AND (%s::text IS NULL OR action = %s)
                  AND (%s::timestamptz IS NULL OR created_at >= %s)
                ORDER BY created_at DESC LIMIT %s
                """,
                (self._user_id, kind, kind, action, action, since, since, limit),
            )
            rows = await cur.fetchall()
        return [FeedbackRow.from_record(r) for r in rows]

    async def list_dismissed_card_ids(self) -> list[str]:
        """Returns intent_card_ids the user has dismissed.
        Used by frontend to filter cards out of the timeline."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT DISTINCT intent_card_id
                FROM pai_feedback_events
                WHERE user_id = %s
                  AND action = 'dismiss'
                  AND intent_card_id IS NOT NULL
                """,
                (self._user_id,),
            )
            rows = await cur.fetchall()
        return [r["intent_card_id"] for r in rows]
