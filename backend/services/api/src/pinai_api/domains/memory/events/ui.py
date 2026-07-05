"""UI-facing L1 event timeline read — Ambient / Mirror render the activity stream.

/api/events — Supabase JWT (current_user), under user_scoped_tx (RLS).
Read-only timeline: active events, optional eventType / since / until / limit.
The agent-facing semantic search + append live in events_agent.py.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from pinai_db.rls import user_scoped_tx

from ....platform.auth.deps import current_user, get_pool
from ....platform.auth.user_service import User
from .repository import EventRow, EventsRepository, visual_importance

router = APIRouter(prefix="/api/events", tags=["events"])


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


@router.get("/")
async def list_events(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    event_type: str | None = Query(None, alias="eventType"),
    since: datetime | None = Query(None),
    until: datetime | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
):
    """Recent active events (timeline) for the Ambient / Mirror pages."""
    async with user_scoped_tx(pool, user.id) as conn:
        repo = EventsRepository(user.id, conn)
        rows = await repo.search_structured(
            event_type=event_type,
            since=since,
            until=until,
            status="active",
            limit=limit,
        )
    return {"items": [_to_dict(r) for r in rows]}
