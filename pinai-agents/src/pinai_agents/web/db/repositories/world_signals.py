"""World signals Repository.

Schema: 020_pai_world_signals_shared.sql.

Two-table design:
  * pai_world_signals — globally shared (no user_id). One row per news
    item. Ingest writes here once for everyone. RLS allows public SELECT
    + service-role-only INSERT (see 023).
  * pai_world_signal_user_view — per-user projection holding salience,
    status (new/open/consumed/archived), reference_count. RLS scopes
    SELECT/UPDATE to user_id.

Reads default to JOIN both so a single call returns the world payload
plus the caller's per-user state. Dream / evolve agents need this to
score and consume news items.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .base import UserScopedRepository


@dataclass(slots=True)
class WorldSignalRow:
    id: str
    provider: str
    stream_type: str
    title: str
    url: str
    normalized_url: str
    external_id: str | None
    summary: str | None
    published_at: datetime | None
    search_queries: list[Any]
    topics: list[Any]
    regions: list[Any]
    importance: str | None
    metadata: dict[str, Any]
    # Per-user view fields (None if no view row yet).
    salience: float | None
    status: str | None
    consumed_by_run_id: str | None
    scored_at: datetime | None
    scored_reason: str | None
    reference_count: int | None
    last_referenced_at: datetime | None

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> WorldSignalRow:
        def _maybe_load(val: Any, default: Any) -> Any:
            if val is None:
                return default
            return val if not isinstance(val, str) else json.loads(val)
        return cls(
            id=row["id"],
            provider=row["provider"],
            stream_type=row["stream_type"],
            title=row["title"],
            url=row["url"],
            normalized_url=row["normalized_url"],
            external_id=row.get("external_id"),
            summary=row.get("summary"),
            published_at=row.get("published_at"),
            search_queries=_maybe_load(row.get("search_queries"), []),
            topics=_maybe_load(row.get("topics"), []),
            regions=_maybe_load(row.get("regions"), []),
            importance=row.get("importance"),
            metadata=_maybe_load(row.get("metadata"), {}),
            salience=row.get("salience"),
            status=row.get("status"),
            consumed_by_run_id=row.get("consumed_by_run_id"),
            scored_at=row.get("scored_at"),
            scored_reason=row.get("scored_reason"),
            reference_count=row.get("reference_count"),
            last_referenced_at=row.get("last_referenced_at"),
        )


@dataclass(slots=True)
class IngestWorldSignalInput:
    id: str
    provider: str
    title: str
    url: str
    normalized_url: str
    stream_type: str = "search"
    external_id: str | None = None
    summary: str | None = None
    published_at: datetime | None = None
    search_queries: list[Any] | None = None
    topics: list[Any] | None = None
    regions: list[Any] | None = None
    importance: str | None = None
    metadata: dict[str, Any] | None = None


class WorldSignalsRepository(UserScopedRepository):
    """Reads JOIN the shared table with the caller's view. Writes to the
    view (score/consume) are user-scoped; writes to the shared table go
    through ingest_world (service role)."""

    async def list_for_user(
        self,
        *,
        status: str | None = "open",
        provider: str | None = None,
        min_salience: float | None = None,
        since: datetime | None = None,
        limit: int = 30,
    ) -> list[WorldSignalRow]:
        """Per-user feed: shared world signals + caller's salience/status.
        LEFT JOIN so unscored items still show up (status NULL)."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT ws.*,
                       v.salience, v.status, v.consumed_by_run_id,
                       v.scored_at, v.scored_reason,
                       v.reference_count, v.last_referenced_at
                FROM pai_world_signals ws
                LEFT JOIN pai_world_signal_user_view v
                  ON v.world_signal_id = ws.id AND v.user_id = %s
                WHERE (%s::text IS NULL OR v.status = %s)
                  AND (%s::text IS NULL OR ws.provider = %s)
                  AND (%s::real IS NULL OR v.salience >= %s)
                  AND (%s::timestamptz IS NULL OR ws.published_at >= %s)
                ORDER BY COALESCE(v.salience, 0) DESC, ws.published_at DESC NULLS LAST
                LIMIT %s
                """,
                (
                    self._user_id,
                    status, status,
                    provider, provider,
                    min_salience, min_salience,
                    since, since,
                    limit,
                ),
            )
            rows = await cur.fetchall()
        return [WorldSignalRow.from_record(r) for r in rows]

    async def score(
        self, *, world_signal_id: str, salience: float,
        scored_reason: str | None = None, status: str = "open",
    ) -> None:
        """Upsert per-user view row. Used by the evolution / score loop."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_world_signal_user_view
                  (user_id, world_signal_id, salience, scored_reason, status)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (user_id, world_signal_id) DO UPDATE SET
                  salience = EXCLUDED.salience,
                  scored_reason = EXCLUDED.scored_reason,
                  scored_at = NOW(),
                  status = CASE
                    WHEN pai_world_signal_user_view.status = 'archived' THEN 'archived'
                    ELSE EXCLUDED.status
                  END
                """,
                (self._user_id, world_signal_id, salience, scored_reason, status),
            )

    async def mark_consumed(
        self, *, world_signal_id: str, run_id: str,
    ) -> bool:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_world_signal_user_view
                SET status = 'consumed', consumed_by_run_id = %s
                WHERE user_id = %s AND world_signal_id = %s AND status = 'open'
                """,
                (run_id, self._user_id, world_signal_id),
            )
            return (cur.rowcount or 0) > 0

    async def increment_reference(
        self, *, world_signal_id: str, run_id: str,
    ) -> None:
        """Used when an evolution run pulls a world signal as input —
        bump reference_count + record the run in referenced_by_runs."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_world_signal_user_view
                SET reference_count = reference_count + 1,
                    last_referenced_at = NOW(),
                    referenced_by_runs = referenced_by_runs || %s::jsonb
                WHERE user_id = %s AND world_signal_id = %s
                """,
                (json.dumps([run_id]), self._user_id, world_signal_id),
            )

    # ── shared-table ingest (service role; bypasses RLS via session ROLE)
    # The service path is a separate concern — agents read this surface;
    # ingestion lives in the scheduled-task connector layer. Provide a
    # helper so background workers can upsert without per-user scoping.
    async def ingest_world(
        self, input: IngestWorldSignalInput,
    ) -> WorldSignalRow:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_world_signals
                  (id, provider, stream_type, title, url, normalized_url,
                   external_id, summary, published_at,
                   search_queries, topics, regions,
                   importance, metadata)
                VALUES
                  (%s, %s, %s, %s, %s, %s,
                   %s, %s, %s,
                   %s::jsonb, %s::jsonb, %s::jsonb,
                   %s, %s::jsonb)
                ON CONFLICT (normalized_url) DO UPDATE SET
                  title = EXCLUDED.title,
                  summary = EXCLUDED.summary,
                  published_at = EXCLUDED.published_at,
                  topics = EXCLUDED.topics,
                  importance = EXCLUDED.importance,
                  metadata = EXCLUDED.metadata,
                  updated_at = NOW()
                RETURNING *
                """,
                (
                    input.id, input.provider, input.stream_type,
                    input.title, input.url, input.normalized_url,
                    input.external_id, input.summary, input.published_at,
                    json.dumps(input.search_queries or []),
                    json.dumps(input.topics or []),
                    json.dumps(input.regions or []),
                    input.importance,
                    json.dumps(input.metadata or {}),
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = f"world signal ingest returned no row (id={input.id})"
            raise RuntimeError(msg)
        # Synthesize per-user view fields as NULL — caller hasn't scored yet.
        merged: dict[str, Any] = dict(row)
        for k in ("salience", "status", "consumed_by_run_id", "scored_at",
                  "scored_reason", "reference_count", "last_referenced_at"):
            merged.setdefault(k, None)
        return WorldSignalRow.from_record(merged)
