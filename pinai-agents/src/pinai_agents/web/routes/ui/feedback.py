"""/api/feedback — frontend logs card actions; debug panel reads back.

Frontend POSTs every card action (confirm / dismiss / snooze / modify) to
/api/feedback. The dismissed-card-list endpoint is used by the timeline
to filter out cards the user has already dismissed.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query

from ...auth.deps import User, current_user, get_pool
from ...db.repositories.feedback import FeedbackRepository
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/feedback", tags=["feedback"])


def _to_dict(row) -> dict[str, Any]:
    return {
        "id": row.id, "kind": row.kind, "action": row.action,
        "pushId": row.push_id, "intentCardId": row.intent_card_id,
        "intentKey": row.intent_key, "source": row.source,
        "basket": row.basket, "value": row.value, "text": row.text,
        "metadata": row.metadata,
        "conversationId": row.conversation_id,
        "messageId": row.message_id, "channel": row.channel,
        "createdAt": row.created_at.isoformat(),
    }


@router.post("")
async def post_feedback(
    body: dict,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    kind = body.get("kind")
    if not kind or not isinstance(kind, str):
        return {"received": False, "error": "kind required"}
    async with user_scoped_tx(pool, user.id) as conn:
        repo = FeedbackRepository(user.id, conn)
        row = await repo.log(
            kind=kind,
            action=body.get("action"),
            push_id=body.get("pushId") or body.get("push_id"),
            intent_card_id=body.get("intentCardId") or body.get("intent_card_id"),
            intent_key=body.get("intentKey") or body.get("intent_key"),
            source=body.get("source", "user_direct"),
            basket=body.get("basket"),
            value=body.get("value"),
            text=body.get("text"),
            metadata=body.get("metadata") or {},
            conversation_id=body.get("conversationId") or body.get("conversation_id"),
            message_id=body.get("messageId") or body.get("message_id"),
            channel=body.get("channel"),
        )
    return {"received": True, "id": row.id}


@router.get("")
async def list_feedback(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    kind: str | None = Query(None),
    action: str | None = Query(None),
    since: datetime | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = FeedbackRepository(user.id, conn)
        rows = await repo.list(kind=kind, action=action, since=since, limit=limit)
    return {"items": [_to_dict(r) for r in rows]}


@router.get("/dismissed")
async def list_dismissed(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """Frontend AppShell loads this on mount to filter the NOW feed.
    Wire shape `{ok, dismissedCardIds}` matches what AppShell reads."""
    async with user_scoped_tx(pool, user.id) as conn:
        repo = FeedbackRepository(user.id, conn)
        ids = await repo.list_dismissed_card_ids()
    return {"ok": True, "dismissedCardIds": ids}
