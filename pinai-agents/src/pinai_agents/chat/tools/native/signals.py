"""Signals native @tool wrappers."""

from __future__ import annotations

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .. import http_client


class SignalsRecentInput(BaseModel):
    status: str = Field(
        default="open", pattern="^(open|consumed|archived|all)$",
        description="open=fresh signals not yet consumed. Most chat queries want open.",
    )
    kind: str | None = Field(default=None,
        description="Filter by signal kind (e.g. 'gmail.message', 'gcal.event').")
    hours: int | None = Field(default=24, ge=1, le=336,
        description="Look-back window in hours. None = no time bound.")
    limit: int = Field(default=20, ge=1, le=100)


@tool("signals_recent", args_schema=SignalsRecentInput)
async def signals_recent(status: str, kind: str | None, hours: int | None, limit: int):
    """Recent personal signals (the increment layer). Use to answer
    'what happened lately' or 'anything new from <connector>'."""
    payload = await http_client.get(
        "/api/agent/signals/recent",
        status=status, kind=kind, hours=hours, limit=limit,
    )
    if isinstance(payload, dict) and payload.get("error"):
        return payload
    items = payload.get("items", []) if isinstance(payload, dict) else []
    return [
        {
            "id": s["id"],
            "kind": s.get("kind"),
            "title": s.get("title"),
            "summary": (s.get("summary") or "")[:200],
            "salience": s.get("salience"),
            "occurredAt": s.get("occurredAt"),
        }
        for s in items
    ]


class SignalsGetInput(BaseModel):
    id: str = Field(min_length=1)


@tool("signals_get", args_schema=SignalsGetInput)
async def signals_get(id: str):
    """Fetch one signal's full payload by id. Use when `signals_recent`
    summary isn't enough and you need the raw event detail."""
    return await http_client.get(f"/api/agent/signals/get/{id}")
