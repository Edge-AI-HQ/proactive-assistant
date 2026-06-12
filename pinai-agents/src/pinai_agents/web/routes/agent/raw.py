"""/api/agent/raw/{toolkit}/{entity} — raw reader over both stores.

Typed toolkits resolve via the _RAW_TABLES allowlist (so callers can't
probe arbitrary table names — defense against a confused-LLM injection
where a tool param ends up in a table name). Every other (toolkit,
entity) pair reads the generic pai_raw_events store, where both values
are SQL parameters, not identifiers. A toolkit's storage is exclusively
one or the other; _RAW_TABLES is the routing truth. Both share the
envelope: id + occurred_at + ingested_at + dedupe_key (+ payload).

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
from ...services import custom_mcp, ingest_runner, raw_sources, recipe_infer

router = APIRouter(prefix="/api/agent/raw", tags=["agent-raw"])


# (toolkit, entity) → physical table name. Only entries listed here are
# readable; everything else 404s. Derived from the raw_sources registry
# (the single source of truth for storage routing) so this allowlist and
# the UI/dashboard enumerations can't drift apart.
_RAW_TABLES: dict[tuple[str, str], str] = raw_sources.typed_path_table_map()

_RAW_CONNECTOR_TOOLKITS: dict[tuple[str, str], str] = raw_sources.typed_path_composio_map()


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
    """Read recent rows for (toolkit, entity). Typed toolkits resolve via
    the _RAW_TABLES allowlist; everything else reads the generic
    pai_raw_events store (toolkit/entity are SQL *parameters* there, so
    arbitrary slugs are safe — unknown pairs just return zero rows).

    Order: occurred_at DESC (most-recent-first). Both branches share the
    user_id + id + occurred_at + ingested_at + dedupe_key envelope.
    """
    key = _raw_key(toolkit, entity)
    table = _RAW_TABLES.get(key)
    # Generic store: the path toolkit IS the composio slug.
    composio_toolkit = _RAW_CONNECTOR_TOOLKITS.get(key) if table is not None else key[0]
    if table is None and await custom_mcp.is_custom_mcp_active(pool, run.user_id, key[0]):
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
    if table is not None:
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
        params: tuple[Any, ...] = (
            run.user_id,
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
            SELECT * FROM pai_raw_events
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
            key[0],
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
