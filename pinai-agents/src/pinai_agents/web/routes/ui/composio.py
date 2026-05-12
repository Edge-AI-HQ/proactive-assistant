"""/api/composio/* — connector OAuth flow (frontend Supabase JWT auth).

Wraps `composio_service` for the user-facing OAuth lifecycle. Composio
is reached via the SDK; per-user separation comes from passing each
user's internal id (mapped to `pai-{id}`) as the SDK's `user_id`.

Frontend flow:
  GET  /status      → has the env-level master key been configured?
  GET  /connections → list ACTIVE connections + user_info
  POST /connect     → kick off OAuth, returns redirectUrl
  POST /wait        → poll until ACTIVE (or 120s timeout); enqueue
                      connector.init when newly active so we backfill.
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
    delete_label,
    disconnect,
    evict_session,
    fallback_label,
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
    user: User = Depends(current_user), pool=Depends(get_pool),
) -> dict:
    try:
        items = await list_connections(user.id)
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
                resolved = await resolve_and_persist_label(pool, user.id, cid, c.toolkit)
            except Exception as e:  # noqa: BLE001 — best-effort, must not 502 the list
                logger.warning(
                    "composio: inline label resolve failed user=%s cid=%s: %s",
                    user.id, cid, e,
                )
                resolved = None
            label = resolved or fallback_label(c.toolkit, cid)
            raw = c.user_info
        out.append({
            "toolkit": c.toolkit,
            "status": c.status,
            "connectedAccountId": cid,
            "label": label,
            "userInfo": raw,
        })

    return {"connections": out}


@router.post("/connect")
async def composio_connect(body: dict, user: User = Depends(current_user)) -> dict:
    toolkit = str(body.get("toolkit") or "").strip().lower()
    if not toolkit:
        raise HTTPException(status_code=400, detail="Missing toolkit")
    try:
        init = await connect(user.id, toolkit)
    except ComposioError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {
        "toolkit": init.toolkit,
        "status": init.status,
        "connectedAccountId": init.connected_account_id,
        "redirectUrl": init.redirect_url,
    }


@router.post("/disconnect", status_code=http_status.HTTP_204_NO_CONTENT)
async def composio_disconnect(
    body: dict, user: User = Depends(current_user), pool=Depends(get_pool),
) -> None:
    cid = str(body.get("connectedAccountId") or "").strip()
    if not cid:
        raise HTTPException(status_code=400, detail="Missing connectedAccountId")
    try:
        await disconnect(cid)
    except ComposioError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    # Clean up the cached label so the row doesn't outlive the connection.
    if pool is not None:
        try:
            await delete_label(pool, user.id, cid)
        except Exception as e:  # noqa: BLE001 — best-effort cleanup
            logger.warning(
                "composio: delete label failed user=%s cid=%s: %s",
                user.id, cid, e,
            )
    # Drop any cached Tool Router session so the next chat call sees the
    # fresh connection state (e.g. user just disconnected one of two
    # accounts on the same toolkit).
    await evict_session(user.id)
    return None


@router.post("/wait")
async def composio_wait(
    body: dict, user: User = Depends(current_user), pool=Depends(get_pool),
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
    init_task_id = (
        await _enqueue_connector_init(pool, user.id, toolkit, cid)
        if toolkit and toolkit != "unknown"
        else None
    )
    # Eager label resolution: one extra Composio call here so the
    # subsequent /connections request returns the human label without
    # blocking. Failures get recorded to pai_connector_labels and
    # lazy-retried on the next /connections call.
    if toolkit and toolkit != "unknown" and pool is not None:
        try:
            await resolve_and_persist_label(pool, user.id, cid, toolkit)
        except Exception as e:  # noqa: BLE001 — label is best-effort, must not break /wait
            logger.warning(
                "composio: eager label resolve failed user=%s cid=%s tk=%s: %s",
                user.id, cid, toolkit, e,
            )
    out: dict = {"status": "ACTIVE", "connectedAccountId": cid}
    if init_task_id:
        out["initTaskId"] = init_task_id
    return out


@router.post("/reconnect")
async def composio_reconnect(
    body: dict, user: User = Depends(current_user), pool=Depends(get_pool),
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
            status_code=503, detail="Scheduler unavailable or enqueue failed",
        )
    # Reconnect can change the identity (rare, e.g. user re-OAuths from a
    # different profile); refresh the label proactively.
    if pool is not None:
        try:
            await resolve_and_persist_label(pool, user.id, cid, toolkit)
        except Exception as e:  # noqa: BLE001 — best-effort
            logger.warning(
                "composio: label refresh on reconnect failed user=%s cid=%s: %s",
                user.id, cid, e,
            )
    return {
        "ok": True, "toolkit": toolkit,
        "connectedAccountId": cid, "initTaskId": init_task_id,
    }


def _init_task_id(toolkit: str, connected_account_id: str) -> str:
    """Stable id for connector.init scheduled tasks. PK on
    (user_id, id) gives idempotency for free — same toolkit+cid maps to
    the same row across retries / duplicate /wait calls."""
    return f"init.{toolkit}.{connected_account_id}"


async def _enqueue_connector_init(
    pool, user_id: int, toolkit: str, connected_account_id: str,
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
                user_id=user_id, task_id=task_id, kind="connector.init",
                payload=payload, max_attempts=3,
            )
        return task_id
    except Exception as e:
        logger.warning(
            "composio: enqueue connector.init failed user=%s tk=%s: %s",
            user_id, toolkit, e,
        )
        return None


async def _requeue_connector_init(
    pool, user_id: int, toolkit: str, connected_account_id: str,
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
                user_id=user_id, task_id=task_id, kind="connector.init",
                payload=payload, max_attempts=3,
            )
        return task_id
    except Exception as e:
        logger.warning(
            "composio: requeue connector.init failed user=%s tk=%s: %s",
            user_id, toolkit, e,
        )
        return None
