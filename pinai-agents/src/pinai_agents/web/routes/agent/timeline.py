"""/api/agent/timeline/* — agent-facing timeline event queries.

This is the primary read surface for `client.timeline.*` (pinai_sdk).
The generator agent calls these endpoints to get past / future / now
events for card generation.

Endpoints:
  GET  /api/agent/timeline/query             — window scan
  GET  /api/agent/timeline/in_progress       — "what's happening now"
  GET  /api/agent/timeline/get/{event_id}    — single event drill-down
  GET  /api/agent/timeline/history/{event_id} — supersede chain
  POST /api/agent/timeline/ingest            — agent-side writer (evolve)
  POST /api/agent/timeline/supersede         — reschedule chain
  POST /api/agent/timeline/reference         — bump reference_count
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from ...auth.deps import AgentRun, current_agent_run, get_pool
from ...db.repositories.timeline import (
    IngestTimelineEvent,
    TimelineEventRow,
    TimelineRepository,
)
from ...db.rls import user_scoped_tx
from ...services.ambient_speaker import ambient_speaker_preview

router = APIRouter(prefix="/api/agent/timeline", tags=["agent-timeline"])


# ─────────────────────────────────────────────────────────────────────
# Serialization
# ─────────────────────────────────────────────────────────────────────


def _serialize(row: TimelineEventRow, *, include_body: bool = False) -> dict[str, Any]:
    """Shape sent to the agent. Keep it small by default — `body` and
    `metadata` are large and only shipped on drill-down (`/get`)."""
    out: dict[str, Any] = {
        "id": row.id,
        "occurredAt": row.occurred_at.isoformat(),
        "endAt": row.end_at.isoformat() if row.end_at else None,
        "source": row.source,
        "eventType": row.event_type,
        "title": row.title,
        "participants": row.participants,
        "location": row.location,
        "importance": row.importance,
        "confidence": row.confidence,
        "isPredicted": row.is_predicted,
        "curationStatus": row.curation_status,
        "version": row.version,
        "dedupeKey": row.dedupe_key,
    }
    # Ambient utterances carry diarized speaker attribution in metadata;
    # surface a self/other preview inline so the list view (which drops
    # metadata) still lets the agent weight the user's own speech.
    if row.source.startswith("ambient.") and isinstance(row.metadata, dict):
        out.update(ambient_speaker_preview(row.metadata))
    if include_body:
        out["body"] = row.body
        out["metadata"] = row.metadata
        out["sourceRef"] = row.source_ref
        out["history"] = row.history
        out["filterReason"] = row.filter_reason
        out["supersedesId"] = row.supersedes_id
        out["supersededById"] = row.superseded_by_id
    return out


def _parse_iso(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as e:
        raise HTTPException(
            status_code=400,
            detail=f"invalid datetime: {value!r}",
        ) from e


# ─────────────────────────────────────────────────────────────────────
# Read endpoints
# ─────────────────────────────────────────────────────────────────────


@router.get("/query")
async def query_timeline(
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
    window_start: str = Query(..., alias="windowStart"),
    window_end: str = Query(..., alias="windowEnd"),
    sources: str | None = Query(
        None,
        description="Comma-separated source list, e.g. 'gmail,gcal,ambient.utterance'",
    ),
    event_types: str | None = Query(None, alias="eventTypes"),
    min_importance: float = Query(0.3, ge=0, le=1, alias="minImportance"),
    include_predicted: bool = Query(False, alias="includePredicted"),
    include_pending: bool = Query(True, alias="includePending"),
    include_filtered: bool = Query(False, alias="includeFiltered"),
    include_superseded: bool = Query(False, alias="includeSuperseded"),
    include_body: bool = Query(False, alias="includeBody"),
    limit: int = Query(200, ge=1, le=2000),
):
    """Main timeline query — window scan, chronological ASC.

    Window must be explicit: callers pass `windowStart` and `windowEnd`
    as ISO timestamps. Convenience methods on the SDK side wrap
    "past N hours" / "future N hours" patterns.
    """
    ws = _parse_iso(window_start)
    we = _parse_iso(window_end)
    if ws is None or we is None:
        raise HTTPException(status_code=400, detail="windowStart and windowEnd required")
    if we <= ws:
        raise HTTPException(
            status_code=400,
            detail="windowEnd must be after windowStart",
        )

    source_list = [s.strip() for s in sources.split(",")] if sources else None
    type_list = [s.strip() for s in event_types.split(",")] if event_types else None

    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = TimelineRepository(run.user_id, conn)
        rows = await repo.query(
            window_start=ws,
            window_end=we,
            sources=source_list,
            event_types=type_list,
            min_importance=min_importance,
            include_predicted=include_predicted,
            include_pending=include_pending,
            include_filtered=include_filtered,
            include_superseded=include_superseded,
            limit=limit,
        )
    return {"items": [_serialize(r, include_body=include_body) for r in rows]}


@router.get("/in_progress")
async def in_progress(
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
    at: str | None = Query(None, description="ISO timestamp; defaults to now"),
    sources: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
):
    """Interval events covering `at`. Returns "meetings/calls/sessions
    currently in session" — useful for the agent to know whether the
    user is in the middle of something."""
    at_dt = _parse_iso(at) or datetime.now(UTC)
    source_list = [s.strip() for s in sources.split(",")] if sources else None
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = TimelineRepository(run.user_id, conn)
        rows = await repo.in_progress(at=at_dt, sources=source_list, limit=limit)
    return {"items": [_serialize(r) for r in rows]}


@router.get("/ingested_window")
async def ingested_window(
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
    after: str = Query(..., description="ISO lower bound (exclusive) on ingested_at"),
    before: str = Query(..., description="ISO upper bound (inclusive) on ingested_at"),
    include_body: bool = Query(True, alias="includeBody"),
    limit: int = Query(500, ge=1, le=2000),
):
    """Events that arrived in `(after, before]`, ingestion order ASC.

    The evolve agent's read surface — it consumes the timeline by
    ingestion time via the `pai_timeline_evolve_cursor` watermark, so this
    is ordered by `ingested_at` (not `occurred_at`). Excludes predicted /
    filtered_out / superseded rows; includes pending."""
    a = _parse_iso(after)
    b = _parse_iso(before)
    if a is None or b is None:
        raise HTTPException(status_code=400, detail="after and before required")
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = TimelineRepository(run.user_id, conn)
        rows = await repo.list_since_ingested(after=a, before=b, limit=limit)
    return {"items": [_serialize(r, include_body=include_body) for r in rows]}


@router.get("/get/{event_id}")
async def get_event(
    event_id: str,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Full event with body / metadata / history — drill-down from
    `/query` (which strips heavy fields for context economy)."""
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = TimelineRepository(run.user_id, conn)
        row = await repo.get(event_id)
    if row is None:
        raise HTTPException(status_code=404, detail="event not found")
    return _serialize(row, include_body=True)


@router.get("/history/{event_id}")
async def get_history(
    event_id: str,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Walk the supersede chain. Returns root → current chronological.
    Useful for "this meeting was rescheduled 3 times — what was the
    original intent" queries."""
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = TimelineRepository(run.user_id, conn)
        chain = await repo.get_history(event_id)
    if not chain:
        raise HTTPException(status_code=404, detail="event not found")
    return {"items": [_serialize(r, include_body=True) for r in chain]}


# ─────────────────────────────────────────────────────────────────────
# Write endpoints (evolve agent / curation worker)
# ─────────────────────────────────────────────────────────────────────


@router.post("/ingest")
async def ingest_event(
    body: dict,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Insert or UPSERT one event. Used by the evolve agent and the
    ambient ingest path.

    Required: occurredAt, source, eventType, title, sourceRef.
    Optional everything else.

    Stable on (user_id, dedupeKey) — repeated calls update content
    without breaking curation state (already-curated rows don't get
    bumped back to pending).
    """
    occurred = _parse_iso(body.get("occurredAt"))
    if occurred is None:
        raise HTTPException(status_code=400, detail="occurredAt required")
    end_at = _parse_iso(body.get("endAt")) if body.get("endAt") else None

    for key in ("source", "eventType", "title"):
        if not body.get(key):
            raise HTTPException(status_code=400, detail=f"{key} required")
    if "sourceRef" not in body or not isinstance(body["sourceRef"], dict):
        raise HTTPException(status_code=400, detail="sourceRef (object) required")

    event_id = body.get("id") or f"tle_{uuid.uuid4().hex[:16]}"

    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = TimelineRepository(run.user_id, conn)
        row = await repo.upsert_event(
            IngestTimelineEvent(
                id=event_id,
                occurred_at=occurred,
                end_at=end_at,
                source=body["source"],
                event_type=body["eventType"],
                title=body["title"],
                body=body.get("body"),
                participants=body.get("participants") or [],
                location=body.get("location"),
                metadata=body.get("metadata") or {},
                source_ref=body["sourceRef"],
                importance=float(body.get("importance", 0.5)),
                confidence=float(body.get("confidence", 1.0)),
                is_predicted=bool(body.get("isPredicted", False)),
                curation_status=body.get("curationStatus", "curated"),
                filter_reason=body.get("filterReason"),
                dedupe_key=body.get("dedupeKey"),
            )
        )
    return _serialize(row, include_body=True)


@router.post("/supersede")
async def supersede_event(
    body: dict,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Reschedule chain: replace `oldId` with a new event.

    Body shape: { oldId, newEvent: { ... same shape as /ingest ... },
                  changedFields?: {...}, by?: 'rule'|'llm' }.

    Inserts a new row with version+1, marks the old row superseded.
    Both rows survive in the table — default query returns only the
    latest; `/history/{event_id}` walks the chain.
    """
    old_id = body.get("oldId")
    new_event_body = body.get("newEvent") or {}
    if not old_id:
        raise HTTPException(status_code=400, detail="oldId required")

    occurred = _parse_iso(new_event_body.get("occurredAt"))
    if occurred is None:
        raise HTTPException(status_code=400, detail="newEvent.occurredAt required")
    end_at = _parse_iso(new_event_body.get("endAt")) if new_event_body.get("endAt") else None
    for key in ("source", "eventType", "title"):
        if not new_event_body.get(key):
            raise HTTPException(
                status_code=400,
                detail=f"newEvent.{key} required",
            )
    if "sourceRef" not in new_event_body or not isinstance(new_event_body["sourceRef"], dict):
        raise HTTPException(
            status_code=400,
            detail="newEvent.sourceRef (object) required",
        )

    new_event_id = new_event_body.get("id") or f"tle_{uuid.uuid4().hex[:16]}"

    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = TimelineRepository(run.user_id, conn)
        row = await repo.supersede(
            old_id=old_id,
            new_event=IngestTimelineEvent(
                id=new_event_id,
                occurred_at=occurred,
                end_at=end_at,
                source=new_event_body["source"],
                event_type=new_event_body["eventType"],
                title=new_event_body["title"],
                body=new_event_body.get("body"),
                participants=new_event_body.get("participants") or [],
                location=new_event_body.get("location"),
                metadata=new_event_body.get("metadata") or {},
                source_ref=new_event_body["sourceRef"],
                importance=float(new_event_body.get("importance", 0.5)),
                confidence=float(new_event_body.get("confidence", 1.0)),
                is_predicted=bool(new_event_body.get("isPredicted", False)),
                curation_status=new_event_body.get("curationStatus", "curated"),
                filter_reason=new_event_body.get("filterReason"),
                dedupe_key=new_event_body.get("dedupeKey"),
            ),
            changed_fields=body.get("changedFields"),
            by=body.get("by", "rule"),
        )
    return _serialize(row, include_body=True)


@router.post("/reference", status_code=status.HTTP_204_NO_CONTENT)
async def reference_events(
    body: dict,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Mark events as referenced by a run. Bumps reference_count and
    appends run_id to referenced_by_runs. Used by generator / dream
    to record evidence consumption."""
    event_ids = body.get("ids") or []
    run_id = body.get("runId") or run.run_id
    if not isinstance(event_ids, list):
        raise HTTPException(status_code=400, detail="ids must be an array")
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = TimelineRepository(run.user_id, conn)
        await repo.increment_references(event_ids=event_ids, run_id=run_id)
    return None
