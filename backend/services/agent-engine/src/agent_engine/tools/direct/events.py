"""Event-stream native @tool wrappers — chat agent uses these.

Thin shells around api /api/agent/events/*. `events_search` is the L1 retrieval
surface (supersedes memory_search / signals_recent / raw reads); `event_append`
records an event the user just surfaced. Descriptions are LLM-facing — keep them
action-oriented (verb + when to use).
"""

from __future__ import annotations

from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .. import http_client


class EventsSearchInput(BaseModel):
    query: str | None = Field(
        default=None,
        max_length=500,
        description=(
            "Natural-language query for semantic search. Omit to get the most "
            "recent events (optionally filtered by type)."
        ),
    )
    event_type: str | None = Field(
        default=None,
        max_length=64,
        description=(
            "Filter by type: communication / meeting / transaction / movement / "
            "interaction / utterance / preference. Omit for all types."
        ),
    )
    since: str | None = Field(
        default=None,
        max_length=40,
        description=(
            "ISO-8601 lower bound on when events occurred. Combine with `until` "
            "for a window — e.g. meetings in the next 7 days: since=now, "
            "until=now+7d (occurred_at covers FUTURE events too)."
        ),
    )
    until: str | None = Field(
        default=None,
        max_length=40,
        description="ISO-8601 upper bound on when events occurred.",
    )
    limit: int = Field(
        default=20, ge=1, le=50, description="Max results. Keep small to save context."
    )


@tool("events_search", args_schema=EventsSearchInput)
async def events_search(
    query: str | None,
    event_type: str | None,
    since: str | None,
    until: str | None,
    limit: int,
):
    """Search the user's event stream — their emails / meetings / messages /
    transactions / activity, plus anything you've recorded. With a query it's
    semantic; without one it returns the most recent events. `since`/`until`
    bound WHEN things occurred (works with or without a query; occurred_at
    covers future events, so "next 7 days" is a since/until window). This is
    your primary window into what's happening in the user's life."""
    payload = await http_client.get(
        "/api/agent/events/search",
        q=query,
        eventType=event_type,
        since=since,
        until=until,
        limit=limit,
    )
    if isinstance(payload, dict) and payload.get("error"):
        return payload
    items = payload.get("items", []) if isinstance(payload, dict) else []
    return [
        {
            "id": e["id"],
            "eventType": e.get("eventType"),
            "occurredAt": e.get("occurredAt"),
            "title": e.get("title"),
            "body": (e.get("body") or "")[:200],
            # True → event_source(id) can pull the verbatim L0 content (email
            # body, calendar item, news article). Saves the agent a blind call.
            "hasSource": bool(e.get("sourceRef")),
        }
        for e in items
    ]


class EventAppendInput(BaseModel):
    event_type: str = Field(
        max_length=64,
        description="Event type: preference / interaction / communication / meeting / etc.",
    )
    title: str = Field(min_length=1, max_length=300, description="Short title for the event.")
    body: str | None = Field(default=None, max_length=2000, description="Optional detail.")
    occurred_at: str | None = Field(
        default=None,
        description="ISO-8601 timestamp of when it happened. Omit for now.",
    )
    structured: dict[str, Any] | None = Field(
        default=None,
        description=(
            "Typed fields for this event_type. For event_type='preference' (a "
            "standing preference the user stated — 'always be concise', 'stop "
            "surfacing crypto'), set {polarity: 'positive'|'negative', weight: "
            "0.0-1.0, scope: 'topic'|'source'|'timing'|'format'|'global'}. Omit "
            "for plain timeline events."
        ),
    )


@tool("event_append", args_schema=EventAppendInput)
async def event_append(
    event_type: str,
    title: str,
    body: str | None,
    occurred_at: str | None,
    structured: dict[str, Any] | None,
):
    """Record an event the user just surfaced — a stated preference, a plan, or
    something that happened worth keeping in their timeline. For a standing
    preference set event_type='preference' + structured{polarity,weight,scope}.
    Don't record transient chatter; only durable, timeline-worthy events."""
    return await http_client.post(
        "/api/agent/events/append",
        {
            "source": "pinai_chat",
            "eventType": event_type,
            "title": title,
            "body": body,
            "occurredAt": occurred_at,
            "structured": structured,
        },
    )


class EventSourceInput(BaseModel):
    event_id: str = Field(
        min_length=1,
        max_length=128,
        description="The event id (from events_search) whose original content you need.",
    )


@tool("event_source", args_schema=EventSourceInput)
async def event_source(event_id: str):
    """Pull the VERBATIM original content behind an event — the full email /
    calendar item / news article the event was projected from. Use after
    events_search when the 200-char snippet isn't enough (user asks "what did
    that email actually say?"). Only events with hasSource=true have content;
    superseded events resolve to their current revision automatically (check
    `status` — e.g. "cancelled" — and `revisionNote` in the reply)."""
    return await http_client.get(f"/api/agent/events/{event_id}/source")
