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
    updated_at: datetime | None = None

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> PersonalSignalRow:
        return cls(
            id=row["id"],
            kind=row["kind"],
            title=row["title"],
            summary=row["summary"],
            payload=row["payload"]
            if isinstance(row["payload"], dict)
            else json.loads(row["payload"]),
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
            updated_at=row.get("updated_at", row["ingested_at"]),
        )


# Explicit read column list — mirrors PersonalSignalRow.from_record exactly.
# Includes `updated_at` (migration 049): from_record reads it, so dropping it
# from the projection would silently fall back to ingested_at. Deliberately
# omits the pgvector `embedding` column (migration 029): list/get views never
# use it, and signals are the largest per-user table, so `SELECT *` dragging a
# 1536-d vector through every page is where it hurt most. (last_referenced_at /
# referenced_by_runs are intentionally absent — the Row dataclass doesn't carry
# them either.)
_READ_COLUMNS = (
    "id, kind, title, summary, payload, salience, confidence, dedupe_key, "
    "occurred_at, available_at, expires_at, source, device_id, subject, "
    "source_raw_table, source_raw_ids, status, consumed_by_run_id, "
    "ingested_at, reference_count, updated_at"
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


@dataclass(slots=True)
class PersonalSignalIngestResult:
    row: PersonalSignalRow
    changed: bool


@dataclass(slots=True)
class PersonalSignalKindStat:
    """One row per distinct kind, with count + a preview of the most recent
    signal of that kind. Used by the agent-facing `signals_kinds` tool so the
    LLM can discover what data sources exist before drilling with
    `signals_recent(kind=...)`."""

    kind: str
    count: int
    latest_at: datetime
    latest_title: str
    latest_summary_preview: str


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
                  consumed_by_run_id = NULL,
                  updated_at = NOW()
                RETURNING *
                """,
                (
                    self._user_id,
                    input.id,
                    input.kind,
                    input.title,
                    input.summary,
                    json.dumps(input.payload or {}),
                    input.salience,
                    input.confidence,
                    input.dedupe_key,
                    input.occurred_at,
                    available_at,
                    input.expires_at,
                    input.source,
                    input.device_id,
                    input.subject,
                    input.source_raw_table,
                    json.dumps(input.source_raw_ids or []),
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = f"signal ingest returned no row (id={input.id})"
            raise RuntimeError(msg)
        return PersonalSignalRow.from_record(row)

    async def ingest_transcript_candidate_window_latest(
        self,
        input: IngestSignalInput,
    ) -> PersonalSignalIngestResult:
        """Upsert transcript candidate windows only when incoming content is newer.

        Freshness is monotonic:
          * larger payload.raw_ref_count updates the existing row;
          * same raw_ref_count plus different payload.content_hash updates it;
          * smaller or exact-same content is a no-op and must not reopen
            an already-consumed signal.
        """
        if not input.dedupe_key:
            raise ValueError("transcript candidate window requires dedupe_key")

        available_at = input.available_at or input.occurred_at
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT *
                FROM pai_personal_signals
                WHERE user_id = %s
                  AND (dedupe_key = %s OR id = %s)
                ORDER BY
                  CASE WHEN dedupe_key = %s THEN 0 ELSE 1 END,
                  ingested_at DESC
                LIMIT 1
                """,
                (self._user_id, input.dedupe_key, input.id, input.dedupe_key),
            )
            existing = await cur.fetchone()
            if existing is not None:
                await cur.execute(
                    """
                    UPDATE pai_personal_signals
                    SET
                      title = %s,
                      summary = %s,
                      payload = %s::jsonb,
                      salience = %s,
                      confidence = %s,
                      dedupe_key = %s,
                      occurred_at = %s,
                      available_at = %s,
                      expires_at = %s,
                      source = %s,
                      device_id = %s,
                      subject = %s,
                      source_raw_table = %s,
                      source_raw_ids = %s::jsonb,
                      status = 'open',
                      consumed_by_run_id = NULL,
                      updated_at = NOW()
                    WHERE user_id = %s
                      AND id = %s
                      AND (
                        (
                          CASE
                            WHEN %s::jsonb ->> 'raw_ref_count' ~ '^[0-9]+$'
                              THEN (%s::jsonb ->> 'raw_ref_count')::integer
                            ELSE 0
                          END
                        ) > (
                          CASE
                            WHEN payload ->> 'raw_ref_count' ~ '^[0-9]+$'
                              THEN (payload ->> 'raw_ref_count')::integer
                            ELSE 0
                          END
                        )
                        OR (
                          (
                            CASE
                              WHEN %s::jsonb ->> 'raw_ref_count' ~ '^[0-9]+$'
                                THEN (%s::jsonb ->> 'raw_ref_count')::integer
                              ELSE 0
                            END
                          ) = (
                            CASE
                              WHEN payload ->> 'raw_ref_count' ~ '^[0-9]+$'
                                THEN (payload ->> 'raw_ref_count')::integer
                              ELSE 0
                            END
                          )
                          AND NULLIF(%s::jsonb ->> 'content_hash', '')
                            IS DISTINCT FROM NULLIF(payload ->> 'content_hash', '')
                        )
                      )
                    RETURNING *
                    """,
                    (
                        input.title,
                        input.summary,
                        json.dumps(input.payload or {}),
                        input.salience,
                        input.confidence,
                        input.dedupe_key,
                        input.occurred_at,
                        available_at,
                        input.expires_at,
                        input.source,
                        input.device_id,
                        input.subject,
                        input.source_raw_table,
                        json.dumps(input.source_raw_ids or []),
                        self._user_id,
                        existing["id"],
                        json.dumps(input.payload or {}),
                        json.dumps(input.payload or {}),
                        json.dumps(input.payload or {}),
                        json.dumps(input.payload or {}),
                        json.dumps(input.payload or {}),
                    ),
                )
                row = await cur.fetchone()
                if row is not None:
                    return PersonalSignalIngestResult(
                        row=PersonalSignalRow.from_record(row),
                        changed=True,
                    )

                if existing.get("dedupe_key") != input.dedupe_key:
                    await cur.execute(
                        """
                        UPDATE pai_personal_signals p
                        SET dedupe_key = %s,
                            updated_at = NOW()
                        WHERE p.user_id = %s
                          AND p.id = %s
                          AND NOT EXISTS (
                            SELECT 1
                            FROM pai_personal_signals other
                            WHERE other.user_id = p.user_id
                              AND other.dedupe_key = %s
                              AND other.id <> p.id
                          )
                        RETURNING *
                        """,
                        (
                            input.dedupe_key,
                            self._user_id,
                            existing["id"],
                            input.dedupe_key,
                        ),
                    )
                    normalized = await cur.fetchone()
                    if normalized is not None:
                        existing = normalized

                return PersonalSignalIngestResult(
                    row=PersonalSignalRow.from_record(existing),
                    changed=False,
                )

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
                  source = EXCLUDED.source,
                  device_id = EXCLUDED.device_id,
                  subject = EXCLUDED.subject,
                  source_raw_table = EXCLUDED.source_raw_table,
                  source_raw_ids = EXCLUDED.source_raw_ids,
                  status = 'open',
                  consumed_by_run_id = NULL,
                  updated_at = NOW()
                WHERE
                  (
                    CASE
                      WHEN EXCLUDED.payload ->> 'raw_ref_count' ~ '^[0-9]+$'
                        THEN (EXCLUDED.payload ->> 'raw_ref_count')::integer
                      ELSE 0
                    END
                  ) > (
                    CASE
                      WHEN pai_personal_signals.payload ->> 'raw_ref_count' ~ '^[0-9]+$'
                        THEN (pai_personal_signals.payload ->> 'raw_ref_count')::integer
                      ELSE 0
                    END
                  )
                  OR (
                    (
                      CASE
                        WHEN EXCLUDED.payload ->> 'raw_ref_count' ~ '^[0-9]+$'
                          THEN (EXCLUDED.payload ->> 'raw_ref_count')::integer
                        ELSE 0
                      END
                    ) = (
                      CASE
                        WHEN pai_personal_signals.payload ->> 'raw_ref_count' ~ '^[0-9]+$'
                          THEN (pai_personal_signals.payload ->> 'raw_ref_count')::integer
                        ELSE 0
                      END
                    )
                    AND NULLIF(EXCLUDED.payload ->> 'content_hash', '')
                      IS DISTINCT FROM NULLIF(pai_personal_signals.payload ->> 'content_hash', '')
                  )
                RETURNING *
                """,
                (
                    self._user_id,
                    input.id,
                    input.kind,
                    input.title,
                    input.summary,
                    json.dumps(input.payload or {}),
                    input.salience,
                    input.confidence,
                    input.dedupe_key,
                    input.occurred_at,
                    available_at,
                    input.expires_at,
                    input.source,
                    input.device_id,
                    input.subject,
                    input.source_raw_table,
                    json.dumps(input.source_raw_ids or []),
                ),
            )
            row = await cur.fetchone()
            if row is not None:
                return PersonalSignalIngestResult(
                    row=PersonalSignalRow.from_record(row),
                    changed=True,
                )

            await cur.execute(
                """
                SELECT *
                FROM pai_personal_signals
                WHERE user_id = %s AND dedupe_key = %s
                """,
                (self._user_id, input.dedupe_key),
            )
            existing = await cur.fetchone()

        if existing is None:
            msg = f"transcript candidate ingest returned no row (id={input.id})"
            raise RuntimeError(msg)
        return PersonalSignalIngestResult(
            row=PersonalSignalRow.from_record(existing),
            changed=False,
        )

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
        matching the filters BEFORE limit/offset. Count and page are two
        queries sharing one WHERE inside the caller's transaction (one MVCC
        snapshot), so they can't drift; the page projects narrow columns
        (no embedding) instead of pulling every matching row through a
        window function just to attach a total.
        """
        # Shared WHERE so the count and the page can't drift — both run inside
        # the same user_scoped_tx (one MVCC snapshot), so splitting the old
        # single `SELECT *, COUNT(*) OVER ()` into two queries stays exact.
        where_sql = """
            FROM pai_personal_signals
            WHERE user_id = %s
              AND (%s::text IS NULL OR status = %s)
              AND (%s::text IS NULL OR kind = %s)
              AND (%s::text IS NULL OR source = %s)
              AND (%s::text IS NULL OR device_id = %s)
              AND (%s::timestamptz IS NULL OR occurred_at >= %s)
              AND (%s::timestamptz IS NULL OR occurred_at < %s)
              AND (%s::real IS NULL OR salience >= %s)
        """
        where_params = (
            self._user_id,
            status,
            status,
            kind,
            kind,
            source,
            source,
            device_id,
            device_id,
            since,
            since,
            before,
            before,
            min_salience,
            min_salience,
        )
        async with self._conn.cursor() as cur:
            # Count separately — index-only on idx_pai_psignals_status_time
            # instead of dragging every matching row (payload JSONB + 1536-d
            # embedding) through a WindowAgg.
            await cur.execute(f"SELECT count(*) AS total {where_sql}", where_params)
            count_row = await cur.fetchone()
            total = int(count_row["total"]) if count_row else 0
            if total == 0:
                return [], 0
            # Page: narrow column list (no embedding), index-ordered top-N.
            await cur.execute(
                f"SELECT {_READ_COLUMNS} {where_sql} ORDER BY occurred_at DESC LIMIT %s OFFSET %s",
                (*where_params, limit, offset),
            )
            rows = await cur.fetchall()
        return [PersonalSignalRow.from_record(r) for r in rows], total

    async def list_kinds(
        self,
        *,
        status: str | None = None,
        since: datetime | None = None,
        summary_preview_chars: int = 160,
    ) -> list[PersonalSignalKindStat]:
        """Group by `kind`: count + most-recent preview per kind, ordered by
        latest_at DESC. Defaults to status=None / since=None so the agent can
        discover *all* kinds the user has data for, including consumed/archived
        — list_recent's defaults are tuned for the generator's increment layer,
        which is a different use case.

        `summary_preview_chars` truncates the latest summary so a kinds list
        stays cheap to ship through the LLM context.
        """
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT kind, count, latest_at, latest_title, latest_summary_preview
                FROM (
                    SELECT DISTINCT ON (kind)
                        kind,
                        occurred_at AS latest_at,
                        title AS latest_title,
                        left(summary, %s) AS latest_summary_preview,
                        COUNT(*) OVER (PARTITION BY kind) AS count
                    FROM pai_personal_signals
                    WHERE user_id = %s
                      AND (%s::text IS NULL OR status = %s)
                      AND (%s::timestamptz IS NULL OR occurred_at >= %s)
                    ORDER BY kind, occurred_at DESC
                ) sub
                ORDER BY latest_at DESC
                """,
                (
                    summary_preview_chars,
                    self._user_id,
                    status,
                    status,
                    since,
                    since,
                ),
            )
            rows = await cur.fetchall()
        return [
            PersonalSignalKindStat(
                kind=r["kind"],
                count=int(r["count"]),
                latest_at=r["latest_at"],
                latest_title=r["latest_title"],
                latest_summary_preview=r["latest_summary_preview"] or "",
            )
            for r in rows
        ]

    async def mark_consumed(self, signal_id: str, run_id: str) -> bool:
        """open → consumed. Idempotent: same run consuming again is no-op.
        Returns True if state changed."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_personal_signals
                SET status = 'consumed',
                    consumed_by_run_id = %s,
                    updated_at = NOW()
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
                SET status = 'archived',
                    updated_at = NOW()
                WHERE user_id = %s AND id = %s AND status <> 'archived'
                """,
                (self._user_id, signal_id),
            )
            return (cur.rowcount or 0) > 0
