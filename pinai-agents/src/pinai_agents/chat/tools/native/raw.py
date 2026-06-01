"""Raw connector data native @tools.

Two patterns:

1. Specific high-frequency wrappers (`raw_gmail_recent`, `raw_gcal_today`,
   `raw_gcal_week`) — well-named for the LLM, default time windows tuned
   to common chat questions.
2. Generic `raw_list(toolkit, entity)` — covers the long tail
   (slack / gdrive / github / device / etc.). Server-side allowlist in
   `web/routes/agent/raw.py:_RAW_TABLES` is the source of truth for
   valid (toolkit, entity) pairs.

Wire detail: backend `/api/agent/raw/{toolkit}/{entity}` accepts `since`
(ISO-8601 datetime), not `hours` — wrappers convert before sending.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .. import http_client


def _since_from_hours(hours: int | None) -> str | None:
    if hours is None:
        return None
    return (datetime.now(UTC) - timedelta(hours=hours)).isoformat()


class RawListInput(BaseModel):
    hours: int = Field(default=24, ge=1, le=336)
    limit: int = Field(default=20, ge=1, le=10_000)


@tool("raw_gmail_recent", args_schema=RawListInput)
async def raw_gmail_recent(hours: int, limit: int):
    """Recent Gmail messages from the user's connected account. Use for
    'check my email' / 'any updates from X' questions."""
    return await http_client.get(
        "/api/agent/raw/gmail/messages",
        since=_since_from_hours(hours),
        limit=limit,
    )


@tool("raw_gcal_today", args_schema=RawListInput)
async def raw_gcal_today(hours: int, limit: int):
    """User's calendar events from the last `hours` (default 24).
    For 'what's on my calendar today' / 'when am I free now' questions."""
    return await http_client.get(
        "/api/agent/raw/gcal/events",
        since=_since_from_hours(hours),
        limit=limit,
    )


class RawGcalWeekInput(BaseModel):
    hours: int = Field(default=168, ge=1, le=336)
    limit: int = Field(default=50, ge=1, le=10_000)


@tool("raw_gcal_week", args_schema=RawGcalWeekInput)
async def raw_gcal_week(hours: int, limit: int):
    """User's calendar events from the past week (default 168 h).
    For 'what's my schedule this week' / weekly-review questions."""
    return await http_client.get(
        "/api/agent/raw/gcal/events",
        since=_since_from_hours(hours),
        limit=limit,
    )


# Allowlist mirrors `web/routes/agent/raw.py:_RAW_TABLES`. Listed in the
# tool description so the LLM knows what's valid; server still 404s on
# invalid pairs as the real gate.
_RAW_VALID_PAIRS = (
    "gmail/messages, gcal/events, gdrive/files, slack/messages, "
    "github/issues, calendly/events, stripe/invoices, "
    "youtube/subscriptions, linkedin/profile, "
    "device/apps, device/contacts, device/health"
)


class RawListGenericInput(BaseModel):
    toolkit: str = Field(
        min_length=1,
        max_length=40,
        description=(
            "Connector toolkit (e.g. 'slack', 'gdrive', 'github', "
            "'calendly'). See description for valid pairs."
        ),
    )
    entity: str = Field(
        min_length=1,
        max_length=40,
        description="Entity within the toolkit (e.g. 'messages', 'pages', 'issues').",
    )
    hours: int | None = Field(default=72, ge=1, le=336)
    limit: int = Field(default=20, ge=1, le=10_000)


_RAW_LIST_DESCRIPTION = (
    "Generic raw-data fetch for the long-tail connectors that don't have "
    "a dedicated tool. Valid (toolkit, entity) pairs: "
    f"{_RAW_VALID_PAIRS}. Order: most-recent occurred_at first. Use this "
    "when the user asks about Slack / Notion / Drive / GitHub / Outlook "
    "/ device data."
)


@tool("raw_list", args_schema=RawListGenericInput, description=_RAW_LIST_DESCRIPTION)
async def raw_list(toolkit: str, entity: str, hours: int | None, limit: int):
    return await http_client.get(
        f"/api/agent/raw/{toolkit}/{entity}",
        since=_since_from_hours(hours),
        limit=limit,
    )
