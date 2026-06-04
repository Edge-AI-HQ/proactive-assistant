"""Development feedback repository.

Product/UI/feature suggestions live here, not in user preference tables.
The data is for product-team triage; generation should not consume it as a
personalization signal.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from .base import UserScopedRepository

DevelopmentFeedbackCategory = Literal[
    "ui",
    "feature",
    "bug_like",
    "workflow",
    "settings",
    "other",
]
DevelopmentFeedbackSurface = Literal[
    "main_chat",
    "card_detail",
    "settings",
    "ambient",
    "unknown",
]
DevelopmentFeedbackStatus = Literal["new", "reviewed", "planned", "closed"]
DevelopmentFeedbackSource = Literal["user", "internal_operator", "agent"]


@dataclass(slots=True)
class DevelopmentFeedbackRow:
    user_id: int
    supabase_user_id: str
    id: str
    text: str
    summary: str | None
    category: DevelopmentFeedbackCategory
    surface: DevelopmentFeedbackSurface
    status: DevelopmentFeedbackStatus
    source: DevelopmentFeedbackSource
    conversation_id: str | None
    message_id: str | None
    metadata: dict[str, Any]
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> DevelopmentFeedbackRow:
        metadata = row["metadata"]
        if not isinstance(metadata, dict):
            metadata = json.loads(metadata) if metadata else {}
        return cls(
            user_id=row["user_id"],
            supabase_user_id=str(row["supabase_user_id"]),
            id=row["id"],
            text=row["text"],
            summary=row.get("summary"),
            category=row["category"],
            surface=row["surface"],
            status=row["status"],
            source=row["source"],
            conversation_id=row.get("conversation_id"),
            message_id=row.get("message_id"),
            metadata=metadata,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


@dataclass(slots=True)
class AddDevelopmentFeedbackInput:
    text: str
    category: DevelopmentFeedbackCategory
    surface: DevelopmentFeedbackSurface
    source: DevelopmentFeedbackSource
    summary: str | None = None
    conversation_id: str | None = None
    message_id: str | None = None
    dedupe_key: str | None = None
    metadata: dict[str, Any] | None = None


def _normalize_feedback_text(text: str) -> str:
    return " ".join(text.strip().lower().split())


def _default_dedupe_key(input: AddDevelopmentFeedbackInput) -> str:
    payload = {
        "source": input.source,
        "surface": input.surface,
        "conversation_id": input.conversation_id or "",
        "message_id": input.message_id or "",
        "text": _normalize_feedback_text(input.text),
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return "dfd_" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()


class DevelopmentFeedbackRepository(UserScopedRepository):
    async def add(self, input: AddDevelopmentFeedbackInput) -> DevelopmentFeedbackRow:
        feedback_id = f"df_{uuid.uuid4().hex[:16]}"
        dedupe_key = input.dedupe_key or _default_dedupe_key(input)
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_development_feedback
                  (user_id, supabase_user_id, id, text, summary, category,
                   surface, status, source, conversation_id, message_id, dedupe_key, metadata)
                SELECT %s, u.supabase_user_id, %s, %s, %s, %s,
                       %s, 'new', %s, %s, %s, %s, %s::jsonb
                FROM users u
                WHERE u.id = %s
                ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL
                DO UPDATE SET updated_at = pai_development_feedback.updated_at
                RETURNING *
                """,
                (
                    self._user_id,
                    feedback_id,
                    input.text,
                    input.summary,
                    input.category,
                    input.surface,
                    input.source,
                    input.conversation_id,
                    input.message_id,
                    dedupe_key,
                    json.dumps(input.metadata or {}),
                    self._user_id,
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = f"development feedback insert returned no row for user {self._user_id}"
            raise RuntimeError(msg)
        return DevelopmentFeedbackRow.from_record(row)

    async def list(
        self,
        *,
        status: DevelopmentFeedbackStatus | None = None,
        category: DevelopmentFeedbackCategory | None = None,
        surface: DevelopmentFeedbackSurface | None = None,
        limit: int = 100,
    ) -> list[DevelopmentFeedbackRow]:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT *
                FROM pai_development_feedback
                WHERE user_id = %s
                  AND (%s::text IS NULL OR status = %s)
                  AND (%s::text IS NULL OR category = %s)
                  AND (%s::text IS NULL OR surface = %s)
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (
                    self._user_id,
                    status,
                    status,
                    category,
                    category,
                    surface,
                    surface,
                    limit,
                ),
            )
            rows = await cur.fetchall()
        return [DevelopmentFeedbackRow.from_record(r) for r in rows]

    async def update_status(
        self,
        feedback_id: str,
        status: DevelopmentFeedbackStatus,
    ) -> DevelopmentFeedbackRow | None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_development_feedback
                SET status = %s, updated_at = NOW()
                WHERE user_id = %s AND id = %s
                RETURNING *
                """,
                (status, self._user_id, feedback_id),
            )
            row = await cur.fetchone()
        return DevelopmentFeedbackRow.from_record(row) if row else None
