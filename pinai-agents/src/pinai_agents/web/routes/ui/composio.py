"""/api/composio/* — connector OAuth flow (frontend Supabase JWT auth).

Wraps `composio_service` for the user-facing OAuth lifecycle. Composio
is reached via the SDK; per-user separation comes from passing each
user's Supabase UUID (mapped to `pai-{supabase_user_id}`) as the SDK's
`user_id`. See AGENTS.md "用户标识规约".

Frontend flow:
  GET  /status      → has the env-level master key been configured?
  GET  /connections → list ACTIVE connections + user_info
  POST /connect     → kick off OAuth, returns redirectUrl, enqueue onboarding
                      connector.preview in the background
  POST /wait        → poll until ACTIVE (or 120s timeout); enqueue
                      connector.init only when preview is not owning init.
  POST /reconnect   → re-init existing account (Composio re-runs OAuth).
  POST /disconnect  → revoke.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi import status as http_status

from ...auth.deps import User, current_user, get_pool
from ...composio_service import (
    ComposioError,
    _get_connection,
    connect,
    connect_custom,
    delete_label,
    disconnect,
    evict_session,
    fallback_label,
    list_catalog,
    list_connections,
    resolve_and_persist_label,
    wait_active,
)
from ...db.repositories.connector_labels import ConnectorLabelsRepository
from ...db.repositories.scheduled_tasks import (
    enqueue_once,
    requeue_once,
)
from ...db.rls import user_scoped_tx
from ...services import custom_mcp

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/composio", tags=["composio"])


@router.get("/status")
async def composio_status(user: User = Depends(current_user)) -> dict:
    """Reports whether the master Composio API key is configured. The
    SPA gates the connect UX on this."""
    from ....config import get_web_settings  # noqa: PLC0415

    s = get_web_settings()
    if not s.composio_api_key:
        return {"configured": False, "keyPrefix": None}
    return {"configured": True, "keyPrefix": s.composio_api_key[:6] + "…"}


@router.get("/connections")
async def composio_connections(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict:
    try:
        items = await list_connections(user)
    except ComposioError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    # Join cached labels from pai_connector_labels. The eager-resolve at
    # /wait time normally guarantees a row exists; the missing-row branch
    # handles legacy connections (created before migration 040) by firing
    # an inline resolve.
    labels_by_cid: dict[str, str | None] = {}
    raw_info_by_cid: dict[str, dict | None] = {}
    if pool is not None:
        async with user_scoped_tx(pool, user.id) as conn:
            rows = await ConnectorLabelsRepository(user.id, conn).list_for_current_user()
        for r in rows:
            labels_by_cid[r.connected_account_id] = r.label
            raw_info_by_cid[r.connected_account_id] = r.raw_user_info

    out: list[dict] = []
    for c in items:
        cid = c.connected_account_id
        if cid in labels_by_cid:
            label = labels_by_cid[cid] or fallback_label(c.toolkit, cid)
            raw = raw_info_by_cid.get(cid) or c.user_info
        else:
            # Legacy / row missing — resolve inline so the next call is fast.
            # Bounded by `resolve_and_persist_label`'s single SDK roundtrip.
            try:
                resolved = await resolve_and_persist_label(pool, user, cid, c.toolkit)
            except Exception as e:  # noqa: BLE001 — best-effort, must not 502 the list
                logger.warning(
                    "composio: inline label resolve failed user=%s cid=%s: %s",
                    user.id,
                    cid,
                    e,
                )
                resolved = None
            label = resolved or fallback_label(c.toolkit, cid)
            raw = c.user_info
        out.append(
            {
                "toolkit": c.toolkit,
                "status": c.status,
                "connectedAccountId": cid,
                "label": label,
                "userInfo": raw,
            }
        )

    if pool is not None:
        for connector in await custom_mcp.list_custom_mcp_connectors(pool, user.id):
            out.append(custom_mcp.connector_to_connection_payload(connector))

    return {"connections": out}


@router.post("/custom-mcp")
async def composio_custom_mcp_connect(
    body: dict,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict:
    name = str(body.get("name") or "").strip()
    url = str(body.get("url") or "").strip()
    try:
        result = await custom_mcp.create_custom_mcp_connector(
            pool,
            user,
            name=name,
            url=url,
        )
    except custom_mcp.CustomMcpError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e
    return {
        "ok": True,
        "connector": {
            "id": result.connector.id,
            "slug": result.connector.slug,
            "name": result.connector.name,
            "url": result.connector.url,
            "rawSources": result.connector.raw_sources,
        },
        "fetched": result.fetched,
        "rawInserted": result.raw_inserted,
        "evolveTaskId": result.evolve_task_id,
    }


@router.patch("/custom-mcp/{connector_id}")
async def composio_custom_mcp_update(
    connector_id: str,
    body: dict,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict:
    name = str(body.get("name") or "").strip()
    url = str(body.get("url") or "").strip()
    try:
        result = await custom_mcp.update_custom_mcp_connector(
            pool,
            user,
            connector_id,
            name=name,
            url=url,
        )
    except custom_mcp.CustomMcpError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e
    return {
        "ok": True,
        "connector": {
            "id": result.connector.id,
            "slug": result.connector.slug,
            "name": result.connector.name,
            "url": result.connector.url,
            "rawSources": result.connector.raw_sources,
        },
        "fetched": result.fetched,
        "rawInserted": result.raw_inserted,
        "evolveTaskId": result.evolve_task_id,
    }


@router.delete("/custom-mcp/{connector_id}", status_code=http_status.HTTP_204_NO_CONTENT)
async def composio_custom_mcp_delete(
    connector_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> None:
    deleted = await custom_mcp.delete_custom_mcp_connector(pool, user.id, connector_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Custom connector not found")
    await evict_session(user)
    return None


@router.get("/catalog")
async def composio_catalog(
    category: str | None = None,
    query: str | None = None,
    cursor: str | None = None,
    limit: int = 50,
    user: User = Depends(current_user),
) -> dict:
    """Browse Composio's full toolkit directory (paged). Discovery only —
    /connect already accepts any slug."""
    _ = user  # auth gate; catalog content is not user-specific
    try:
        page = await list_catalog(
            category=category,
            query=query,
            cursor=cursor,
            limit=max(1, min(limit, 200)),
        )
    except ComposioError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {
        "items": [i.model_dump() for i in page.items],
        "nextCursor": page.next_cursor,
        "totalCount": page.total_count,
    }


@router.post("/connect")
async def composio_connect(
    body: dict,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict:
    toolkit = str(body.get("toolkit") or "").strip().lower()
    if not toolkit:
        raise HTTPException(status_code=400, detail="Missing toolkit")
    # Optional custom auth: {"authConfig": {"authScheme": "OAUTH2"|"API_KEY"|...,
    # "credentials": {...}}} — user-supplied OAuth client / API key.
    auth_config = body.get("authConfig")
    try:
        if isinstance(auth_config, dict) and auth_config:
            scheme = str(auth_config.get("authScheme") or "").strip()
            credentials = auth_config.get("credentials")
            if not scheme or not isinstance(credentials, dict) or not credentials:
                raise HTTPException(
                    status_code=400,
                    detail="authConfig requires authScheme + credentials",
                )
            init = await connect_custom(
                user,
                toolkit,
                auth_scheme=scheme,
                credentials={str(k): str(v) for k, v in credentials.items()},
            )
        else:
            init = await connect(user, toolkit)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except ComposioError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    if init.connected_account_id and init.toolkit and init.toolkit != "unknown":
        await _enqueue_connector_preview(
            pool,
            user.id,
            init.toolkit,
            init.connected_account_id,
        )
    return {
        "toolkit": init.toolkit,
        "status": init.status,
        "connectedAccountId": init.connected_account_id,
        "redirectUrl": init.redirect_url,
    }


@router.post("/disconnect", status_code=http_status.HTTP_204_NO_CONTENT)
async def composio_disconnect(
    body: dict,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> None:
    cid = str(body.get("connectedAccountId") or "").strip()
    if not cid:
        raise HTTPException(status_code=400, detail="Missing connectedAccountId")
    if cid.startswith("custom_mcp_"):
        if pool is None:
            raise HTTPException(status_code=503, detail="Database unavailable")
        deleted = await custom_mcp.delete_custom_mcp_connector(pool, user.id, cid)
        if not deleted:
            raise HTTPException(status_code=404, detail="Custom connector not found")
        await evict_session(user)
        return None
    try:
        await disconnect(cid)
    except ComposioError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    # Clean up the cached label so the row doesn't outlive the connection.
    if pool is not None:
        try:
            await delete_label(pool, user, cid)
        except Exception as e:  # noqa: BLE001 — best-effort cleanup
            logger.warning(
                "composio: delete label failed user=%s cid=%s: %s",
                user.id,
                cid,
                e,
            )
    # Drop any cached Tool Router session so the next chat call sees the
    # fresh connection state (e.g. user just disconnected one of two
    # accounts on the same toolkit).
    await evict_session(user)
    return None


@router.post("/wait")
async def composio_wait(
    body: dict,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict:
    cid = str(body.get("connectedAccountId") or "").strip()
    if not cid:
        raise HTTPException(status_code=400, detail="Missing connectedAccountId")
    try:
        result = await wait_active(cid)
    except ComposioError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    if result.status != "ACTIVE":
        return {"status": result.status, "connectedAccountId": cid}
    # Newly active — enqueue connector.init backfill task + resolve label.
    toolkit = result.toolkit or str(body.get("toolkit") or "").strip().lower()
    init_task_id = None
    if toolkit and toolkit != "unknown":
        preview_owns_init = await _preview_owns_connector_init(pool, user.id, toolkit, cid)
        if not preview_owns_init:
            init_task_id = await _enqueue_connector_init(pool, user.id, toolkit, cid)
    # Eager label resolution: one extra Composio call here so the
    # subsequent /connections request returns the human label without
    # blocking. Failures get recorded to pai_connector_labels and
    # lazy-retried on the next /connections call.
    if toolkit and toolkit != "unknown" and pool is not None:
        try:
            await resolve_and_persist_label(pool, user, cid, toolkit)
        except Exception as e:  # noqa: BLE001 — label is best-effort, must not break /wait
            logger.warning(
                "composio: eager label resolve failed user=%s cid=%s tk=%s: %s",
                user.id,
                cid,
                toolkit,
                e,
            )
    out: dict = {"status": "ACTIVE", "connectedAccountId": cid}
    if init_task_id:
        out["initTaskId"] = init_task_id
    return out


@router.post("/reconnect")
async def composio_reconnect(
    body: dict,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict:
    cid = str(body.get("connectedAccountId") or "").strip()
    toolkit = str(body.get("toolkit") or "").strip().lower()
    if not cid:
        raise HTTPException(status_code=400, detail="Missing connectedAccountId")
    if not toolkit:
        # Fetch toolkit from Composio if caller didn't provide it.
        try:
            conn = await _get_connection(cid)
        except ComposioError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        toolkit = conn.toolkit
    if not toolkit or toolkit == "unknown":
        raise HTTPException(status_code=400, detail="Could not resolve toolkit")
    init_task_id = await _requeue_connector_init(pool, user.id, toolkit, cid)
    if not init_task_id:
        raise HTTPException(
            status_code=503,
            detail="Scheduler unavailable or enqueue failed",
        )
    # Reconnect can change the identity (rare, e.g. user re-OAuths from a
    # different profile); refresh the label proactively.
    if pool is not None:
        try:
            await resolve_and_persist_label(pool, user, cid, toolkit)
        except Exception as e:  # noqa: BLE001 — best-effort
            logger.warning(
                "composio: label refresh on reconnect failed user=%s cid=%s: %s",
                user.id,
                cid,
                e,
            )
    return {
        "ok": True,
        "toolkit": toolkit,
        "connectedAccountId": cid,
        "initTaskId": init_task_id,
    }


def _init_task_id(toolkit: str, connected_account_id: str) -> str:
    """Stable id for connector.init scheduled tasks. PK on
    (user_id, id) gives idempotency for free — same toolkit+cid maps to
    the same row across retries / duplicate /wait calls."""
    return f"init.{toolkit}.{connected_account_id}"


def _preview_task_id(toolkit: str, connected_account_id: str) -> str:
    """Stable id for the independent onboarding connector.preview task.

    This task can wait for Composio ACTIVE and generate the first summary
    without blocking the user-facing OAuth flow.
    """
    return f"preview.{toolkit}.{connected_account_id}"


async def _enqueue_connector_preview(
    pool,
    user_id: int,
    toolkit: str,
    connected_account_id: str,
) -> str | None:
    if pool is None:
        return None
    task_id = _preview_task_id(toolkit, connected_account_id)
    payload = {
        "toolkit": toolkit,
        "connectedAccountId": connected_account_id,
        "reason": "composio_connect",
        "limit": 50,
    }
    try:
        async with user_scoped_tx(pool, user_id) as conn:
            await enqueue_once(
                conn,
                user_id=user_id,
                task_id=task_id,
                kind="connector.preview",
                payload=payload,
                max_attempts=3,
            )
        return task_id
    except Exception as e:
        logger.warning(
            "composio: enqueue connector.preview failed user=%s tk=%s: %s",
            user_id,
            toolkit,
            e,
        )
        return None


async def _preview_owns_connector_init(
    pool,
    user_id: int,
    toolkit: str,
    connected_account_id: str,
) -> bool:
    """True when connector.preview should enqueue full init after summary."""
    if pool is None:
        return False
    task_id = _preview_task_id(toolkit, connected_account_id)
    try:
        async with user_scoped_tx(pool, user_id) as conn:
            cur = await conn.execute(
                """
                SELECT last_run_status, progress
                FROM pai_scheduled_tasks
                WHERE user_id = %s AND id = %s
                """,
                (user_id, task_id),
            )
            row = await cur.fetchone()
    except Exception as e:
        logger.warning(
            "composio: preview lookup failed user=%s tk=%s: %s",
            user_id,
            toolkit,
            e,
        )
        return False
    if row is None:
        return False
    raw_progress = row.get("progress")
    progress: dict = raw_progress if isinstance(raw_progress, dict) else {}
    if progress.get("reason") == "connection_not_active":
        return False
    return row.get("last_run_status") not in {"failed", "timed_out", "cancelled", "lost"}


async def _enqueue_connector_init(
    pool,
    user_id: int,
    toolkit: str,
    connected_account_id: str,
) -> str | None:
    """Insert a connector.init once-shot task. Returns the task id on
    success, None on failure — failing OAuth over a backend enqueue blip
    would be hostile; reconciler / next /wait still catches it."""
    if pool is None:
        return None
    task_id = _init_task_id(toolkit, connected_account_id)
    payload = {
        "toolkit": toolkit,
        "connectedAccountId": connected_account_id,
        "reason": "composio_wait",
        "limit": 100,
    }
    try:
        async with user_scoped_tx(pool, user_id) as conn:
            await enqueue_once(
                conn,
                user_id=user_id,
                task_id=task_id,
                kind="connector.init",
                payload=payload,
                max_attempts=3,
            )
        return task_id
    except Exception as e:
        logger.warning(
            "composio: enqueue connector.init failed user=%s tk=%s: %s",
            user_id,
            toolkit,
            e,
        )
        return None


async def _requeue_connector_init(
    pool,
    user_id: int,
    toolkit: str,
    connected_account_id: str,
) -> str | None:
    """Reconnect path: atomic INSERT-or-RESET so a prior archived row gets
    reactivated, payload refreshed, attempts zeroed."""
    if pool is None:
        return None
    task_id = _init_task_id(toolkit, connected_account_id)
    payload = {
        "toolkit": toolkit,
        "connectedAccountId": connected_account_id,
        "reason": "composio_reconnect",
        "limit": 100,
    }
    try:
        async with user_scoped_tx(pool, user_id) as conn:
            await requeue_once(
                conn,
                user_id=user_id,
                task_id=task_id,
                kind="connector.init",
                payload=payload,
                max_attempts=3,
            )
        return task_id
    except Exception as e:
        logger.warning(
            "composio: requeue connector.init failed user=%s tk=%s: %s",
            user_id,
            toolkit,
            e,
        )
        return None
