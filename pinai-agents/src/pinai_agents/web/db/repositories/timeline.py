"""Timeline event store Repository.

Schema: `db/migrations/064_pai_timeline_events.sql`.

ADDITIVE event layer dedicated to the proactive agent — runs alongside
`pai_personal_signals` / `pai_raw_*` (which keep feeding the main-chat /
evolve / memory path unchanged); it does not replace them.

## Write paths

Both data sources insert here directly with `curation_status='pending'`:

1. **Connector ingest (`connector_ingest.py`)** — Gmail / GCal / Slack /
   ... fetched from Composio and rule-mapped straight into timeline
   events. No LLM in the write path.

2. **Ambient ingest (`/api/devices/ingest`)** — utterances / location /
   activity / ... from the device, written directly.

Both default `importance=0.5`. A `timeline.curate` LLM scorer existed to
re-score `pending → curated`, but it is **currently disabled** (see
`services/timeline_curator.py`): events stay `pending` and are consumed
as-is. The curator will be redesigned later; nothing downstream gates on
`curation_status='curated'`.

`upsert_event()` is idempotent on `(user_id, dedupe_key)`, so re-ingesting
the same source event is safe.

## Read paths

* `query()` — occurred_at window scan, chronological. The generator /
  dream / proactive loop read here. **Includes `pending` by default**
  (`include_pending=True`) precisely because events stay pending while
  the curator is off; it still drops `filtered_out`, predicted, and
  superseded rows and filters `importance >= 0.3`.
* `list_since_ingested()` — ingestion-ordered stream the proactive loop
  consumes each tick, walked via the `pai_proactive_state` watermark
  (see migration 074).

Callers override the `query()` filters via explicit parameters.

## Versioning (future-event reschedule)

When a calendar event is rescheduled, callers use `supersede()` to:
  1. INSERT a new row with version+1, supersedes_id pointing at the old
  2. UPDATE the old row's superseded_by_id

Both rows survive. Default queries only return the current version.
The chain is queryable via `get_history()` for intent-change analysis.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from .base import UserScopedRepository

# ─────────────────────────────────────────────────────────────────────
# Data classes
# ─────────────────────────────────────────────────────────────────────


@dataclass(slots=True)
class TimelineEventRow:
    id: str
    occurred_at: datetime
    end_at: datetime | None
    source: str
    event_type: str
    title: str
    body: str | None
    participants: list[dict[str, Any]]
    location: dict[str, Any] | None
    metadata: dict[str, Any]
    source_ref: dict[str, Any]
    importance: float
    confidence: float
    is_predicted: bool
    curation_status: str
    filter_reason: str | None
    version: int
    supersedes_id: str | None
    superseded_by_id: str | None
    history: list[dict[str, Any]]
    dedupe_key: str | None
    ingested_at: datetime
    updated_at: datetime
    curated_at: datetime | None
    reference_count: int
    last_referenced_at: datetime | None

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> TimelineEventRow:
        return cls(
            id=row["id"],
            occurred_at=row["occurred_at"],
            end_at=row.get("end_at"),
            source=row["source"],
            event_type=row["event_type"],
            title=row["title"],
            body=row.get("body"),
            participants=_loads_list(row.get("participants")),
            location=_loads_dict(row.get("location")),
            metadata=_loads_dict(row.get("metadata")) or {},
            source_ref=_loads_dict(row.get("source_ref")) or {},
            importance=float(row["importance"]),
            confidence=float(row["confidence"]),
            is_predicted=bool(row["is_predicted"]),
            curation_status=row["curation_status"],
            filter_reason=row.get("filter_reason"),
            version=int(row["version"]),
            supersedes_id=row.get("supersedes_id"),
            superseded_by_id=row.get("superseded_by_id"),
            history=_loads_list(row.get("history")),
            dedupe_key=row.get("dedupe_key"),
            ingested_at=row["ingested_at"],
            updated_at=row["updated_at"],
            curated_at=row.get("curated_at"),
            reference_count=int(row["reference_count"]),
            last_referenced_at=row.get("last_referenced_at"),
        )


@dataclass(slots=True)
class IngestTimelineEvent:
    """Input shape for `upsert_event()`.

    `id` is required and must be unique-per-user. Callers should generate
    a stable id (e.g. `tle_{uuid4().hex[:16]}`) for fresh rows; for the
    deterministic / replay case, use a content-derived id so retries land
    on the same row even without a dedupe_key.
    """

    id: str
    occurred_at: datetime
    source: str
    event_type: str
    title: str
    source_ref: dict[str, Any]
    end_at: datetime | None = None
    body: str | None = None
    participants: list[dict[str, Any]] = field(default_factory=list)
    location: dict[str, Any] | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    importance: float = 0.5
    confidence: float = 1.0
    is_predicted: bool = False
    curation_status: str = "curated"
    filter_reason: str | None = None
    dedupe_key: str | None = None


# ─────────────────────────────────────────────────────────────────────
# Repository
# ─────────────────────────────────────────────────────────────────────


class TimelineRepository(UserScopedRepository):
    async def upsert_event(self, ev: IngestTimelineEvent) -> TimelineEventRow:
        """Insert one event; UPSERT on (user_id, dedupe_key) when set.

        On conflict: replace content/timestamps but **never** roll back
        a row to `pending` once it was `curated` — preserves curation work
        across re-ingests. `version` stays at 1 for plain re-ingests;
        explicit reschedules go through `supersede()`, which sees the new
        row as a version-2 row pointing at the old one.
        """
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_timeline_events
                  (user_id, id,
                   occurred_at, end_at,
                   source, event_type,
                   title, body,
                   participants, location, metadata,
                   source_ref,
                   importance, confidence, is_predicted,
                   curation_status, filter_reason,
                   version, dedupe_key,
                   curated_at)
                VALUES
                  (%s, %s,
                   %s, %s,
                   %s, %s,
                   %s, %s,
                   %s::jsonb, %s::jsonb, %s::jsonb,
                   %s::jsonb,
                   %s, %s, %s,
                   %s, %s,
                   1, %s,
                   CASE WHEN %s = 'curated' THEN NOW() ELSE NULL END)
                ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL
                DO UPDATE SET
                  occurred_at = EXCLUDED.occurred_at,
                  end_at = EXCLUDED.end_at,
                  source = EXCLUDED.source,
                  event_type = EXCLUDED.event_type,
                  title = EXCLUDED.title,
                  body = EXCLUDED.body,
                  participants = EXCLUDED.participants,
                  location = EXCLUDED.location,
                  metadata = pai_timeline_events.metadata || EXCLUDED.metadata,
                  source_ref = EXCLUDED.source_ref,
                  importance = CASE
                      WHEN pai_timeline_events.curation_status = 'curated'
                      THEN pai_timeline_events.importance
                      ELSE EXCLUDED.importance
                  END,
                  confidence = EXCLUDED.confidence,
                  is_predicted = EXCLUDED.is_predicted,
                  curation_status = CASE
                      WHEN pai_timeline_events.curation_status = 'curated'
                        AND EXCLUDED.curation_status = 'pending'
                      THEN 'curated'
                      ELSE EXCLUDED.curation_status
                  END,
                  filter_reason = EXCLUDED.filter_reason,
                  updated_at = NOW(),
                  curated_at = CASE
                      WHEN EXCLUDED.curation_status = 'curated'
                      THEN NOW()
                      ELSE pai_timeline_events.curated_at
                  END
                RETURNING *
                """,
                (
                    self._user_id,
                    ev.id,
                    ev.occurred_at,
                    ev.end_at,
                    ev.source,
                    ev.event_type,
                    ev.title,
                    ev.body,
                    json.dumps(ev.participants),
                    json.dumps(ev.location) if ev.location else None,
                    json.dumps(ev.metadata),
                    json.dumps(ev.source_ref),
                    ev.importance,
                    ev.confidence,
                    ev.is_predicted,
                    ev.curation_status,
                    ev.filter_reason,
                    ev.dedupe_key,
                    ev.curation_status,
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = f"timeline upsert returned no row (id={ev.id})"
            raise RuntimeError(msg)
        return TimelineEventRow.from_record(row)

    async def supersede(
        self,
        *,
        old_id: str,
        new_event: IngestTimelineEvent,
        changed_fields: dict[str, Any] | None = None,
        by: str = "rule",
    ) -> TimelineEventRow:
        """Reschedule chain: insert a new version of an event and mark
        the old row as superseded.

        Both rows survive. Default queries only return the current
        version. `get_history(old_id)` walks the chain for "intent
        change" analysis.
        """
        old = await self.get(old_id)
        if old is None:
            msg = f"supersede: no row with id={old_id}"
            raise ValueError(msg)

        history_entry = {
            "at": datetime.now(old.occurred_at.tzinfo).isoformat()
            if old.occurred_at.tzinfo
            else datetime.utcnow().isoformat(),
            "from_id": old_id,
            "to_id": new_event.id,
            "by": by,
            "changed_fields": changed_fields or {},
        }
        new_history = [*old.history, history_entry]

        # Atomicity: INSERT new version + UPDATE old row must commit
        # together. Without the explicit transaction, a failure between
        # the two leaves a new row whose supersedes_id points to an old
        # row that never gets superseded_by_id set — i.e. the chain is
        # broken from one direction and `get_history` returns stale state.
        async with self._conn.transaction(), self._conn.cursor() as cur:
            # Insert new version
            await cur.execute(
                """
                INSERT INTO pai_timeline_events
                  (user_id, id,
                   occurred_at, end_at,
                   source, event_type,
                   title, body,
                   participants, location, metadata,
                   source_ref,
                   importance, confidence, is_predicted,
                   curation_status, filter_reason,
                   version, supersedes_id, history,
                   dedupe_key,
                   curated_at)
                VALUES
                  (%s, %s,
                   %s, %s,
                   %s, %s,
                   %s, %s,
                   %s::jsonb, %s::jsonb, %s::jsonb,
                   %s::jsonb,
                   %s, %s, %s,
                   %s, %s,
                   %s, %s, %s::jsonb,
                   %s,
                   CASE WHEN %s = 'curated' THEN NOW() ELSE NULL END)
                RETURNING *
                """,
                (
                    self._user_id,
                    new_event.id,
                    new_event.occurred_at,
                    new_event.end_at,
                    new_event.source,
                    new_event.event_type,
                    new_event.title,
                    new_event.body,
                    json.dumps(new_event.participants),
                    json.dumps(new_event.location) if new_event.location else None,
                    json.dumps(new_event.metadata),
                    json.dumps(new_event.source_ref),
                    new_event.importance,
                    new_event.confidence,
                    new_event.is_predicted,
                    new_event.curation_status,
                    new_event.filter_reason,
                    old.version + 1,
                    old_id,
                    json.dumps(new_history),
                    new_event.dedupe_key,
                    new_event.curation_status,
                ),
            )
            new_row = await cur.fetchone()

            # Mark old row superseded (bidirectional link).
            await cur.execute(
                """
                UPDATE pai_timeline_events
                SET superseded_by_id = %s,
                    updated_at = NOW()
                WHERE user_id = %s AND id = %s
                """,
                (new_event.id, self._user_id, old_id),
            )
        if new_row is None:
            msg = "supersede insert returned no row"
            raise RuntimeError(msg)
        return TimelineEventRow.from_record(new_row)

    async def get(self, event_id: str) -> TimelineEventRow | None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                "SELECT * FROM pai_timeline_events WHERE user_id = %s AND id = %s",
                (self._user_id, event_id),
            )
            row = await cur.fetchone()
        return TimelineEventRow.from_record(row) if row else None

    async def query(
        self,
        *,
        window_start: datetime,
        window_end: datetime,
        sources: list[str] | None = None,
        event_types: list[str] | None = None,
        min_importance: float = 0.3,
        include_predicted: bool = False,
        include_pending: bool = True,
        include_filtered: bool = False,
        include_superseded: bool = False,
        limit: int = 200,
    ) -> list[TimelineEventRow]:
        """Window scan, chronological ASC. Default filters tuned for the
        generator agent's primary use:

          - include pending curation (ambient events that haven't been
            LLM-scored yet still surface; the curator catches up async)
          - drop LLM-judged-junk
          - drop predicted (caller opts in for future view)
          - drop superseded versions
          - importance threshold 0.3
        """
        clauses = [
            "user_id = %s",
            "occurred_at >= %s",
            "occurred_at < %s",
            "importance >= %s",
        ]
        params: list[Any] = [
            self._user_id,
            window_start,
            window_end,
            min_importance,
        ]

        if sources is not None:
            clauses.append("source = ANY(%s)")
            params.append(sources)
        if event_types is not None:
            clauses.append("event_type = ANY(%s)")
            params.append(event_types)
        if not include_predicted:
            clauses.append("is_predicted = FALSE")
        if not include_pending:
            clauses.append("curation_status <> 'pending'")
        if not include_filtered:
            clauses.append("curation_status <> 'filtered_out'")
        if not include_superseded:
            clauses.append("superseded_by_id IS NULL")

        where = " AND ".join(clauses)
        params.append(limit)

        async with self._conn.cursor() as cur:
            await cur.execute(
                f"""
                SELECT * FROM pai_timeline_events
                WHERE {where}
                ORDER BY occurred_at ASC
                LIMIT %s
                """,
                params,
            )
            rows = await cur.fetchall()
        return [TimelineEventRow.from_record(r) for r in rows]

    async def in_progress(
        self,
        *,
        at: datetime,
        sources: list[str] | None = None,
        limit: int = 50,
    ) -> list[TimelineEventRow]:
        """Interval events that contain `at`:
          occurred_at <= at AND end_at >= at
        Returns "what's happening right now" — meetings in session,
        ongoing audio capture, active visits.

        Includes both `curated` and `pending` rows (a currently-running
        ambient capture is what the caller wants to know about, even
        if the curator hasn't scored it yet). `filtered_out` and
        superseded rows stay hidden.
        """
        clauses = [
            "user_id = %s",
            "end_at IS NOT NULL",
            "occurred_at <= %s",
            "end_at >= %s",
            "curation_status <> 'filtered_out'",
            "superseded_by_id IS NULL",
        ]
        params: list[Any] = [self._user_id, at, at]
        if sources is not None:
            clauses.append("source = ANY(%s)")
            params.append(sources)
        params.append(limit)
        where = " AND ".join(clauses)
        async with self._conn.cursor() as cur:
            await cur.execute(
                f"""
                SELECT * FROM pai_timeline_events
                WHERE {where}
                ORDER BY occurred_at DESC
                LIMIT %s
                """,
                params,
            )
            rows = await cur.fetchall()
        return [TimelineEventRow.from_record(r) for r in rows]

    async def get_history(self, event_id: str) -> list[TimelineEventRow]:
        """Walk the supersede chain for an event id, oldest to newest.

        Useful for "this meeting was rescheduled 3 times — what was the
        original intent" type queries.
        """
        # Walk back to the root (no supersedes_id).
        chain: list[TimelineEventRow] = []
        seen: set[str] = set()
        current = await self.get(event_id)
        while current is not None and current.id not in seen:
            seen.add(current.id)
            chain.append(current)
            if current.supersedes_id is None:
                break
            current = await self.get(current.supersedes_id)
        # Walk forward from the original event id.
        forward: list[TimelineEventRow] = []
        if chain:
            head = chain[-1]
            cur_row = head
            visited = {head.id}
            while cur_row.superseded_by_id is not None and cur_row.superseded_by_id not in visited:
                nxt = await self.get(cur_row.superseded_by_id)
                if nxt is None:
                    break
                visited.add(nxt.id)
                forward.append(nxt)
                cur_row = nxt
        # Build chronological list: root first, then forward chain.
        if not chain:
            return []
        root = chain[-1]
        return [root, *forward]

    async def list_pending(self, *, limit: int = 200) -> list[TimelineEventRow]:
        """Curation backlog. Worker pulls oldest first."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT * FROM pai_timeline_events
                WHERE user_id = %s AND curation_status = 'pending'
                ORDER BY ingested_at ASC
                LIMIT %s
                """,
                (self._user_id, limit),
            )
            rows = await cur.fetchall()
        return [TimelineEventRow.from_record(r) for r in rows]

    async def mark_curated(
        self,
        *,
        event_id: str,
        importance: float,
        filter_reason: str | None = None,
    ) -> bool:
        """Move a `pending` row to `curated` (or `filtered_out` if
        importance < 0.2 *and* a non-empty filter_reason is given).
        Idempotent on already-curated rows (returns False).

        Filter-out gate uses `is not None and .strip()` rather than
        truthiness so an empty / whitespace string from a sloppy LLM
        output still routes to plain `curated` instead of silently
        flipping to `filtered_out` with a useless reason. The reason
        column itself stays NULL when the input is blank — saves
        downstream auditors from "filter_reason=''" noise.
        """
        stripped_reason = filter_reason.strip() if filter_reason is not None else ""
        has_reason = stripped_reason != ""
        new_status = "filtered_out" if (importance < 0.2 and has_reason) else "curated"
        stored_reason = stripped_reason if has_reason else None
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_timeline_events
                SET importance = %s,
                    curation_status = %s,
                    filter_reason = %s,
                    curated_at = NOW(),
                    updated_at = NOW()
                WHERE user_id = %s AND id = %s AND curation_status = 'pending'
                """,
                (importance, new_status, stored_reason, self._user_id, event_id),
            )
            return (cur.rowcount or 0) > 0

    async def increment_references(
        self,
        *,
        event_ids: list[str],
        run_id: str,
    ) -> int:
        """Bump `reference_count` and append `run_id` to
        `referenced_by_runs` for each event id. Idempotent per (event,
        run) — appending the same run twice still increments because we
        can't cheaply de-dup inside JSONB without a function. Acceptable:
        count is "soft" anyway."""
        if not event_ids:
            return 0
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_timeline_events
                SET reference_count = reference_count + 1,
                    last_referenced_at = NOW(),
                    referenced_by_runs = referenced_by_runs || %s::jsonb,
                    updated_at = NOW()
                WHERE user_id = %s AND id = ANY(%s)
                """,
                (json.dumps([run_id]), self._user_id, event_ids),
            )
            return cur.rowcount or 0

    # ── Ingestion-ordered stream (proactive consumption) ───────────────
    #
    # The proactive loop walks timeline events in ingestion order via the
    # `pai_proactive_state` watermark (migration 074). Reads are ordered
    # by `ingested_at` (when the row arrived), not `occurred_at` (when the
    # event happened) — an email sent last week but fetched today must
    # surface today. Predicted events are excluded: the heartbeat reasons
    # over observed reality, not speculation.

    _EVOLVE_FILTER_SQL = (
        "is_predicted = FALSE AND superseded_by_id IS NULL AND curation_status <> 'filtered_out'"
    )

    async def list_since_ingested(
        self,
        *,
        after: datetime,
        before: datetime,
        limit: int = 500,
    ) -> list[TimelineEventRow]:
        """Events that arrived in `(after, before]`, ingestion order ASC.
        The proactive loop passes `after` = last processed `ingested_at`
        and `before` = now, then advances its `pai_proactive_state`
        watermark to the max `ingested_at` it consumed."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                f"""
                SELECT * FROM pai_timeline_events
                WHERE user_id = %s
                  AND ingested_at > %s
                  AND ingested_at <= %s
                  AND {self._EVOLVE_FILTER_SQL}
                ORDER BY ingested_at ASC
                LIMIT %s
                """,
                (self._user_id, after, before, limit),
            )
            rows = await cur.fetchall()
        return [TimelineEventRow.from_record(r) for r in rows]


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────


def _loads_dict(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        return json.loads(value)
    return None


def _loads_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        loaded = json.loads(value)
        return loaded if isinstance(loaded, list) else []
    return []
