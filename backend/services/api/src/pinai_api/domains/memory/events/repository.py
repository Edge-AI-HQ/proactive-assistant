"""L1 event-stream Repository — the bi-temporal semantic layer (events_search).

Schema: 111_pai_events.sql.

Append-only: history is never mutated in place. `append` is idempotent on
(user_id, dedupe_key) so re-projecting the same L0 row or an agent re-appending
the same event is a no-op that returns the existing row. A correction appends a
new row and `supersede` links the old one (system sets the back-pointer; agents
only ever append). `curated_at` is the projector→evolve handoff (design §223):
NULL = projector just wrote it (evolve's uncurated queue); NOT NULL = evolve
processed it, or a hot/user-explicit event that needs no evolve judgement.
Importance is NOT stored — it's computed at retrieval from objective signals
(reference_count × recency × event_type weight; design §5.5).

Events are NOT content-deduplicated — the same action at different times is N
rows. dedupe_key only guards the same event being written twice.
"""

from __future__ import annotations

import json
import logging
import math
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from pinai_db.base import UserScopedRepository

from .notify import EVENTS_CHANGED_CHANNEL

logger = logging.getLogger(__name__)


def gen_event_id() -> str:
    """Unique pai_events id (`evt_` prefix, microsecond timestamp + random tail).

    Callers generate ids (see `append`); this is the single definition every
    producer (projector / window rollup / world fan-out / portrait change
    events) shares — id shape is an Events-module concern.
    """
    return f"evt_{int(time.time() * 1_000_000):x}_{uuid.uuid4().hex[:8]}"


@dataclass(slots=True)
class EventRow:
    """1:1 with a pai_events row, decoded JSONB → dict."""

    id: str
    source: str
    event_type: str
    occurred_at: datetime
    end_at: datetime | None
    recorded_at: datetime
    title: str | None
    body: str | None
    structured: dict[str, Any]
    source_ref: str | None
    curated_at: datetime | None
    supersedes_id: str | None
    superseded_by_id: str | None
    dedupe_key: str
    reference_count: int
    last_referenced_at: datetime | None

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> EventRow:
        structured = row["structured"]
        return cls(
            id=row["id"],
            source=row["source"],
            event_type=row["event_type"],
            occurred_at=row["occurred_at"],
            end_at=row.get("end_at"),
            recorded_at=row["recorded_at"],
            title=row.get("title"),
            body=row.get("body"),
            structured=structured if isinstance(structured, dict) else json.loads(structured),
            source_ref=row.get("source_ref"),
            curated_at=row.get("curated_at"),
            supersedes_id=row.get("supersedes_id"),
            superseded_by_id=row.get("superseded_by_id"),
            dedupe_key=row["dedupe_key"],
            reference_count=row["reference_count"],
            last_referenced_at=row.get("last_referenced_at"),
        )


# Explicit read column list — mirrors EventRow.from_record. Omits the pgvector
# `embedding` (1536 floats / ~6 KB) + embedding_model / embedded_at: list/get
# views never need them, and dragging embedding through Sort spills to disk
# (same lesson as pai_memory). Semantic search selects embedding in its own query.
_READ_COLUMNS = (
    "id, source, event_type, occurred_at, end_at, recorded_at, title, body, "
    "structured, source_ref, curated_at, supersedes_id, "
    "superseded_by_id, dedupe_key, reference_count, last_referenced_at"
)


# Structural importance prior by event_type (doc §5.5 cold start): a transaction
# or meeting is inherently weightier than a stray utterance / movement, so a brand
# new event (reference_count=0, no usage signal yet) still ranks sensibly. Single
# source of truth — passed into the ranking SQL as a jsonb param so the table lives
# in code, not duplicated in SQL. Unknown event_type falls back to 0.5.
_EVENT_TYPE_WEIGHT: dict[str, float] = {
    "transaction": 1.0,
    "meeting": 0.9,
    "communication": 0.7,
    "preference": 1.0,
    "world_news": 0.6,
    "interaction": 0.6,
    "movement": 0.4,
    "device_state": 0.3,
    "utterance": 0.3,
    "agent_decision": 0.5,
}
_EVENT_TYPE_WEIGHT_JSON = json.dumps(_EVENT_TYPE_WEIGHT)


def visual_importance(event_type: str, reference_count: int) -> float:
    """Visual weight for the timeline UI (drives point size / brightness).

    Deliberately SIMPLER than the retrieval objective score (_objective_score_sql):
    it drops the recency decay, because the timeline's x-axis already encodes time
    — re-encoding recency in the dot size would double-count it. So this is just
    the structural prior × usage heat:

        event_type weight × (1 + ln(1 + reference_count))

    Reuses _EVENT_TYPE_WEIGHT as the single source of truth for the type prior.
    Returns an unbounded float >= 0; the frontend scales it to a size range over
    the currently-visible events.
    """
    weight = _EVENT_TYPE_WEIGHT.get(event_type, 0.5)
    return weight * (1.0 + math.log1p(reference_count))


# Recency half-life (days) for the ranking decay. last_referenced_at (fallback
# occurred_at) decays as exp(-ln2·age_days/halflife): a 30-day-old unreferenced
# event ranks at ~half a fresh one's recency, but a recently-referenced old event
# is pulled back up — the recency-weighted Matthew effect that stops old events
# from permanently dominating (doc §七-330). Future occurred_at (upcoming
# meetings) clamps age to 0 → recency 1.0, not an exploding boost.
_RECENCY_HALFLIFE_DAYS = 30.0


def _objective_score_sql(similarity_expr: str) -> str:
    """Objective relevance score (doc §5.5 / §七-327) as a SQL ORDER BY fragment:

        score = similarity × event_type weight × recency decay × (1 + ln(1+ref))

    Fully objective, no LLM scoring. `similarity_expr` is the semantic term —
    ``"1"`` for the structured path, ``"GREATEST(0, 1 - distance)"`` for the
    semantic path (pgvector cosine distance → similarity). Cold start
    (reference_count=0) → ln(1)=0 → usage factor 1, so event_type weight + recency
    still order things with no special-casing. The fragment carries two %s
    placeholders, to be bound with (_EVENT_TYPE_WEIGHT_JSON, _RECENCY_HALFLIFE_DAYS)
    in that order.
    """
    return f"""
        {similarity_expr}
        * COALESCE((%s::jsonb ->> event_type)::real, 0.5)
        * exp(-ln(2.0) * GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(last_referenced_at, occurred_at))) / 86400.0) / %s)
        * (1 + ln(1 + reference_count))
    """


def _status_filter(status: str) -> str:
    """Map the public `status` contract → the curated_at / supersede columns
    (design §五-225, curation_status 4-state collapsed). `active` = the current
    valid version (not superseded — what every consumer retrieves); `pending` =
    evolve's uncurated queue (uncurated AND valid). `status` is an internal enum
    (not user input); anything other than 'pending' is treated as 'active'."""
    if status == "pending":
        return "superseded_by_id IS NULL AND curated_at IS NULL"
    return "superseded_by_id IS NULL"


@dataclass(slots=True)
class AppendEventInput:
    id: str
    source: str
    event_type: str
    occurred_at: datetime
    dedupe_key: str
    end_at: datetime | None = None
    title: str | None = None
    body: str | None = None
    structured: dict[str, Any] | None = None
    source_ref: str | None = None
    # curated_at handoff (design §223): default False = projector wrote it, NULL
    # curated_at, lands in evolve's uncurated queue. Hot / user-explicit callers
    # (preference / feedback / agent event_append) pass curated=True → stamped
    # now() so they skip the evolve queue (no LLM judgement needed).
    curated: bool = False
    supersedes_id: str | None = None


def _embed_text(title: str | None, body: str | None) -> str:
    """Text fed to the embedder — title + body, the human-meaningful surface."""
    return "\n".join(p for p in (title, body) if p and p.strip()).strip()


class EventsRepository(UserScopedRepository):
    async def append(self, input: AppendEventInput) -> EventRow:
        """Append one event, idempotent on (user_id, dedupe_key). On conflict
        returns the existing row unchanged (re-projection / re-append = no-op).
        Enqueues embedding(title+body) in the same transaction when newly
        inserted. Caller generates `id` (TEXT, unique per user)."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                f"""
                INSERT INTO pai_events
                  (user_id, id, source, event_type, occurred_at, end_at,
                   title, body, structured, source_ref, curated_at,
                   supersedes_id, dedupe_key)
                VALUES
                  (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s,
                   CASE WHEN %s::boolean THEN now() ELSE NULL END, %s, %s)
                ON CONFLICT (user_id, dedupe_key) DO NOTHING
                RETURNING {_READ_COLUMNS}
                """,
                (
                    self._user_id,
                    input.id,
                    input.source,
                    input.event_type,
                    input.occurred_at,
                    input.end_at,
                    input.title,
                    input.body,
                    json.dumps(input.structured or {}),
                    input.source_ref,
                    input.curated,
                    input.supersedes_id,
                    input.dedupe_key,
                ),
            )
            row = await cur.fetchone()

        if row is None:
            # dedupe conflict — return the existing row (idempotent).
            existing = await self.get_by_dedupe(input.dedupe_key)
            if existing is None:
                msg = f"append conflict but no existing row (user={self._user_id} key={input.dedupe_key})"
                raise RuntimeError(msg)
            return existing

        # Realtime signal plane (notify.py): delivered on COMMIT, deduped
        # per-tx by Postgres, so a batch ingest lands as one notification.
        # Dedupe no-ops above return early — nothing changed, no signal.
        async with self._conn.cursor() as cur:
            await cur.execute(
                "SELECT pg_notify(%s, %s)",
                (EVENTS_CHANGED_CHANNEL, str(self._user_id)),
            )

        text = _embed_text(input.title, input.body)
        if text:
            from ....platform.embeddings import enqueue as enqueue_embedding  # noqa: PLC0415

            await enqueue_embedding(
                self._conn,
                user_id=self._user_id,
                table_name="pai_events",
                row_id=input.id,
                text=text,
            )

        # supersede back-pointer: mark the old row as superseded by this one.
        if input.supersedes_id is not None:
            await self._set_superseded_by(input.supersedes_id, input.id)

        return EventRow.from_record(row)

    async def get(self, event_id: str) -> EventRow | None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                f"SELECT {_READ_COLUMNS} FROM pai_events WHERE user_id = %s AND id = %s",
                (self._user_id, event_id),
            )
            row = await cur.fetchone()
        return EventRow.from_record(row) if row else None

    async def get_by_dedupe(self, dedupe_key: str) -> EventRow | None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                f"SELECT {_READ_COLUMNS} FROM pai_events WHERE user_id = %s AND dedupe_key = %s",
                (self._user_id, dedupe_key),
            )
            row = await cur.fetchone()
        return EventRow.from_record(row) if row else None

    async def resolve_head(self, event_id: str) -> EventRow | None:
        """Follow the supersede chain from `event_id` to the CURRENT revision
        (superseded_by_id IS NULL). The chain is an internal mechanism — read
        surfaces resolve it server-side so a stale id (an old revision cited in
        a card's sources / a memory_edit evidence anchor / agent context) still
        lands on the final state instead of an outdated one. Returns None when
        `event_id` doesn't exist for this user.

        WITH RECURSIVE with a depth cap of 20: append+supersede never cycles by
        construction (the back-pointer is set exactly once), the cap is a pure
        defensive bound against corrupted data."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                f"""
                WITH RECURSIVE chain AS (
                    SELECT {_READ_COLUMNS}, 0 AS depth
                    FROM pai_events
                    WHERE user_id = %s AND id = %s
                    UNION ALL
                    SELECT {", ".join("e." + c.strip() for c in _READ_COLUMNS.split(","))},
                           chain.depth + 1
                    FROM pai_events e
                    JOIN chain ON e.user_id = %s AND e.id = chain.superseded_by_id
                    WHERE chain.depth < 20
                )
                SELECT {_READ_COLUMNS} FROM chain
                ORDER BY depth DESC
                LIMIT 1
                """,
                (self._user_id, event_id, self._user_id),
            )
            row = await cur.fetchone()
        return EventRow.from_record(row) if row else None

    async def fetch_source_content(self, event: EventRow) -> dict[str, Any] | None:
        """L0 verbatim content behind an event — the source→table registry
        (design §三: source_ref routes back to the domain table by the event's
        `source`). Returns a plain dict (domain-shaped) or None when the event
        has no source_ref, the source has no registry entry (agent_action /
        pinai_chat / pinai_feedback events carry no raw archive), or the raw
        row is gone (TTL'd — traceability is best-effort by design).

        Registry (SQL-only reads; touching a domain TABLE is not a module
        dependency — memory.events stays the bottom module):
          * composio → pai_raw_apps   (per-user, RLS-scoped)
          * device   → pai_raw_device (per-user, RLS-scoped)
          * world    → pai_world_signals (global row, public-read policy)
        """
        if not event.source_ref:
            return None
        async with self._conn.cursor() as cur:
            if event.source == "composio":
                await cur.execute(
                    """
                    SELECT toolkit, entity_type, occurred_at, title, snippet, payload
                    FROM pai_raw_apps WHERE user_id = %s AND id = %s
                    """,
                    (self._user_id, event.source_ref),
                )
            elif event.source == "device":
                await cur.execute(
                    """
                    SELECT kind, platform, occurred_at, title, snippet, payload
                    FROM pai_raw_device WHERE user_id = %s AND id = %s
                    """,
                    (self._user_id, event.source_ref),
                )
            elif event.source == "world":
                # Global L0 row (no user_id; public-read RLS policy, 023).
                await cur.execute(
                    """
                    SELECT provider, title, url, summary, published_at, topics, regions
                    FROM pai_world_signals WHERE id = %s
                    """,
                    (event.source_ref,),
                )
            else:
                return None
            row = await cur.fetchone()
        return dict(row) if row else None

    async def search_semantic(
        self,
        *,
        query_vector: list[float],
        limit: int = 10,
        event_type: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        run_id: str | None = None,
    ) -> list[EventRow]:
        """Semantic search over `active` events (pending / filtered_out / archived
        excluded — the agent retrieves only curated events), ranked by the
        objective score (doc §5.5): semantic similarity × event_type weight ×
        recency × usage. Rows without an embedding yet are skipped.

        Retrieve-then-rerank: a wider ANN candidate pool is pulled by cosine
        distance (HNSW-accelerated), then re-ordered by the fused objective score
        and truncated to `limit` — so a slightly-less-similar but heavily-referenced
        event can still surface. Hits are bumped (reference signal source, §七-329);
        run_id (the retrieving agent run) is recorded in referenced_by_runs."""
        vec_lit = "[" + ",".join(f"{x:.6f}" for x in query_vector) + "]"
        candidate_limit = max(limit * 4, 40)
        async with self._conn.cursor() as cur:
            # Raise HNSW recall to the candidate-pool size so the ANN pre-filter
            # actually returns `candidate_limit` rows to re-rank (else ef_search's
            # default 40 silently caps recall). Local to this tx (resets at commit).
            await cur.execute(
                "SELECT set_config('hnsw.ef_search', %s, true)", (str(candidate_limit),)
            )
            await cur.execute(
                f"""
                WITH candidates AS (
                    SELECT {_READ_COLUMNS}, embedding <=> %s::vector AS distance
                    FROM pai_events
                    WHERE user_id = %s
                      AND embedding IS NOT NULL
                      AND superseded_by_id IS NULL
                      AND (%s::text IS NULL OR event_type = %s)
                      AND (%s::timestamptz IS NULL OR occurred_at >= %s)
                      AND (%s::timestamptz IS NULL OR occurred_at <= %s)
                    ORDER BY embedding <=> %s::vector
                    LIMIT %s
                )
                SELECT {_READ_COLUMNS}
                FROM candidates
                ORDER BY ({_objective_score_sql("GREATEST(0, 1 - distance)")}) DESC,
                         occurred_at DESC, id
                LIMIT %s
                """,
                (
                    vec_lit,
                    self._user_id,
                    event_type,
                    event_type,
                    since,
                    since,
                    until,
                    until,
                    vec_lit,
                    candidate_limit,
                    _EVENT_TYPE_WEIGHT_JSON,
                    _RECENCY_HALFLIFE_DAYS,
                    limit,
                ),
            )
            rows = await cur.fetchall()
        result = [EventRow.from_record(r) for r in rows]
        await self._bump_references([r.id for r in result], run_id)
        return result

    async def search_hybrid(
        self,
        *,
        query_vector: list[float],
        query_text: str,
        limit: int = 10,
        event_type: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        run_id: str | None = None,
    ) -> list[EventRow]:
        """Hybrid keyword + semantic search over `active` events, RRF-fused
        (k=60, Cormack 2009). Two lanes, two strengths, then Reciprocal Rank
        Fusion combines their RANKED lists:
          * semantic — cosine candidate pool re-ranked by the objective score
            (§5.5: similarity × event_type weight × recency × usage). Keeps the
            event-stream's importance model.
          * keyword — ts_rank_cd over title_body_tsv (migration 120). Catches the
            exact-term hits cosine misses ("OpenAI billing").
        RRF is rank-based so the two incomparable score scales (cosine vs ts_rank)
        fuse cleanly — same recipe as world_search, now for all events. Bumps the
        fused top-N reference signal (only the returned set, not every candidate)."""
        vec_lit = "[" + ",".join(f"{x:.6f}" for x in query_vector) + "]"
        candidate_limit = max(limit * 4, 40)
        async with self._conn.cursor() as cur:
            await cur.execute(
                "SELECT set_config('hnsw.ef_search', %s, true)", (str(candidate_limit),)
            )
            # ── semantic lane: cosine pool → objective-score order (no bump yet) ──
            await cur.execute(
                f"""
                WITH candidates AS (
                    SELECT {_READ_COLUMNS}, embedding <=> %s::vector AS distance
                    FROM pai_events
                    WHERE user_id = %s
                      AND embedding IS NOT NULL
                      AND superseded_by_id IS NULL
                      AND (%s::text IS NULL OR event_type = %s)
                      AND (%s::timestamptz IS NULL OR occurred_at >= %s)
                      AND (%s::timestamptz IS NULL OR occurred_at <= %s)
                    ORDER BY embedding <=> %s::vector
                    LIMIT %s
                )
                SELECT {_READ_COLUMNS}
                FROM candidates
                ORDER BY ({_objective_score_sql("GREATEST(0, 1 - distance)")}) DESC,
                         occurred_at DESC, id
                LIMIT %s
                """,
                (
                    vec_lit,
                    self._user_id,
                    event_type,
                    event_type,
                    since,
                    since,
                    until,
                    until,
                    vec_lit,
                    candidate_limit,
                    _EVENT_TYPE_WEIGHT_JSON,
                    _RECENCY_HALFLIFE_DAYS,
                    candidate_limit,
                ),
            )
            sem_rows = await cur.fetchall()
            # ── keyword lane: tsvector @@ plainto_tsquery, ts_rank ──
            await cur.execute(
                f"""
                SELECT {_READ_COLUMNS},
                       ts_rank_cd(title_body_tsv, plainto_tsquery('english', %s)) AS kw_score
                FROM pai_events
                WHERE user_id = %s
                  AND superseded_by_id IS NULL
                  AND title_body_tsv @@ plainto_tsquery('english', %s)
                  AND (%s::text IS NULL OR event_type = %s)
                  AND (%s::timestamptz IS NULL OR occurred_at >= %s)
                  AND (%s::timestamptz IS NULL OR occurred_at <= %s)
                ORDER BY kw_score DESC, occurred_at DESC
                LIMIT %s
                """,
                (
                    query_text,
                    self._user_id,
                    query_text,
                    event_type,
                    event_type,
                    since,
                    since,
                    until,
                    until,
                    candidate_limit,
                ),
            )
            kw_rows = await cur.fetchall()

        # ── RRF fusion (k=60) over the two ranked lists ──
        k = 60
        fused: dict[str, dict[str, Any]] = {}
        for lane in (sem_rows, kw_rows):
            for rank, row in enumerate(lane):
                slot = fused.setdefault(row["id"], {"row": row, "rrf": 0.0})
                slot["rrf"] = float(slot["rrf"]) + 1.0 / (k + rank + 1)
        top = sorted(fused.values(), key=lambda s: float(s["rrf"]), reverse=True)[:limit]
        result = [EventRow.from_record(s["row"]) for s in top]
        await self._bump_references([r.id for r in result], run_id)
        return result

    async def search_structured(
        self,
        *,
        event_type: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        status: str = "active",
        limit: int = 30,
        run_id: str | None = None,
    ) -> list[EventRow]:
        """Deterministic time/type window (no vector) — the recency path and
        the gating/structured-filter path.

        Ordering is keyed to `run_id`: an agent relevance retrieval (run_id given)
        ranks by the objective score (doc §5.5: event_type weight × recency ×
        usage), while UI timeline / preference list / pending sweep / internal
        callers (run_id None) keep strict `occurred_at DESC` — those surfaces have
        a chronological contract that objective ranking would scramble. Only the
        agent retrieval (run_id given) bumps the reference signal (§七-329) — UI
        browse / internal reads don't pollute it."""
        if run_id is not None:
            order_clause = f"ORDER BY ({_objective_score_sql('1')}) DESC, occurred_at DESC, id"
            order_params: tuple[Any, ...] = (_EVENT_TYPE_WEIGHT_JSON, _RECENCY_HALFLIFE_DAYS)
        else:
            order_clause = "ORDER BY occurred_at DESC"
            order_params = ()
        async with self._conn.cursor() as cur:
            await cur.execute(
                f"""
                SELECT {_READ_COLUMNS}
                FROM pai_events
                WHERE user_id = %s
                  AND {_status_filter(status)}
                  AND (%s::text IS NULL OR event_type = %s)
                  AND (%s::timestamptz IS NULL OR occurred_at >= %s)
                  AND (%s::timestamptz IS NULL OR occurred_at <= %s)
                {order_clause}
                LIMIT %s
                """,
                (
                    self._user_id,
                    event_type,
                    event_type,
                    since,
                    since,
                    until,
                    until,
                    *order_params,
                    limit,
                ),
            )
            rows = await cur.fetchall()
        result = [EventRow.from_record(r) for r in rows]
        await self._bump_references([r.id for r in result], run_id)
        return result

    async def list_arrivals(
        self,
        *,
        recorded_since: datetime,
        recorded_until: datetime,
        limit: int = 2000,
        newest_first: bool = False,
    ) -> list[EventRow]:
        """The arrival stream — everything that BECAME KNOWN in the window,
        in arrival order (`recorded_at, id` total order, matching
        idx_pai_events_arrival).

        Deliberately does NOT filter superseded rows: the arrival stream is
        the immutable history ("what arrived when"), so a reschedule shows
        BOTH the original event's arrival and its later revision's arrival —
        the generator's cache-stable log is built exactly on this (design
        §4.1: log 按 recorded_at 记一切,supersede 修订也是到达)。Bounds are
        half-open (since, until] so consecutive rebuilds tile without overlap.
        No reference bump — a log rebuild is not an agent relevance
        retrieval.

        `newest_first` changes WHICH rows the limit keeps, not the output
        order: True selects the MOST RECENT `limit` arrivals (the generator's
        history segment wants "the newest N, then budget-truncate"; a plain
        ASC LIMIT would keep the oldest and throw away exactly the rows that
        matter). Output is always ascending arrival order either way."""
        direction = "DESC" if newest_first else "ASC"
        async with self._conn.cursor() as cur:
            await cur.execute(
                f"""
                SELECT {_READ_COLUMNS}
                FROM pai_events
                WHERE user_id = %s
                  AND recorded_at > %s
                  AND recorded_at <= %s
                ORDER BY recorded_at {direction}, id {direction}
                LIMIT %s
                """,
                (self._user_id, recorded_since, recorded_until, limit),
            )
            rows = await cur.fetchall()
        result = [EventRow.from_record(r) for r in rows]
        if newest_first:
            result.reverse()
        return result

    async def list_pending(self, *, limit: int = 100) -> list[EventRow]:
        """Events awaiting curation — evolve's input queue (curated_at IS NULL,
        not superseded; matches idx_pai_events_uncurated)."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                f"""
                SELECT {_READ_COLUMNS}
                FROM pai_events
                WHERE user_id = %s AND curated_at IS NULL AND superseded_by_id IS NULL
                ORDER BY occurred_at DESC
                LIMIT %s
                """,
                (self._user_id, limit),
            )
            rows = await cur.fetchall()
        return [EventRow.from_record(r) for r in rows]

    async def _bump_references(self, event_ids: list[str], run_id: str | None) -> None:
        """Reference bump — the SOURCE of the objective signal chain (doc §5.5 /
        §七-329). An agent relevance retrieval (run_id given) raises
        reference_count + last_referenced_at and appends the retrieving run to
        referenced_by_runs (deduped — "read 10× by one run" ≠ "referenced by 10
        independent runs", the latter is the real importance signal). Callers
        WITHOUT a run_id (UI timeline browse / preference list / internal sweeps)
        do NOT bump — only agent retrieval is the "use" that drives importance,
        so passive browsing can't inflate the signal.

        Best-effort side effect on the READ path: runs inside a SAVEPOINT (nested
        transaction) so a bump failure rolls back only the bump and never aborts
        the caller's transaction — the search results must still return. The
        feedback loop is intentional (referenced → ranks higher → more referenced),
        bounded by the recency term in the ranking."""
        if not event_ids or run_id is None:
            return
        try:
            async with self._conn.transaction():  # SAVEPOINT: isolate bump failure
                await self._conn.execute(
                    """
                    UPDATE pai_events
                    SET reference_count = reference_count + 1,
                        last_referenced_at = now(),
                        referenced_by_runs = CASE
                            WHEN %s::text IS NULL THEN referenced_by_runs
                            WHEN referenced_by_runs @> to_jsonb(ARRAY[%s::text])
                                THEN referenced_by_runs
                            ELSE referenced_by_runs || to_jsonb(%s::text)
                        END
                    WHERE user_id = %s AND id = ANY(%s)
                    """,
                    (run_id, run_id, run_id, self._user_id, event_ids),
                )
        except Exception:
            # Bump is a non-critical signal write; a failure must not fail the
            # read. Swallow + log (banned-by-default BLE is not in the ruff set).
            logger.warning(
                "events reference bump failed (user=%s, n=%d, run=%s)",
                self._user_id,
                len(event_ids),
                run_id,
                exc_info=True,
            )

    async def _set_superseded_by(self, old_id: str, new_id: str) -> None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_events
                SET superseded_by_id = %s
                WHERE user_id = %s AND id = %s
                """,
                (new_id, self._user_id, old_id),
            )

    async def supersede(self, *, old_id: str, new_id: str, event_type: str) -> EventRow | None:
        """Explicit replacement: mark `old_id` superseded by `new_id` (which
        was already appended as a separate active event).

        Asserts `new_id` is a current (not-yet-superseded) event of this user and
        the given `event_type` before touching the old one (mirrors the old
        PreferenceRepository.supersede — the caller must have appended the
        new event first). Used by the preferences route, where /add writes the
        replacement preference event and /supersede links the old.
        Returns the updated OLD row, or None if `old_id` wasn't a row of this
        user.
        """
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT 1 FROM pai_events
                WHERE user_id = %s AND id = %s
                  AND event_type = %s AND superseded_by_id IS NULL
                """,
                (self._user_id, new_id, event_type),
            )
            if await cur.fetchone() is None:
                msg = (
                    f"supersede target {new_id!r} must be a current {event_type} "
                    f"event of user {self._user_id} before superseding {old_id!r}"
                )
                raise ValueError(msg)
        await self._set_superseded_by(old_id, new_id)
        return await self.get(old_id)

    async def mark_curated(self, event_id: str) -> bool:
        """Mark an event curated — evolve has processed it (distilled into the
        portrait if it qualified, or judged not to). Stamps curated_at=now() so
        it leaves the uncurated queue (design §八-345). Idempotent: re-stamping an
        already-curated row is harmless. Returns True if a row was updated.

        There is no status/importance decision: noise is ordered down by the
        objective score (§5.5) and reclaimed by forgetting (supersede), not marked
        filtered_out; importance is computed at retrieval, never stored."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                "UPDATE pai_events SET curated_at = now() WHERE user_id = %s AND id = %s",
                (self._user_id, event_id),
            )
            return (cur.rowcount or 0) > 0
