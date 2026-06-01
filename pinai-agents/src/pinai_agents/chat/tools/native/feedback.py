"""Feedback native @tool — read recent feedback events.

Read-only here; agent-originated feedback writes go through the SDK or
crystallize/dream agents, not the chat surface.
"""

from __future__ import annotations

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .. import http_client


class FeedbackListInput(BaseModel):
    kind: str | None = Field(
        default=None,
        description="Filter by feedback kind (e.g. 'card_action', 'thumbs').",
    )
    action: str | None = Field(
        default=None,
        description="Filter by action label (e.g. 'dismiss', 'confirm').",
    )
    limit: int = Field(default=30, ge=1, le=100)


@tool("feedback_list", args_schema=FeedbackListInput)
async def feedback_list(kind: str | None, action: str | None, limit: int):
    """Recent feedback events from the user. Use to avoid pushing the
    same kind of card twice / to learn user preferences."""
    payload = await http_client.get(
        "/api/agent/feedback/list",
        kind=kind,
        action=action,
        limit=limit,
    )
    if isinstance(payload, dict) and payload.get("error"):
        return payload
    items = payload.get("items", []) if isinstance(payload, dict) else []
    return [
        {
            "id": f.get("id"),
            "kind": f.get("kind"),
            "action": f.get("action"),
            "intentCardId": f.get("intentCardId"),
            "basket": f.get("basket"),
            "value": f.get("value"),
            "text": (f.get("text") or "")[:200],
            "createdAt": f.get("createdAt"),
        }
        for f in items
    ]
