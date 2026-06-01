"""/api/agent/feedback/* — agent reads recent feedback events.

Used by chat / generator agents to surface recent user reactions
("user dismissed last 3 health cards" → don't push another). Writes
also live here for crystallize / dream agents that want to log
agent-derived feedback signals.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from ...auth.deps import AgentRun, current_agent_run, get_pool
from ...db.repositories.feedback import FeedbackRepository, FeedbackRow
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/agent/feedback", tags=["agent-feedback"])


def _to_dict(row: FeedbackRow) -> dict[str, Any]:
    return {
        "id": row.id,
        "kind": row.kind,
        "action": row.action,
        "intentCardId": row.intent_card_id,
        "intentKey": row.intent_key,
        "source": row.source,
        "basket": row.basket,
        "value": row.value,
        "text": row.text,
        "metadata": row.metadata,
        "channel": row.channel,
        "createdAt": row.created_at.isoformat(),
    }


@router.get("/list")
async def list_feedback(
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
    kind: str | None = Query(None),
    action: str | None = Query(None),
    since: datetime | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
):
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = FeedbackRepository(run.user_id, conn)
        rows = await repo.list(kind=kind, action=action, since=since, limit=limit)
    return {"items": [_to_dict(r) for r in rows]}


@router.post("/log")
async def log_feedback(
    body: dict,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Agent-originated feedback log. `source` defaults to 'agent' so
    these are distinguishable from user-direct feedback in analytics."""
    kind = body.get("kind")
    if not isinstance(kind, str) or not kind:
        raise HTTPException(status_code=400, detail="kind required")
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = FeedbackRepository(run.user_id, conn)
        row = await repo.log(
            kind=kind,
            action=body.get("action"),
            intent_card_id=body.get("intentCardId") or body.get("intent_card_id"),
            intent_key=body.get("intentKey") or body.get("intent_key"),
            source=body.get("source", "agent"),
            basket=body.get("basket"),
            value=body.get("value"),
            text=body.get("text"),
            metadata=body.get("metadata") or {},
            channel=body.get("channel"),
        )
    return _to_dict(row)
