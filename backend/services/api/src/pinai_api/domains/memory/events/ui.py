"""UI-facing L1 event timeline read — Ambient / Mirror render the activity stream.

/api/events — Supabase JWT (current_user), under user_scoped_tx (RLS).
Read-only timeline: active events, optional eventType / since / until / limit.
/api/events/stream is the SSE signal plane (see notify.py): it pushes bare
"changed" frames when this user's pai_events gets a write; the client refetches
the REST reads. The agent-facing semantic search + append live in events_agent.py.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pinai_db.rls import user_scoped_tx

from ....platform.auth.deps import current_user, get_pool
from ....platform.auth.user_service import User
from .notify import EventsChangeListener
from .repository import EventRow, EventsRepository, visual_importance

router = APIRouter(prefix="/api/events", tags=["events"])

# Keepalive cadence for /stream. Lesson from the chat SSE incident
# (main_chat_streaming keepalive anti-pattern): keepalives are PROACTIVE pings
# on a quiet stream, never an idle-timeout that severs it.
_PING_SECONDS = 15.0


def _to_dict(e: EventRow) -> dict[str, Any]:
    return {
        "id": e.id,
        "source": e.source,
        "eventType": e.event_type,
        "occurredAt": e.occurred_at.isoformat() if e.occurred_at else None,
        "endAt": e.end_at.isoformat() if e.end_at else None,
        # bi-temporal second axis: when the system learned of this event (vs
        # occurredAt = when it happened). The timeline UI toggles between them.
        "recordedAt": e.recorded_at.isoformat() if e.recorded_at else None,
        "title": e.title,
        "body": e.body,
        "structured": e.structured,
        # curation state (NULL = evolve's uncurated queue) — UI renders pending
        # vs active differently.
        "curatedAt": e.curated_at.isoformat() if e.curated_at else None,
        # reference_count for the detail panel; importance = visual weight
        # (type prior × usage heat) the timeline maps to point size / brightness.
        "referenceCount": e.reference_count,
        "importance": visual_importance(e.event_type, e.reference_count),
    }


@router.get("/stream")
async def stream_events_changed(
    request: Request,
    user: User = Depends(current_user),
) -> StreamingResponse:
    """SSE signal plane: one `{"type":"changed"}` frame per burst of pai_events
    writes for this user (publisher: EventsRepository.append → pg_notify;
    fan-out: EventsChangeListener). Carries no data — the client invalidates its
    events queries and refetches over REST. Quiet periods get `: ping` comments
    every 15s so proxies keep the connection open."""
    listener: EventsChangeListener | None = getattr(request.app.state, "events_listener", None)
    if listener is None:
        raise HTTPException(503, "events stream unavailable (no DB)")

    async def gen() -> AsyncIterator[str]:
        queue = listener.subscribe(user.id)
        try:
            while True:
                try:
                    await asyncio.wait_for(queue.get(), timeout=_PING_SECONDS)
                    yield 'data: {"type":"changed"}\n\n'
                except TimeoutError:
                    yield ": ping\n\n"
        finally:
            listener.unsubscribe(user.id, queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/")
async def list_events(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    event_type: str | None = Query(None, alias="eventType"),
    since: datetime | None = Query(None),
    until: datetime | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    order: str = Query("desc", pattern="^(asc|desc)$"),
):
    """Recent active events (timeline) for the Ambient / Mirror pages.

    `order=asc` + `since` reads nearest-first from the boundary so the limit
    truncates the FAR tail — the upcoming side of the events feed (a calendar
    of recurring instances would otherwise starve out everything near now)."""
    async with user_scoped_tx(pool, user.id) as conn:
        repo = EventsRepository(user.id, conn)
        rows = await repo.search_structured(
            event_type=event_type,
            since=since,
            until=until,
            status="active",
            limit=limit,
            ascending=order == "asc",
        )
    return {"items": [_to_dict(r) for r in rows]}
