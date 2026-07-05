"""World signals Repository — the globally-shared L0 table only.

Schema: 020_pai_world_signals_shared.sql (the per-user pai_world_signal_user_view
is retired, W6 — per-user world state lives in world_news events now: salience in
the event's structured, recency via occurred_at, reference via the event's
reference triple). This repo is just the shared-table ingest path:

  * pai_world_signals — globally shared (no user_id). One row per news item;
    ingest writes here once for everyone. RLS allows public SELECT + service-role
    INSERT (see 023).

Reads / per-user writes (the old list_for_user / score / consume / reference)
are gone — the agent reads world via events_search (event_type=world_news) and
the projector (world_scoring) is what lands the per-user events.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from pinai_db.base import UserScopedRepository


@dataclass(slots=True)
class WorldSignalRow:
    """One globally-shared world signal (no per-user state — that's in
    world_news events now)."""

    id: str
    provider: str
    title: str
    url: str
    normalized_url: str
    summary: str | None
    published_at: datetime | None
    topics: list[Any]
    regions: list[Any]
    importance: str | None

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> WorldSignalRow:
        def _maybe_load(val: Any, default: Any) -> Any:
            if val is None:
                return default
            return val if not isinstance(val, str) else json.loads(val)

        return cls(
            id=row["id"],
            provider=row["provider"],
            title=row["title"],
            url=row["url"],
            normalized_url=row["normalized_url"],
            summary=row.get("summary"),
            published_at=row.get("published_at"),
            topics=_maybe_load(row.get("topics"), []),
            regions=_maybe_load(row.get("regions"), []),
            importance=row.get("importance"),
        )


@dataclass(slots=True)
class IngestWorldSignalInput:
    id: str
    provider: str
    title: str
    url: str
    normalized_url: str
    summary: str | None = None
    published_at: datetime | None = None
    topics: list[Any] | None = None
    regions: list[Any] | None = None
    importance: str | None = None


class WorldSignalsRepository(UserScopedRepository):
    """Shared-table ingest only (per-user view retired, W6). ingest_world is the
    service-role upsert into pai_world_signals; agents read world via
    events_search (event_type=world_news)."""

    async def ingest_world(
        self,
        input: IngestWorldSignalInput,
    ) -> WorldSignalRow:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_world_signals
                  (id, provider, title, url, normalized_url,
                   summary, published_at,
                   topics, regions, importance)
                VALUES
                  (%s, %s, %s, %s, %s,
                   %s, %s,
                   %s::jsonb, %s::jsonb, %s)
                ON CONFLICT (normalized_url) DO UPDATE SET
                  title = EXCLUDED.title,
                  summary = EXCLUDED.summary,
                  published_at = EXCLUDED.published_at,
                  topics = EXCLUDED.topics,
                  importance = EXCLUDED.importance,
                  updated_at = NOW()
                RETURNING *
                """,
                (
                    input.id,
                    input.provider,
                    input.title,
                    input.url,
                    input.normalized_url,
                    input.summary,
                    input.published_at,
                    json.dumps(input.topics or []),
                    json.dumps(input.regions or []),
                    input.importance,
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = f"world signal ingest returned no row (id={input.id})"
            raise RuntimeError(msg)
        return WorldSignalRow.from_record(dict(row))
