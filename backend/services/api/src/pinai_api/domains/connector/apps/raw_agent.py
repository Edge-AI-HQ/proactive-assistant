"""/api/agent/raw/{toolkit}/{entity} — one raw reader, routed by domain.

This is the single retrieval interface over L0 (doc §62 原则 7); storage is split
by domain (doc §三): toolkit='device' reads pai_raw_device (kind discriminator),
every other source reads pai_raw_apps (toolkit + entity_type). toolkit/entity are
SQL *parameters* (not identifiers) — arbitrary slugs are safe, an unknown pair
just returns zero rows, and a confused-LLM tool param can never become a table
name. Envelope: id + occurred_at + ingested_at + dedupe_key (+ payload).

Filters: ?since=<iso> ?until=<iso> ?limit=N ?offset=N.
Optional ?dedupeKey=<exact>.
Order: occurred_at DESC.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pinai_db.rls import user_scoped_tx

from ....platform.auth.deps import AgentRun, current_agent_run, get_pool
from ....platform.auth.user_service import load_user_by_id
from . import composio_service as cs
from . import custom_mcp, ingest_runner, raw_sources, recipe_infer

router = APIRouter(prefix="/api/agent/raw", tags=["agent-raw"])


# (path_toolkit, entity) → Composio slug for the known sources, for the
# connection-active check. Derived from the raw_sources registry (the single
# source of truth) so this and the UI/dashboard enumerations can't drift apart.
# No table-name map: domain picks the table (pai_raw_apps / pai_raw_device),
# toolkit/entity stay SQL params.
_RAW_CONNECTOR_TOOLKITS: dict[tuple[str, str], str] = raw_sources.path_composio_map()


def _raw_key(toolkit: str, entity: str) -> tuple[str, str]:
    return (toolkit.strip().lower(), entity.strip().lower())


def _connector_toolkit_covers(connection_toolkit: str, target_toolkit: str) -> bool:
    connection = connection_toolkit.strip().lower()
    target = target_toolkit.strip().lower()
    if connection == target:
        return True
    recipe = ingest_runner.load_recipe(connection) or recipe_infer.cached_recipe(connection)
    return bool(recipe and target in recipe.fanout)


def raw_sources_for_composio_toolkit(slug: str) -> list[tuple[str, str]]:
    """(path_toolkit, entity) pairs a connection's data is readable under;
    empty when the toolkit has no ingest (connect_only / no recipe).
    Typed toolkits resolve through the alias map (gmail → gmail/messages,
    googlecalendar → gcal/events); generic ones come from the recipe's
    entity_type; fanout recipes (googlesuper) expand to their
    sub-toolkits' sources. Used to enrich /connections so the chat
    process can discover raw sources without importing web internals."""
    slug = slug.strip().lower()
    for key, composio_toolkit in _RAW_CONNECTOR_TOOLKITS.items():
        if composio_toolkit == slug:
            return [key]
    recipe = ingest_runner.load_recipe(slug) or recipe_infer.cached_recipe(slug)
    if recipe is None or not recipe.is_ingestable():
        return []
    if recipe.fanout:
        out: list[tuple[str, str]] = []
        for sub in recipe.fanout:
            for source in raw_sources_for_composio_toolkit(sub):
                if source not in out:
                    out.append(source)
        return out
    return [(slug, recipe.entity_type or "items")]


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
    return any(
        c.status == "ACTIVE" and _connector_toolkit_covers(c.toolkit, composio_toolkit)
        for c in connections
    )


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
    """Read recent rows for (toolkit, entity), routed to the source's L0 domain
    table. toolkit/entity are SQL *parameters* (not identifiers), so arbitrary
    slugs are safe — unknown pairs just return zero rows.

    Routing (doc §62 原则 7 — one retrieval interface, storage split by domain):
    toolkit='device' (or a registered device source) reads pai_raw_device by
    kind=entity; every other source reads pai_raw_apps by toolkit(slug) +
    entity_type.

    Order: occurred_at DESC (most-recent-first). Envelope:
    user_id + id + occurred_at + ingested_at + dedupe_key (+ payload).
    """
    key = _raw_key(toolkit, entity)
    source = raw_sources.by_path(toolkit, entity)
    # Domain routes the read: device → pai_raw_device (kind discriminator, no
    # Composio connection behind it); apps → pai_raw_apps (Composio slug +
    # entity_type; short path aliases gcal→googlecalendar resolve via the
    # registry). A registered source carries its domain; a dynamic long-tail
    # (custom MCP / inferred) is apps unless the path toolkit is literally
    # 'device'. composio_toolkit drives the connection check, None for device.
    if source is not None:
        is_device = source.domain == "device"
        stored_toolkit = source.composio_toolkit or source.path_toolkit
        composio_toolkit = source.composio_toolkit
    else:
        is_device = key[0] == "device"
        stored_toolkit = key[0]
        composio_toolkit = None if is_device else key[0]
    if (
        source is None
        and not is_device
        and await custom_mcp.is_custom_mcp_active(pool, run.user_id, key[0])
    ):
        connector_active: bool | None = True
    else:
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
    # Route to the domain table. Discriminator values are SQL params — arbitrary
    # slugs are safe, unknown pairs just return zero rows. Shared envelope: id +
    # occurred_at + ingested_at + dedupe_key (+ payload).
    if is_device:
        sql = """
            SELECT * FROM pai_raw_device
            WHERE user_id = %s
              AND kind = %s
              AND (%s::timestamptz IS NULL OR occurred_at >= %s)
              AND (%s::timestamptz IS NULL OR occurred_at <= %s)
              AND (%s::text IS NULL OR dedupe_key = %s)
            ORDER BY occurred_at DESC
            LIMIT %s OFFSET %s
        """
        params: tuple[Any, ...] = (
            run.user_id,
            key[1],
            since,
            since,
            until,
            until,
            dedupe_key,
            dedupe_key,
            limit,
            offset,
        )
    else:
        sql = """
            SELECT * FROM pai_raw_apps
            WHERE user_id = %s
              AND toolkit = %s
              AND entity_type = %s
              AND (%s::timestamptz IS NULL OR occurred_at >= %s)
              AND (%s::timestamptz IS NULL OR occurred_at <= %s)
              AND (%s::text IS NULL OR dedupe_key = %s)
            ORDER BY occurred_at DESC
            LIMIT %s OFFSET %s
        """
        params = (
            run.user_id,
            stored_toolkit,
            key[1],
            since,
            since,
            until,
            until,
            dedupe_key,
            dedupe_key,
            limit,
            offset,
        )
    async with user_scoped_tx(pool, run.user_id) as conn:
        cur = await conn.execute(sql, params)
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
