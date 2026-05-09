"""Personal signals Repository.

Schema: 011_pai_memory_signals.sql.

Status state machine: open → consumed → archived.
  - 'open' is the increment layer the generator agent reads from.
  - 'consumed' marks "this signal has been turned into a card / memory by run X".
    Idempotent via consumed_by_run_id (same run can consume twice → no-op).
  - 'archived' is end-of-life — kept for audit but invisible to default queries.

Dedupe: writes that match an existing (user_id, dedupe_key) UPSERT instead
of duplicating. Used heavily by device ingest where the same calendar
event might come up multiple times.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .base import UserScopedRepository


@dataclass(slots=True)
class PersonalSignalRow:
    id: str
    kind: str
    title: str
    summary: str
    payload: dict[str, Any]
    salience: float
    confidence: float
    dedupe_key: str | None
    occurred_at: datetime
    available_at: datetime
    expires_at: datetime | None
    source: str
    device_id: str | None
    subject: str | None
    source_raw_table: str | None
    source_raw_ids: list[str]
    status: str
    consumed_by_run_id: str | None
    ingested_at: datetime
    reference_count: int

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> PersonalSignalRow:
        return cls(
            id=row["id"],
            kind=row["kind"],
            title=row["title"],
            summary=row["summary"],
            payload=row["payload"] if isinstance(row["payload"], dict) else json.loads(row["payload"]),
            salience=float(row["salience"]),
            confidence=float(row["confidence"]),
            dedupe_key=row.get("dedupe_key"),
            occurred_at=row["occurred_at"],
            available_at=row["available_at"],
            expires_at=row.get("expires_at"),
            source=row["source"],
            device_id=row.get("device_id"),
            subject=row.get("subject"),
            source_raw_table=row.get("source_raw_table"),
            source_raw_ids=(
                row["source_raw_ids"]
                if isinstance(row["source_raw_ids"], list)
                else json.loads(row["source_raw_ids"])
            ),
            status=row["status"],
            consumed_by_run_id=row.get("consumed_by_run_id"),
            ingested_at=row["ingested_at"],
            reference_count=row["reference_count"],
        )


@dataclass(slots=True)
class IngestSignalInput:
    id: str
    kind: str
    title: str
    summary: str
    occurred_at: datetime
    payload: dict[str, Any] | None = None
    salience: float = 0.0
    confidence: float = 0.0
    dedupe_key: str | None = None
    available_at: datetime | None = None
    expires_at: datetime | None = None
    source: str = "device"
    device_id: str | None = None
    subject: str | None = None
    source_raw_table: str | None = None
    source_raw_ids: list[str] | None = None


class PersonalSignalsRepository(UserScopedRepository):
    async def ingest_one(self, input: IngestSignalInput) -> PersonalSignalRow:
        """Insert one signal, dedupe-aware. If (user_id, dedupe_key) exists,
        UPSERT (latest payload wins, status reset to 'open' so a stale
        consumed signal becomes fresh again)."""
        available_at = input.available_at or input.occurred_at
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_personal_signals
                  (user_id, id, kind, title, summary, payload,
                   salience, confidence, dedupe_key,
                   occurred_at, available_at, expires_at,
                   source, device_id, subject,
                   source_raw_table, source_raw_ids,
                   status)
                VALUES
                  (%s, %s, %s, %s, %s, %s::jsonb,
                   %s, %s, %s,
                   %s, %s, %s,
                   %s, %s, %s,
                   %s, %s::jsonb,
                   'open')
                ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL
                DO UPDATE SET
                  title = EXCLUDED.title,
                  summary = EXCLUDED.summary,
                  payload = EXCLUDED.payload,
                  salience = EXCLUDED.salience,
                  confidence = EXCLUDED.confidence,
                  occurred_at = EXCLUDED.occurred_at,
                  available_at = EXCLUDED.available_at,
                  expires_at = EXCLUDED.expires_at,
                  status = 'open',
                  consumed_by_run_id = NULL
                RETURNING *
                """,
                (
                    self._user_id, input.id, input.kind, input.title, input.summary,
                    json.dumps(input.payload or {}),
                    input.salience, input.confidence, input.dedupe_key,
                    input.occurred_at, available_at, input.expires_at,
                    input.source, input.device_id, input.subject,
                    input.source_raw_table,
                    json.dumps(input.source_raw_ids or []),
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = f"signal ingest returned no row (id={input.id})"
            raise RuntimeError(msg)
        return PersonalSignalRow.from_record(row)

    async def get_one(self, signal_id: str) -> PersonalSignalRow | None:
        """Fetch one signal by id, or None if not found / not in this user's
        scope. Used by the agent surface when `list_recent` summary isn't
        enough and the LLM wants the full payload."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                "SELECT * FROM pai_personal_signals WHERE user_id = %s AND id = %s",
                (self._user_id, signal_id),
            )
            row = await cur.fetchone()
        return PersonalSignalRow.from_record(row) if row else None

    async def list_recent(
        self,
        *,
        status: str | None = "open",
        kind: str | None = None,
        source: str | None = None,
        device_id: str | None = None,
        since: datetime | None = None,
        before: datetime | None = None,
        min_salience: float | None = None,
        limit: int = 30,
        offset: int = 0,
    ) -> tuple[list[PersonalSignalRow], int]:
        """Default: status='open' (active increment layer). Pass status=None
        to scan everything.

        Returns `(rows, total)` where `total` is the count of all rows
        matching the filters BEFORE limit/offset (via `COUNT(*) OVER()`),
        so callers can paginate without a second query and without filter
        drift between the page query and the count query.
        """
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT *, COUNT(*) OVER () AS total_count
                FROM pai_personal_signals
                WHERE user_id = %s
                  AND (%s::text IS NULL OR status = %s)
                  AND (%s::text IS NULL OR kind = %s)
                  AND (%s::text IS NULL OR source = %s)
                  AND (%s::text IS NULL OR device_id = %s)
                  AND (%s::timestamptz IS NULL OR occurred_at >= %s)
                  AND (%s::timestamptz IS NULL OR occurred_at < %s)
                  AND (%s::real IS NULL OR salience >= %s)
                ORDER BY occurred_at DESC
                LIMIT %s OFFSET %s
                """,
                (
                    self._user_id,
                    status, status,
                    kind, kind,
                    source, source,
                    device_id, device_id,
                    since, since,
                    before, before,
                    min_salience, min_salience,
                    limit, offset,
                ),
            )
            rows = await cur.fetchall()
        # Empty page → total=0. Same trade-off as MemoryRepository.list_active:
        # accepting the "offset past end of filtered set" edge case (frontend
        # paginators clamp on next refetch) avoids re-introducing a second
        # query whose WHERE clause could drift from this one.
        if not rows:
            return [], 0
        total = int(rows[0]["total_count"])
        return [PersonalSignalRow.from_record(r) for r in rows], total

    async def mark_consumed(self, signal_id: str, run_id: str) -> bool:
        """open → consumed. Idempotent: same run consuming again is no-op.
        Returns True if state changed."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_personal_signals
                SET status = 'consumed', consumed_by_run_id = %s
                WHERE user_id = %s AND id = %s AND status = 'open'
                """,
                (run_id, self._user_id, signal_id),
            )
            return (cur.rowcount or 0) > 0

    async def archive(self, signal_id: str) -> bool:
        """Mark archived from any non-archived state."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_personal_signals
                SET status = 'archived'
                WHERE user_id = %s AND id = %s AND status <> 'archived'
                """,
                (self._user_id, signal_id),
            )
            return (cur.rowcount or 0) > 0
