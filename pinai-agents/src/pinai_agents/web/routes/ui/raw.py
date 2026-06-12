"""/api/raw/* — frontend Profile page raw-data reads.

Mirrors the typed shapes the SPA expects (lib/api.ts):

  GET /api/raw/gmail            → {ok, messages, total}
  GET /api/raw/gcal             → {ok, events, total}
  GET /api/raw/device-apps      → {ok, apps, total}
  GET /api/raw/device-contacts  → {ok, contacts, total}
  GET /api/raw/device-health    → {ok, observations, total}
  GET /api/raw/<table>          → {ok, rows, total, table}  (generic fallback)

Distinct from the agent-scoped /api/agent/raw/<toolkit>/<entity> route in
two ways: this one is gated by Supabase JWT (`current_user`), and the
shape is keyed for direct UI consumption (`messages` not `items`) so the
frontend doesn't need a re-mapping layer.

All filters are optional and stack: ?since=ISO ?until=ISO ?limit=N. The
device-apps / device-contacts endpoints additionally accept ?deviceId,
?snapshotId, and ?latestSnapshotOnly=1 (collapses to the most-recent
snapshot per device — matches what the SPA's profile preview wants).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from ...auth.deps import User, current_user, get_pool
from ...db.rls import user_scoped_tx
from ...services import raw_sources

router = APIRouter(prefix="/api/raw", tags=["raw"])

# The /raw/<slug> fallback's accepted slugs + their storage come from the
# raw_sources registry (single source of truth). Frontend `fetchRawTable`
# (proactive-ai-frontend GoalsView RAW_SOURCE_CONFIG) is the naming
# authority for these slugs — keep registry ui_slug values in sync with it.


def _typed_table(toolkit: str, entity: str) -> str:
    """Physical table for a typed source, from the registry — so the
    dedicated endpoints below don't re-hardcode table names that the
    registry already owns."""
    source = raw_sources.by_path(toolkit, entity)
    assert source is not None and source.table is not None, (
        f"not a typed source: {toolkit}/{entity}"
    )
    return source.table


def _row_to_dict(row: dict[str, Any]) -> dict[str, Any]:
    """ISO-format datetime/date columns; pass everything else verbatim."""
    out: dict[str, Any] = {}
    for k, v in row.items():
        if isinstance(v, datetime) or hasattr(v, "isoformat"):
            out[k] = v.isoformat()
        else:
            out[k] = v
    return out


async def _select_recent(
    pool,
    *,
    user_id: int,
    table: str,
    extra_where: str = "",
    extra_params: tuple = (),
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = 50,
) -> tuple[list[dict[str, Any]], int]:
    """Shared SELECT for the typed-raw endpoints. Returns (rows, total)
    where total is the unfiltered-by-limit count for paging hints."""
    sql = f"""
        SELECT * FROM {table}
        WHERE user_id = %s
          AND (%s::timestamptz IS NULL OR occurred_at >= %s)
          AND (%s::timestamptz IS NULL OR occurred_at <= %s)
          {extra_where}
        ORDER BY occurred_at DESC
        LIMIT %s
    """
    count_sql = f"""
        SELECT COUNT(*) AS n FROM {table}
        WHERE user_id = %s
          AND (%s::timestamptz IS NULL OR occurred_at >= %s)
          AND (%s::timestamptz IS NULL OR occurred_at <= %s)
          {extra_where}
    """
    base_params = (user_id, since, since, until, until)
    async with user_scoped_tx(pool, user_id) as conn:
        cur = await conn.execute(sql, base_params + extra_params + (limit,))
        rows = [_row_to_dict(r) for r in await cur.fetchall()]
        cur = await conn.execute(count_sql, base_params + extra_params)
        count_row = await cur.fetchone()
        total = int((count_row or {}).get("n") or 0)
    return rows, total


# ── Typed endpoints ─────────────────────────────────────────────────────


@router.get("/gmail")
async def list_gmail(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    since: datetime | None = Query(None),
    until: datetime | None = Query(None),
    threadId: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
):
    extra_where = ""
    extra_params: tuple = ()
    if threadId:
        extra_where = "AND thread_id = %s"
        extra_params = (threadId,)
    rows, total = await _select_recent(
        pool,
        user_id=user.id,
        table=_typed_table("gmail", "messages"),
        extra_where=extra_where,
        extra_params=extra_params,
        since=since,
        until=until,
        limit=limit,
    )
    return {"ok": True, "messages": rows, "total": total}


@router.get("/gcal")
async def list_gcal(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    since: datetime | None = Query(None),
    until: datetime | None = Query(None),
    calendarId: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
):
    extra_where = ""
    extra_params: tuple = ()
    if calendarId:
        extra_where = "AND calendar_id = %s"
        extra_params = (calendarId,)
    rows, total = await _select_recent(
        pool,
        user_id=user.id,
        table=_typed_table("gcal", "events"),
        extra_where=extra_where,
        extra_params=extra_params,
        since=since,
        until=until,
        limit=limit,
    )
    return {"ok": True, "events": rows, "total": total}


@router.get("/device-apps")
async def list_device_apps(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    since: datetime | None = Query(None),
    until: datetime | None = Query(None),
    deviceId: str | None = Query(None),
    snapshotId: str | None = Query(None),
    latestSnapshotOnly: bool = Query(False),
    limit: int = Query(50, ge=1, le=500),
):
    rows, total = await _device_snapshot_query(
        pool,
        user_id=user.id,
        table=_typed_table("device", "apps"),
        device_id=deviceId,
        snapshot_id=snapshotId,
        latest_only=latestSnapshotOnly,
        since=since,
        until=until,
        limit=limit,
    )
    return {"ok": True, "apps": rows, "total": total}


@router.get("/device-contacts")
async def list_device_contacts(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    since: datetime | None = Query(None),
    until: datetime | None = Query(None),
    deviceId: str | None = Query(None),
    snapshotId: str | None = Query(None),
    latestSnapshotOnly: bool = Query(False),
    search: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
):
    extra_clauses: list[str] = []
    extra_params: list[Any] = []
    if search:
        # Display name OR email match — matches the SPA's contacts search
        # box. Fold case for forgiving UX.
        extra_clauses.append(
            "(display_name ILIKE %s OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(emails) e WHERE e ILIKE %s))",
        )
        like = f"%{search}%"
        extra_params.extend([like, like])
    rows, total = await _device_snapshot_query(
        pool,
        user_id=user.id,
        table=_typed_table("device", "contacts"),
        device_id=deviceId,
        snapshot_id=snapshotId,
        latest_only=latestSnapshotOnly,
        since=since,
        until=until,
        limit=limit,
        extra_where=" ".join(f"AND {c}" for c in extra_clauses),
        extra_params=tuple(extra_params),
    )
    return {"ok": True, "contacts": rows, "total": total}


@router.get("/device-health")
async def list_device_health(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    since: datetime | None = Query(None),
    until: datetime | None = Query(None),
    deviceId: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
):
    extra_where = ""
    extra_params: tuple = ()
    if deviceId:
        extra_where = "AND device_id = %s"
        extra_params = (deviceId,)
    rows, total = await _select_recent(
        pool,
        user_id=user.id,
        table=_typed_table("device", "health"),
        extra_where=extra_where,
        extra_params=extra_params,
        since=since,
        until=until,
        limit=limit,
    )
    return {"ok": True, "observations": rows, "total": total}


async def _device_snapshot_query(
    pool,
    *,
    user_id: int,
    table: str,
    device_id: str | None,
    snapshot_id: str | None,
    latest_only: bool,
    since: datetime | None,
    until: datetime | None,
    limit: int,
    extra_where: str = "",
    extra_params: tuple = (),
) -> tuple[list[dict[str, Any]], int]:
    """Shared filter logic for *_snapshot tables.

    `latest_only=True` collapses to the most recent snapshot per device
    (group by device_id, take max snapshot_id) — that's what the profile
    preview wants. When `snapshot_id` is given explicitly, we use it
    directly and ignore `latest_only`.
    """
    clauses = [extra_where] if extra_where else []
    params: list[Any] = list(extra_params)
    if device_id:
        clauses.append("AND device_id = %s")
        params.append(device_id)
    if snapshot_id:
        clauses.append("AND snapshot_id = %s")
        params.append(snapshot_id)
    elif latest_only:
        # Subquery picks the freshest snapshot per device. We use
        # snapshot_id alphanumerical ordering since that matches how
        # the device ingest path mints them; if that ever drifts we'd
        # want max(occurred_at) instead.
        clauses.append(
            "AND snapshot_id IN ("
            "  SELECT snapshot_id FROM ("
            f"    SELECT DISTINCT ON (device_id) device_id, snapshot_id, occurred_at"
            f"      FROM {table}"
            "      WHERE user_id = %s"
            "      ORDER BY device_id, occurred_at DESC"
            "  ) latest"
            ")",
        )
        params.append(user_id)

    return await _select_recent(
        pool,
        user_id=user_id,
        table=table,
        extra_where=" ".join(clauses),
        extra_params=tuple(params),
        since=since,
        until=until,
        limit=limit,
    )


# ── Generic fallback: /api/raw/<slug> ──────────────────────────────────


@router.get("/{slug}")
async def list_generic(
    slug: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    since: datetime | None = Query(None),
    until: datetime | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
):
    """Generic fallback for connector tables not covered by the typed
    endpoints. Allowlist-gated by slug — physical table is `pai_raw_<slug>`.

    Frontend `fetchRawTable` (GoalsView RAW_SOURCE_CONFIG) calls this
    with the slug only (eg `slack_messages`). Slugs not in the raw_sources
    registry 404. The typed endpoints above (gmail / gcal / device-*) take
    precedence when the path matches — FastAPI matches static routes
    before parametric ones."""
    source = raw_sources.by_ui_slug(slug)
    if source is None:
        raise HTTPException(
            status_code=404,
            detail=f"unknown raw slug: {slug}",
        )
    if source.store == "events":
        async with user_scoped_tx(pool, user.id) as conn:
            cur = await conn.execute(
                """
                SELECT * FROM pai_raw_events
                WHERE user_id = %s
                  AND toolkit = %s
                  AND entity_type = %s
                  AND (%s::timestamptz IS NULL OR occurred_at >= %s)
                  AND (%s::timestamptz IS NULL OR occurred_at <= %s)
                ORDER BY occurred_at DESC
                LIMIT %s
                """,
                (user.id, source.path_toolkit, source.entity, since, since, until, until, limit),
            )
            rows = [_row_to_dict(r) for r in await cur.fetchall()]
            cur = await conn.execute(
                """
                SELECT COUNT(*) AS n FROM pai_raw_events
                WHERE user_id = %s
                  AND toolkit = %s
                  AND entity_type = %s
                  AND (%s::timestamptz IS NULL OR occurred_at >= %s)
                  AND (%s::timestamptz IS NULL OR occurred_at <= %s)
                """,
                (user.id, source.path_toolkit, source.entity, since, since, until, until),
            )
            count_row = await cur.fetchone()
        total = int((count_row or {}).get("n") or 0)
        return {"ok": True, "rows": rows, "total": total, "table": "pai_raw_events"}

    assert source.table is not None  # typed store always has a table
    rows, total = await _select_recent(
        pool,
        user_id=user.id,
        table=source.table,
        since=since,
        until=until,
        limit=limit,
    )
    return {"ok": True, "rows": rows, "total": total, "table": source.table}
