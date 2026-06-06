"""/api/agent/raw/{toolkit}/{entity} — generic typed-raw reader.

Server-side allowlist gates the (toolkit, entity) → table mapping so
callers can't probe arbitrary table names (defense against a confused-
LLM injection where a tool param ends up in a table name). Each table
has the same shared envelope: id + occurred_at + ingested_at +
dedupe_key + payload columns; reader returns rows verbatim.

Filters: ?since=<iso> ?until=<iso> ?limit=N ?offset=N.
Optional ?dedupeKey=<exact>.
Order: occurred_at DESC.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from ... import composio_service as cs
from ...auth.deps import AgentRun, current_agent_run, get_pool
from ...auth.user_service import load_user_by_id
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/agent/raw", tags=["agent-raw"])


# (toolkit, entity) → physical table name. Only entries listed here are
# readable; everything else 404s. Sourced from db/migrations/016-019 +
# trimmed by 036 / 045 to the live toolkit set.
_RAW_TABLES: dict[tuple[str, str], str] = {
    # Composio toolkits
    ("gmail", "messages"): "pai_raw_gmail_messages",
    ("gcal", "events"): "pai_raw_gcal_events",
    ("gdrive", "files"): "pai_raw_gdrive_files",
    ("slack", "messages"): "pai_raw_slack_messages",
    ("github", "issues"): "pai_raw_github_issues",
    ("calendly", "events"): "pai_raw_calendly_events",
    ("stripe", "invoices"): "pai_raw_stripe_invoices",
    ("youtube", "subscriptions"): "pai_raw_youtube_subscriptions",
    ("linkedin", "profile"): "pai_raw_linkedin_profile",
    # Device (mobile sync)
    ("device", "apps"): "pai_raw_device_apps_snapshot",
    ("device", "contacts"): "pai_raw_device_contacts_snapshot",
    ("device", "health"): "pai_raw_device_health_observations",
}

_RAW_CONNECTOR_TOOLKITS: dict[tuple[str, str], str] = {
    ("gmail", "messages"): "gmail",
    ("gcal", "events"): "googlecalendar",
    ("gdrive", "files"): "googledrive",
    ("slack", "messages"): "slack",
    ("github", "issues"): "github",
    ("calendly", "events"): "calendly",
    ("stripe", "invoices"): "stripe",
    ("youtube", "subscriptions"): "youtube",
    ("linkedin", "profile"): "linkedin",
}


def _table_for(toolkit: str, entity: str) -> str:
    key = (toolkit.strip().lower(), entity.strip().lower())
    table = _RAW_TABLES.get(key)
    if table is None:
        raise HTTPException(
            status_code=404,
            detail=f"unknown raw source: {toolkit}/{entity}",
        )
    return table


def _raw_key(toolkit: str, entity: str) -> tuple[str, str]:
    return (toolkit.strip().lower(), entity.strip().lower())


async def _active_connector_toolkit(
    pool,
    user_id: int,
    composio_toolkit: str,
) -> bool | None:
    user = await load_user_by_id(pool, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail=f"user {user_id} not found")
    try:
        connections = await asyncio.wait_for(cs.list_connections(user), timeout=3.0)
    except (TimeoutError, cs.ComposioError):
        return None
    return any(c.toolkit == composio_toolkit and c.status == "ACTIVE" for c in connections)


def _connector_required_response(
    *,
    toolkit: str,
    entity: str,
    composio_toolkit: str,
    limit: int,
    offset: int,
) -> dict[str, Any]:
    return {
        "toolkit": toolkit,
        "entity": entity,
        "limit": limit,
        "offset": offset,
        "items": [],
        "connectionRequired": True,
        "connectorToolkit": composio_toolkit,
        "nextTool": "COMPOSIO_MANAGE_CONNECTIONS",
        "message": (
            f"{composio_toolkit} is not connected. Ask the user to connect "
            "the data connector before answering from this source."
        ),
    }


@router.get("/{toolkit}/{entity}")
async def list_raw(
    toolkit: str,
    entity: str,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
    since: datetime | None = Query(None),
    until: datetime | None = Query(None),
    limit: int = Query(50, ge=1, le=10_000),
    offset: int = Query(0, ge=0),
    dedupe_key: str | None = Query(None, alias="dedupeKey"),
):
    """Read recent rows from the typed raw table for (toolkit, entity).

    Order: occurred_at DESC (most-recent-first). All raw tables share
    user_id + id + occurred_at + ingested_at + dedupe_key columns, so
    one SELECT covers every entry in the allowlist.
    """
    key = _raw_key(toolkit, entity)
    table = _table_for(toolkit, entity)
    composio_toolkit = _RAW_CONNECTOR_TOOLKITS.get(key)
    connector_active = (
        await _active_connector_toolkit(pool, run.user_id, composio_toolkit)
        if composio_toolkit
        else None
    )
    if composio_toolkit and connector_active is False:
        return _connector_required_response(
            toolkit=toolkit,
            entity=entity,
            composio_toolkit=composio_toolkit,
            limit=limit,
            offset=offset,
        )
    # Table name comes from a static allowlist; safe to format into SQL.
    sql = f"""
        SELECT * FROM {table}
        WHERE user_id = %s
          AND (%s::timestamptz IS NULL OR occurred_at >= %s)
          AND (%s::timestamptz IS NULL OR occurred_at <= %s)
          AND (%s::text IS NULL OR dedupe_key = %s)
        ORDER BY occurred_at DESC
        LIMIT %s OFFSET %s
    """
    async with user_scoped_tx(pool, run.user_id) as conn:
        cur = await conn.execute(
            sql,
            (
                run.user_id,
                since,
                since,
                until,
                until,
                dedupe_key,
                dedupe_key,
                limit,
                offset,
            ),
        )
        rows = await cur.fetchall()
    return {
        "toolkit": toolkit,
        "entity": entity,
        "limit": limit,
        "offset": offset,
        "items": [_row_to_dict(r) for r in rows],
    }


def _row_to_dict(row: dict[str, Any]) -> dict[str, Any]:
    """ISO-format any datetime columns; pass everything else verbatim."""
    out: dict[str, Any] = {}
    for k, v in row.items():
        if isinstance(v, datetime):
            out[k] = v.isoformat()
        else:
            out[k] = v
    return out
