"""/api/composio/* — connector OAuth flow (frontend Supabase JWT auth).

Wraps the Composio v3 REST API. The shared `COMPOSIO_API_KEY` env var
authenticates pinai-agents to Composio; per-user separation comes from
passing the user's internal id as Composio's `user_id`.

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
from ...composio import (
    ComposioError,
    connect_toolkit,
    disconnect,
    list_connections,
    status,
    wait_for_active,
)
from ...db.repositories.scheduled_tasks import (
    enqueue_once,
    requeue_once,
)
from ...db.rls import user_scoped_tx

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/composio", tags=["composio"])


def _api_key_or_400() -> str:
    from ....config import get_web_settings  # noqa: PLC0415
    s = get_web_settings()
    if not s.composio_api_key:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="COMPOSIO_API_KEY not configured",
        )
    return s.composio_api_key


@router.get("/status")
async def composio_status(user: User = Depends(current_user)) -> dict:
    from ....config import get_web_settings  # noqa: PLC0415
    s = get_web_settings()
    return await status(s.composio_api_key)


@router.get("/connections")
async def composio_connections(user: User = Depends(current_user)) -> dict:
    api_key = _api_key_or_400()
    try:
        items = await list_connections(api_key, user.id)
    except ComposioError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {"connections": items}


@router.post("/connect")
async def composio_connect(body: dict, user: User = Depends(current_user)) -> dict:
    toolkit = str(body.get("toolkit") or "").strip().lower()
    if not toolkit:
        raise HTTPException(status_code=400, detail="Missing toolkit")
    api_key = _api_key_or_400()
    try:
        return await connect_toolkit(api_key, user.id, toolkit)
    except ComposioError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.post("/disconnect", status_code=http_status.HTTP_204_NO_CONTENT)
async def composio_disconnect(
    body: dict, user: User = Depends(current_user),
) -> None:
    cid = str(body.get("connectedAccountId") or "").strip()
    if not cid:
        raise HTTPException(status_code=400, detail="Missing connectedAccountId")
    api_key = _api_key_or_400()
    try:
        await disconnect(api_key, cid)
    except ComposioError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return None


@router.post("/wait")
async def composio_wait(
    body: dict, user: User = Depends(current_user), pool=Depends(get_pool),
) -> dict:
    cid = str(body.get("connectedAccountId") or "").strip()
    if not cid:
        raise HTTPException(status_code=400, detail="Missing connectedAccountId")
    api_key = _api_key_or_400()
    result = await wait_for_active(api_key, cid)
    if result.get("status") != "ACTIVE":
        return {"status": result.get("status"), "connectedAccountId": cid}
    # Newly active — enqueue connector.init backfill task.
    toolkit = result.get("toolkit") or str(body.get("toolkit") or "").strip().lower()
    init_task_id = await _enqueue_connector_init(pool, user.id, toolkit, cid) if toolkit else None
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
    api_key = _api_key_or_400()
    # If toolkit not provided, ask Composio (mirrors TS plugin behavior).
    if not toolkit:
        from ...composio import _request  # noqa: PLC0415  — internal helper reuse
        try:
            account = await _request(api_key, f"/connected_accounts/{cid}")
        except ComposioError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        tk = account.get("toolkit") or {}
        toolkit = str(
            (tk.get("slug") if isinstance(tk, dict) else tk) or "",
        ).strip().lower()
    if not toolkit:
        raise HTTPException(status_code=400, detail="Could not resolve toolkit")
    # Reconnect = "run init again". Use requeue (atomic INSERT-or-RESET)
    # so a prior archived row gets reactivated in one statement.
    init_task_id = await _requeue_connector_init(pool, user.id, toolkit, cid)
    if not init_task_id:
        raise HTTPException(
            status_code=503, detail="Scheduler unavailable or enqueue failed",
        )
    return {
        "ok": True, "toolkit": toolkit,
        "connectedAccountId": cid, "initTaskId": init_task_id,
    }


def _init_task_id(toolkit: str, connected_account_id: str) -> str:
    """Stable id for connector.init scheduled tasks. PK on
    (user_id, id) gives us idempotency for free — same toolkit+cid maps
    to the same row across retries / duplicate /wait calls."""
    return f"init.{toolkit}.{connected_account_id}"


async def _enqueue_connector_init(
    pool, user_id: int, toolkit: str, connected_account_id: str,
) -> str | None:
    """Insert a connector.init once-shot task into pai_scheduled_tasks.

    Returns the task id on success (newly inserted or pre-existing),
    None on failure — failing the OAuth flow over a backend enqueue blip
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
        # Whether inserted or already-present, the deterministic id is
        # what callers need to poll status with.
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
