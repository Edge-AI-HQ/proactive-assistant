"""Cards native @tool — read recently-generated Intent Cards."""

from __future__ import annotations

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .. import http_client


class CardsRecentInput(BaseModel):
    limit: int = Field(default=20, ge=1, le=100)


@tool("cards_recent", args_schema=CardsRecentInput)
async def cards_recent(limit: int):
    """Recently-generated Intent Cards across the user's pipeline runs.
    Use to avoid pushing duplicates and to surface what the user recently
    saw, dismissed, or acted on."""
    payload = await http_client.get("/api/agent/cards/recent", limit=limit)
    if isinstance(payload, dict) and payload.get("error"):
        return payload
    items = payload.get("items", []) if isinstance(payload, dict) else []
    return [
        {
            "id": c.get("id"),
            "runId": c.get("runId"),
            "goalBasket": c.get("goalBasket"),
            "title": c.get("title"),
            "whyNow": (c.get("whyNow") or "")[:200],
            "createdAt": c.get("createdAt") or c.get("runStartedAt"),
        }
        for c in items
    ]
