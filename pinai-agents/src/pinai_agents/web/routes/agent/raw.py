"""/api/agent/raw/{toolkit}/{entity} — generic typed-raw reader.

Server-side allowlist gates the (toolkit, entity) → table mapping so
callers can't probe arbitrary table names (defense against a confused-
LLM injection where a tool param ends up in a table name). Each table
has the same shared envelope: id + occurred_at + ingested_at +
dedupe_key + payload columns; reader returns rows verbatim.

Filters: ?since=<iso> ?until=<iso> ?limit=N. Optional ?dedupeKey=<exact>.
Order: occurred_at DESC.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from ...auth.deps import AgentRun, current_agent_run, get_pool
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/agent/raw", tags=["agent-raw"])


# (toolkit, entity) → physical table name. Only entries listed here are
# readable; everything else 404s. Sourced from db/migrations/016-019.
_RAW_TABLES: dict[tuple[str, str], str] = {
    # Workspace
    ("gmail", "messages"): "pai_raw_gmail_messages",
    ("gcal", "events"): "pai_raw_gcal_events",
    ("gdrive", "files"): "pai_raw_gdrive_files",
    ("gdocs", "documents"): "pai_raw_gdocs_documents",
    ("gsheets", "spreadsheets"): "pai_raw_gsheets_spreadsheets",
    ("outlook", "messages"): "pai_raw_outlook_messages",
    ("dropbox", "account"): "pai_raw_dropbox_account",
    ("dropbox", "files"): "pai_raw_dropbox_files",
    # Collab
    ("slack", "messages"): "pai_raw_slack_messages",
    ("notion", "pages"): "pai_raw_notion_pages",
    ("discord", "guilds"): "pai_raw_discord_guilds",
    ("github", "issues"): "pai_raw_github_issues",
    ("jira", "projects"): "pai_raw_jira_projects",
    ("asana", "workspaces"): "pai_raw_asana_workspaces",
    ("asana", "tasks"): "pai_raw_asana_tasks",
    ("trello", "boards"): "pai_raw_trello_boards",
    ("clickup", "user"): "pai_raw_clickup_user",
    ("clickup", "workspaces"): "pai_raw_clickup_workspaces",
    ("figma", "user"): "pai_raw_figma_user",
    ("hubspot", "contacts"): "pai_raw_hubspot_contacts",
    ("linkedin", "profile"): "pai_raw_linkedin_profile",
    ("linkedin", "organizations"): "pai_raw_linkedin_organizations",
    # Personal
    ("calendly", "events"): "pai_raw_calendly_events",
    ("spotify", "recent_tracks"): "pai_raw_spotify_recent_tracks",
    ("strava", "activities"): "pai_raw_strava_activities",
    ("stripe", "invoices"): "pai_raw_stripe_invoices",
    ("todoist", "tasks"): "pai_raw_todoist_tasks",
    # Device
    ("device", "apps"): "pai_raw_device_apps_snapshot",
    ("device", "contacts"): "pai_raw_device_contacts_snapshot",
    ("device", "health"): "pai_raw_device_health_observations",
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


@router.get("/{toolkit}/{entity}")
async def list_raw(
    toolkit: str,
    entity: str,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
    since: datetime | None = Query(None),
    until: datetime | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
    dedupe_key: str | None = Query(None, alias="dedupeKey"),
):
    """Read recent rows from the typed raw table for (toolkit, entity).

    Order: occurred_at DESC (most-recent-first). All raw tables share
    user_id + id + occurred_at + ingested_at + dedupe_key columns, so
    one SELECT covers every entry in the allowlist.
    """
    table = _table_for(toolkit, entity)
    # Table name comes from a static allowlist; safe to format into SQL.
    sql = f"""
        SELECT * FROM {table}
        WHERE user_id = %s
          AND (%s::timestamptz IS NULL OR occurred_at >= %s)
          AND (%s::timestamptz IS NULL OR occurred_at <= %s)
          AND (%s::text IS NULL OR dedupe_key = %s)
        ORDER BY occurred_at DESC
        LIMIT %s
    """
    async with user_scoped_tx(pool, run.user_id) as conn:
        cur = await conn.execute(
            sql,
            (
                run.user_id,
                since, since,
                until, until,
                dedupe_key, dedupe_key,
                limit,
            ),
        )
        rows = await cur.fetchall()
    return {
        "toolkit": toolkit, "entity": entity,
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
