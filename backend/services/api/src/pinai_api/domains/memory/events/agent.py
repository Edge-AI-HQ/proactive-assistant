"""Agent-facing L1 event-stream API — events_search (read) + event_append (write).

/api/agent/events — EdDSA JWT (current_agent_run), under user_scoped_tx (RLS).
This is the L1 retrieval surface the agent reads over and the only write path
that appends an event. Both replace the old memory/signals/raw read+write tools.
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pinai_db.rls import user_scoped_tx
from pydantic import BaseModel, Field

from ....platform.auth.deps import (
    AgentRun,
    agent_write_provenance,
    current_agent_run,
    get_pool,
)
from .repository import AppendEventInput, EventRow, EventsRepository

router = APIRouter(prefix="/api/agent/events", tags=["agent-events"])

# Pipeline sources an agent may legitimately author via event_append (design
# §五-210 `source`). Connector pipelines (gmail/gcal/slack/…), world, ambient
# ingest and pinai_feedback are projector/ingest-owned — the agent can't forge
# them here. `predicted.*` (predicted future events) is allowed by prefix.
_AGENT_WRITABLE_SOURCES = frozenset({"pinai_chat", "agent_action", "device"})


def _validate_source(source: str) -> None:
    """Reject an agent trying to author a projector/connector-owned pipeline
    source (e.g. forging a `gmail` event). source is the pipeline discriminator,
    not a free-form field — only the agent-owned pipelines are writable here."""
    if source in _AGENT_WRITABLE_SOURCES or source.startswith("predicted."):
        return
    raise HTTPException(
        422,
        f"source {source!r} is not agent-writable; allowed: "
        f"{sorted(_AGENT_WRITABLE_SOURCES)} or predicted.*",
    )


def _to_dict(e: EventRow) -> dict[str, Any]:
    return {
        "id": e.id,
        "source": e.source,
        "eventType": e.event_type,
        "occurredAt": e.occurred_at.isoformat() if e.occurred_at else None,
        "endAt": e.end_at.isoformat() if e.end_at else None,
        "title": e.title,
        "body": e.body,
        "structured": e.structured,
        "sourceRef": e.source_ref,
        "curatedAt": e.curated_at.isoformat() if e.curated_at else None,
        # Supersede chain pointer — the generator's append-only log keeps the
        # old version in cached blocks, so the model needs the pointer on the
        # REVISION's arrival to know it replaces the earlier one (design §4.1).
        "supersedesId": e.supersedes_id,
    }


# ── event_source: L0 verbatim content behind an event ──────────────────────

# JSON dump cap for the raw payload handed to the agent. Big enough for a full
# email / calendar item, small enough not to blow the context window.
_SOURCE_CHAR_CAP = 16_000


def _dump_source(source: dict[str, Any]) -> tuple[str, bool]:
    """Serialize the domain row for the agent (ISO datetimes, stable keys);
    truncate at _SOURCE_CHAR_CAP. Returns (text, truncated)."""
    import json  # noqa: PLC0415

    text = json.dumps(source, ensure_ascii=False, default=str, indent=1)
    if len(text) > _SOURCE_CHAR_CAP:
        return text[:_SOURCE_CHAR_CAP], True
    return text, False


@router.get("/{event_id}/source")
async def get_event_source(
    event_id: str,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """The verbatim L0 content behind an event (design §三 registry: the
    event's `source` routes back to its domain table).

    Supersede-aware: a stale id (an old revision cited somewhere) resolves
    server-side to the CURRENT revision — the chain is an internal mechanism,
    never the agent's job to walk. The response says so via `resolvedTo` +
    `revisionNote`, and surfaces `structured.status` (e.g. cancelled) so the
    agent sees the final state at a glance. Events without raw archives
    (agent_action / pinai_chat / pinai_feedback) and TTL'd raws degrade to
    `source: null` + note (traceability is best-effort by design §三)."""
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = EventsRepository(run.user_id, conn)
        head = await repo.resolve_head(event_id)
        if head is None:
            raise HTTPException(404, f"event {event_id!r} not found")
        source = await repo.fetch_source_content(head)

    out: dict[str, Any] = {
        "ok": True,
        "event": _to_dict(head),
    }
    if head.id != event_id:
        out["resolvedTo"] = head.id
        out["revisionNote"] = "the requested event was superseded; showing the current revision"
    status = head.structured.get("status")
    if isinstance(status, str):
        out["status"] = status
    if source is None:
        out["source"] = None
        out["note"] = (
            "no source content available for this event"
            if not head.source_ref
            else "source content no longer available"
        )
    else:
        text, truncated = _dump_source(source)
        out["source"] = text
        if truncated:
            out["truncated"] = True
    return out


@router.get("/search")
async def search_events(
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
    q: str | None = Query(None, max_length=2000),
    event_type: str | None = Query(None, alias="eventType"),
    since: datetime | None = Query(None),
    until: datetime | None = Query(None),
    status: str = Query("active"),
    limit: int = Query(20, ge=1, le=100),
    recorded_since: datetime | None = Query(None, alias="recordedSince"),
    recorded_until: datetime | None = Query(None, alias="recordedUntil"),
    arrivals_limit: int = Query(2000, ge=1, le=5000, alias="arrivalsLimit"),
    newest_first: bool = Query(False, alias="newestFirst"),
):
    """Hybrid keyword + semantic search when `q` is given (ts_rank + cosine over
    `active` events, RRF-fused — §5.5 objective score preserved in the semantic
    lane), else a deterministic time/type window (recency / gating). Both scope to
    the user. `eventType` / `since` narrow either path; `status` (active/pending/
    ...) lets evolve read the pending queue (only applies to the no-`q` path).

    ARRIVAL AXIS: `recordedSince` + `recordedUntil` switch to the arrival
    stream — everything that became known in (since, until], arrival order,
    superseded rows INCLUDED (immutable history). This is the generator's
    cache-stable log source (design §4.1/§4.2); it has its own `arrivalsLimit`
    because a multi-day log is far larger than a retrieval page."""
    if recorded_since is not None and recorded_until is not None:
        async with user_scoped_tx(pool, run.user_id) as conn:
            repo = EventsRepository(run.user_id, conn)
            rows = await repo.list_arrivals(
                recorded_since=recorded_since,
                recorded_until=recorded_until,
                limit=arrivals_limit,
                newest_first=newest_first,
            )
        return {"items": [_to_dict(r) for r in rows]}
    if q and q.strip():
        from ....platform.auth.user_service import load_user_by_id  # noqa: PLC0415
        from ....platform.embeddings import (  # noqa: PLC0415
            EmbeddingError,
            text_to_query_vector,
        )

        searcher = await load_user_by_id(pool, run.user_id)
        try:
            qvec = await text_to_query_vector(
                q,
                virtual_key=searcher.litellm_virtual_key if searcher else None,
            )
        except EmbeddingError as e:
            raise HTTPException(503, f"embedding service unavailable: {e}") from e

        async with user_scoped_tx(pool, run.user_id) as conn:
            repo = EventsRepository(run.user_id, conn)
            rows = await repo.search_hybrid(
                query_vector=qvec,
                query_text=q,
                limit=limit,
                event_type=event_type,
                since=since,
                run_id=run.run_id,
            )
    else:
        async with user_scoped_tx(pool, run.user_id) as conn:
            repo = EventsRepository(run.user_id, conn)
            rows = await repo.search_structured(
                event_type=event_type,
                since=since,
                until=until,
                status=status,
                limit=limit,
                run_id=run.run_id,
            )
    return {"items": [_to_dict(r) for r in rows]}


class EventAppendRequest(BaseModel):
    source: str = Field(min_length=1, max_length=64)
    event_type: str = Field(alias="eventType", min_length=1, max_length=64)
    occurred_at: datetime | None = Field(default=None, alias="occurredAt")
    title: str | None = None
    body: str | None = None
    structured: dict[str, Any] | None = None
    end_at: datetime | None = Field(default=None, alias="endAt")
    dedupe_key: str | None = Field(default=None, alias="dedupeKey")


@router.post("/append")
async def append_event(
    body: EventAppendRequest,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Append one agent-authored event. Idempotent on dedupe_key; when the
    agent omits it we derive a stable one from the content. Agent-authored
    events are curated by definition (the agent chose to record them) — they
    skip the projector's uncurated queue (curated=True)."""
    _validate_source(body.source)
    event_id = f"evt_{uuid.uuid4().hex[:16]}"
    occurred = body.occurred_at or datetime.now(UTC)
    dedupe = (
        body.dedupe_key
        or "agent:"
        + hashlib.sha256(
            f"{body.source}:{body.event_type}:{occurred.isoformat()}:{body.title or ''}".encode()
        ).hexdigest()[:24]
    )
    # Server-stamp impersonation provenance into structured (NEVER from body) so
    # an internal-operator write can't disguise as the user's own. Empty merge for
    # a normal user run — see deps.agent_write_provenance.
    structured = {**(body.structured or {}), **agent_write_provenance(run)}
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = EventsRepository(run.user_id, conn)
        row = await repo.append(
            AppendEventInput(
                id=event_id,
                source=body.source,
                event_type=body.event_type,
                occurred_at=occurred,
                end_at=body.end_at,
                title=body.title,
                body=body.body,
                structured=structured,
                dedupe_key=dedupe,
                curated=True,
            )
        )
    return {"item": _to_dict(row)}


class CurateRequest(BaseModel):
    id: str


@router.post("/curate")
async def curate_event(
    body: CurateRequest,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Mark an event curated — evolve has processed it (distilled into the
    portrait if it qualified, or judged not to). Stamps curated_at=now() so it
    leaves the uncurated queue (design §八-345). There is no status/importance
    decision: noise is ordered down by the objective score (§5.5) and reclaimed
    by rollup/supersede, not marked filtered_out. Returns ok=False if not found."""
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = EventsRepository(run.user_id, conn)
        ok = await repo.mark_curated(body.id)
    return {"ok": ok, "id": body.id}
