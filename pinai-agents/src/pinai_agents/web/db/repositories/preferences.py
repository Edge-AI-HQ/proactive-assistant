"""Preference records Repository.

Schema: 056_pai_preference_records.sql.

The expression layer of feedback — preferences stated in plain words in
main chat. Append-only state machine, same shape as `memory.py`:

  active → superseded   (a newer preference replaces this; superseded_by
                         points at the new id)
  active → archived     (no longer current)

Lifecycle ops are named methods, not generic UPDATE, so the state machine
reads off the code. `source` is decided by the route from the JWT
principal — this layer just persists what it's handed.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .base import UserScopedRepository


@dataclass(slots=True)
class PreferenceRow:
    """1:1 with a pai_preference_records row, evidence decoded JSONB → dict."""

    id: str
    statement: str
    scope: str
    polarity: str
    weight: float
    confidence: float | None
    source: str
    evidence: dict[str, Any]
    status: str
    superseded_by: str | None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> PreferenceRow:
        evidence = row["evidence"]
        return cls(
            id=row["id"],
            statement=row["statement"],
            scope=row["scope"],
            polarity=row["polarity"],
            weight=float(row["weight"]),
            confidence=float(row["confidence"]) if row.get("confidence") is not None else None,
            source=row["source"],
            evidence=evidence if isinstance(evidence, dict) else json.loads(evidence),
            status=row["status"],
            superseded_by=row.get("superseded_by"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


@dataclass(slots=True)
class AddPreferenceInput:
    id: str
    statement: str
    scope: str
    polarity: str
    weight: float
    source: str
    confidence: float | None = None
    evidence: dict[str, Any] | None = None


class PreferenceRepository(UserScopedRepository):
    async def add(self, input: AddPreferenceInput) -> PreferenceRow:
        """Insert one active preference. Caller generates `id`
        (`pref_<uuid>`, unique per user) and decides `source` from the
        request principal — never from agent-reported body."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_preference_records
                  (user_id, id, statement, scope, polarity, weight,
                   confidence, source, evidence, status)
                VALUES
                  (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, 'active')
                RETURNING *
                """,
                (
                    self._user_id, input.id, input.statement, input.scope,
                    input.polarity, input.weight, input.confidence,
                    input.source, json.dumps(input.evidence or {}),
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = f"insert returned no row (user={self._user_id} id={input.id})"
            raise RuntimeError(msg)
        return PreferenceRow.from_record(row)

    async def list(
        self,
        *,
        status: str = "active",
        scope: str | None = None,
        limit: int = 50,
    ) -> list[PreferenceRow]:
        """List preferences in `status`, newest first. Optional `scope`
        filter. Default returns active rows — what generation reads."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT * FROM pai_preference_records
                WHERE user_id = %s
                  AND status = %s
                  AND (%s::text IS NULL OR scope = %s)
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (self._user_id, status, scope, scope, limit),
            )
            rows = await cur.fetchall()
        return [PreferenceRow.from_record(r) for r in rows]

    async def get(self, preference_id: str) -> PreferenceRow | None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                "SELECT * FROM pai_preference_records WHERE user_id = %s AND id = %s",
                (self._user_id, preference_id),
            )
            row = await cur.fetchone()
        return PreferenceRow.from_record(row) if row else None

    async def supersede(self, *, old_id: str, new_id: str) -> PreferenceRow | None:
        """active → superseded, link to the replacement preference.

        Asserts `new_id` is already an active row of this user before
        touching the old one (mirrors `memory.py:supersede` — the caller
        must have INSERT'd the new preference first). Returns the updated
        OLD row, or None if `old_id` wasn't active.
        """
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT 1 FROM pai_preference_records
                WHERE user_id = %s AND id = %s AND status = 'active'
                """,
                (self._user_id, new_id),
            )
            if await cur.fetchone() is None:
                msg = (
                    f"supersede target {new_id!r} must be an active preference "
                    f"of user {self._user_id} before superseding {old_id!r}"
                )
                raise ValueError(msg)
            await cur.execute(
                """
                UPDATE pai_preference_records
                SET status = 'superseded', superseded_by = %s, updated_at = NOW()
                WHERE user_id = %s AND id = %s AND status = 'active'
                RETURNING *
                """,
                (new_id, self._user_id, old_id),
            )
            row = await cur.fetchone()
        return PreferenceRow.from_record(row) if row else None

    async def archive(self, preference_id: str) -> PreferenceRow | None:
        """active → archived. No-op if already archived/superseded."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_preference_records
                SET status = 'archived', updated_at = NOW()
                WHERE user_id = %s AND id = %s AND status = 'active'
                RETURNING *
                """,
                (self._user_id, preference_id),
            )
            row = await cur.fetchone()
        return PreferenceRow.from_record(row) if row else None
