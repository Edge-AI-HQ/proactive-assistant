"""Timeline native @tool wrappers — agent-facing timeline_events queries.

The proactive agent's read surface over `pai_timeline_events` (migration
064). Parallel to — not a replacement for — the `signals_*` / `raw_*`
families the main-chat agent uses; those keep reading
`pai_personal_signals` / `pai_raw_*`. The shape mirrors the SDK surface
in `pinai_sdk._client.Timeline` — same parameters, same return shape,
direct HTTP wrappers around `/api/agent/timeline/*` so a chat agent
running native tool-calls can use them without a sandbox.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .. import http_client


def _iso(dt: datetime) -> str:
    return dt.replace(tzinfo=dt.tzinfo or UTC).isoformat()


class TimelinePastInput(BaseModel):
    hours: int = Field(
        default=24,
        ge=1,
        le=24 * 30,
        description="Look-back window in hours (default 24h).",
    )
    sources: str | None = Field(
        default=None,
        description=(
            "Comma-separated source filter, e.g. 'gmail,gcal,ambient.utterance'. "
            "Omit for all sources."
        ),
    )
    event_types: str | None = Field(
        default=None,
        description=(
            "Comma-separated event_type filter, e.g. 'communication,meeting'. "
            "Vocabulary: communication / meeting / utterance / movement / "
            "state_change / consumption / transaction / commit / health."
        ),
    )
    min_importance: float = Field(default=0.3, ge=0, le=1)
    limit: int = Field(default=80, ge=1, le=2000)


@tool("timeline_past", args_schema=TimelinePastInput)
async def timeline_past(
    hours: int,
    sources: str | None,
    event_types: str | None,
    min_importance: float,
    limit: int,
):
    """Past N hours of curated timeline events. Use for 'what happened
    today / this week / since I last asked' queries. Returns events
    ordered chronologically (oldest → newest)."""
    now = datetime.now(UTC)
    payload = await http_client.get(
        "/api/agent/timeline/query",
        windowStart=_iso(now - timedelta(hours=hours)),
        windowEnd=_iso(now),
        sources=sources,
        eventTypes=event_types,
        minImportance=min_importance,
        limit=limit,
    )
    if isinstance(payload, dict) and payload.get("error"):
        return payload
    return payload.get("items", []) if isinstance(payload, dict) else []


class TimelineFutureInput(BaseModel):
    hours: int = Field(
        default=168,
        ge=1,
        le=24 * 30,
        description="Look-ahead window in hours (default 7 days).",
    )
    sources: str | None = Field(default=None)
    event_types: str | None = Field(default=None)
    min_importance: float = Field(default=0.3, ge=0, le=1)
    include_predicted: bool = Field(
        default=True,
        description=(
            "Default True — LLM-predicted events (`source='predicted.*'`) are "
            "usually what makes the future view useful. Pass False to see only "
            "ground-truth scheduled events (calendar, due dates)."
        ),
    )
    limit: int = Field(default=50, ge=1, le=2000)


@tool("timeline_future", args_schema=TimelineFutureInput)
async def timeline_future(
    hours: int,
    sources: str | None,
    event_types: str | None,
    min_importance: float,
    include_predicted: bool,
    limit: int,
):
    """Upcoming events in the next N hours. Mixes ground-truth (calendar,
    due dates) with LLM-predicted commitments. Use for 'what do I have
    coming up / when's my next X' queries."""
    now = datetime.now(UTC)
    payload = await http_client.get(
        "/api/agent/timeline/query",
        windowStart=_iso(now),
        windowEnd=_iso(now + timedelta(hours=hours)),
        sources=sources,
        eventTypes=event_types,
        minImportance=min_importance,
        includePredicted=include_predicted,
        limit=limit,
    )
    if isinstance(payload, dict) and payload.get("error"):
        return payload
    return payload.get("items", []) if isinstance(payload, dict) else []


class TimelineInProgressInput(BaseModel):
    sources: str | None = Field(default=None)
    limit: int = Field(default=50, ge=1, le=500)


@tool("timeline_in_progress", args_schema=TimelineInProgressInput)
async def timeline_in_progress(sources: str | None, limit: int):
    """Interval events currently in session at this moment — meetings,
    audio capture sessions, visit windows. Use to answer 'what am I
    doing right now' without guessing from past events."""
    payload = await http_client.get(
        "/api/agent/timeline/in_progress",
        sources=sources,
        limit=limit,
    )
    if isinstance(payload, dict) and payload.get("error"):
        return payload
    return payload.get("items", []) if isinstance(payload, dict) else []


class TimelineGetInput(BaseModel):
    id: str = Field(min_length=1)


@tool("timeline_get", args_schema=TimelineGetInput)
async def timeline_get(id: str) -> dict[str, Any]:
    """Fetch one timeline event with full body + metadata. Use when a
    summary from `timeline_past`/`timeline_future` isn't enough and you
    need the raw transcript text, email body, or source_ref."""
    return await http_client.get(f"/api/agent/timeline/get/{id}")


class TimelineHistoryInput(BaseModel):
    id: str = Field(min_length=1, description="Any event id along the chain.")


@tool("timeline_history", args_schema=TimelineHistoryInput)
async def timeline_history(id: str):
    """Walk the supersede chain for an event id — returns all versions
    chronologically, root → current. Use when a meeting/event was
    rescheduled and the user asks 'when was this originally?' or
    'how many times did this slip?'.

    For unversioned events (the common case) this just returns a
    one-element list with the event itself."""
    payload = await http_client.get(f"/api/agent/timeline/history/{id}")
    if isinstance(payload, dict) and payload.get("error"):
        return payload
    return payload.get("items", []) if isinstance(payload, dict) else []
