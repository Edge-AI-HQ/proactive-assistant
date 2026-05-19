"""Signals native @tool wrappers."""

from __future__ import annotations

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .. import http_client


class SignalsKindsInput(BaseModel):
    status: str = Field(
        default="all", pattern="^(open|consumed|archived|all)$",
        description="Default 'all' so already-consumed kinds still show up.",
    )
    hours: int | None = Field(
        default=None, ge=1, le=336,
        description="Look-back window in hours. None = all time (the discovery default).",
    )


@tool("signals_kinds", args_schema=SignalsKindsInput)
async def signals_kinds(status: str, hours: int | None):
    """Discover what kinds of personal signals this user has — count + a short
    preview of the most recent row per `kind`, ordered by latest_at DESC.

    Call this when you're not sure which `kind` to pass to `signals_recent` —
    the example slugs in that tool's description ('gmail.message',
    'gcal.event') are not exhaustive; new sources (e.g. device ambient
    transcripts, world signals, ingest connectors) show up here as soon as
    they ingest. After picking a kind, drill in with
    `signals_recent(kind=<picked>)`."""
    payload = await http_client.get(
        "/api/agent/signals/kinds", status=status, hours=hours,
    )
    if isinstance(payload, dict) and payload.get("error"):
        return payload
    return payload.get("items", []) if isinstance(payload, dict) else []


class SignalsRecentInput(BaseModel):
    status: str = Field(
        default="open", pattern="^(open|consumed|archived|all)$",
        description="open=fresh signals not yet consumed. Most chat queries want open.",
    )
    kind: str | None = Field(
        default=None,
        description=(
            "Filter by signal kind (e.g. 'gmail.message', 'gcal.event', "
            "'ambient.candidate_window'). The full list of kinds the current "
            "user has is NOT fixed — call `signals_kinds` first when unsure."
        ),
    )
    hours: int | None = Field(default=24, ge=1, le=336,
        description="Look-back window in hours. None = no time bound.")
    limit: int = Field(default=20, ge=1, le=10_000)


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
