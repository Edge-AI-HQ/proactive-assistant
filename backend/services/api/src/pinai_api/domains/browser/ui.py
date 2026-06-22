"""/api/browser/* — frontend browser SSE + control surface + login registry.

Long-lived session SSE on the frontend side, served by streaming bytes
from the chat process verbatim. Session REST endpoints are thin pass-through
— chat is the single source of truth for session state.

The `/logins` endpoints are web-local (read/write pai_browser_logins): they
track which sites the user has login state for in their persistent
Browserbase context, so the data-connector UI can list and delete them.
Delete also clears that site's cookies from the context via chat CDP.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from fastapi.responses import StreamingResponse
from pinai_db.rls import user_scoped_tx
from pydantic import BaseModel, ConfigDict, Field

from ...platform.auth.deps import User, current_user, get_pool
from .proxy import (
    clear_site_cookies,
    proxy_browser_action,
    stream_browser_events,
)
from .repository import BrowserLoginsRepository

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/browser", tags=["browser"])

_SESSION_KEY = Path(..., min_length=1, max_length=200, alias="session_key")


@router.get("/events")
async def browser_events(
    sessionKey: str = Query(..., min_length=1, max_length=200),  # noqa: N803
    user: User = Depends(current_user),
) -> StreamingResponse:
    return StreamingResponse(
        stream_browser_events(user_id=user.id, session_key=sessionKey),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


class ControlBody(BaseModel):
    mode: str = Field(pattern="^(ai|user)$")
    reason: str | None = None


@router.post("/sessions/{session_key}/control")
async def browser_control(
    body: ControlBody,
    session_key: str = _SESSION_KEY,
    user: User = Depends(current_user),
) -> dict:
    return await proxy_browser_action(
        user_id=user.id,
        method="POST",
        path=f"/agent/browser/sessions/{session_key}/control",
        body=body.model_dump(exclude_none=True),
    )


class InputBody(BaseModel):
    type: str = Field(pattern="^(tap|text|key|click|scroll|navigate|back|forward|reload)$")
    text: str | None = None
    key: str | None = None
    x: float | None = None
    y: float | None = None
    dx: float | None = None
    dy: float | None = None
    url: str | None = None


@router.post("/sessions/{session_key}/input")
async def browser_input(
    body: InputBody,
    session_key: str = _SESSION_KEY,
    user: User = Depends(current_user),
) -> dict:
    return await proxy_browser_action(
        user_id=user.id,
        method="POST",
        path=f"/agent/browser/sessions/{session_key}/input",
        body=body.model_dump(exclude_none=True),
    )


@router.post("/sessions/{session_key}/heartbeat")
async def browser_heartbeat(
    session_key: str = _SESSION_KEY,
    user: User = Depends(current_user),
) -> dict:
    return await proxy_browser_action(
        user_id=user.id,
        method="POST",
        path=f"/agent/browser/sessions/{session_key}/heartbeat",
    )


@router.post("/sessions/{session_key}/refresh-live-view")
async def browser_refresh_live_view(
    session_key: str = _SESSION_KEY,
    user: User = Depends(current_user),
) -> dict:
    return await proxy_browser_action(
        user_id=user.id,
        method="POST",
        path=f"/agent/browser/sessions/{session_key}/refresh-live-view",
    )


@router.delete("/sessions/{session_key}")
async def browser_destroy(
    session_key: str = _SESSION_KEY,
    user: User = Depends(current_user),
) -> dict:
    return await proxy_browser_action(
        user_id=user.id,
        method="DELETE",
        path=f"/agent/browser/sessions/{session_key}",
    )


# ── Login registry (web-local: pai_browser_logins) ──


def _normalize_domain(raw: str) -> str:
    """Reduce a user/agent-supplied value to a bare host. Accepts a full
    URL or a host; lowercases; strips scheme, path, and port."""
    d = raw.strip().lower()
    if "://" in d:
        d = d.split("://", 1)[1]
    d = d.split("/", 1)[0]
    d = d.split(":", 1)[0]
    return d


class LoginRecordBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    session_key: str = Field(alias="sessionKey", min_length=1, max_length=200)


@router.get("/logins")
async def browser_logins_list(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict:
    if pool is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    async with user_scoped_tx(pool, user.id) as conn:
        rows = await BrowserLoginsRepository(user.id, conn).list_for_current_user()
    return {
        "items": [
            {
                "siteDomain": r.site_domain,
                "displayName": r.display_name,
                "loginLabel": r.login_label,
                "status": r.status,
                "lastUsedAt": r.last_used_at.isoformat() if r.last_used_at else None,
            }
            for r in rows
        ]
    }


@router.post("/logins/record")
async def browser_logins_record(
    body: LoginRecordBody,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict:
    """Record the current page as a login — but only if it actually carries a
    login cookie. Chat (which holds the CDP session) checks for an HttpOnly
    cookie; only then do we upsert. This keeps the list to sites the user truly
    logged into, not every page they browsed."""
    if pool is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    check = await proxy_browser_action(
        user_id=user.id,
        method="GET",
        path=f"/agent/browser/sessions/{body.session_key}/login-check",
    )
    if not check.get("hasLogin"):
        return {"ok": True, "recorded": False}
    # Aggregate by the login cookie's registrable domain (e.g. google.com),
    # not the visited host — one login per site, not per subdomain.
    domain = _normalize_domain(str(check.get("loginDomain") or ""))
    if not domain:
        return {"ok": True, "recorded": False}
    async with user_scoped_tx(pool, user.id) as conn:
        await BrowserLoginsRepository(user.id, conn).upsert(site_domain=domain)
    return {"ok": True, "recorded": True, "siteDomain": domain}


@router.delete("/logins/{site_domain}")
async def browser_logins_delete(
    site_domain: str = Path(..., min_length=1, max_length=255),
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict:
    if pool is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    domain = _normalize_domain(site_domain)
    if not domain:
        raise HTTPException(status_code=400, detail="Invalid site_domain")
    # Delete the metadata row first (user-scoped), then best-effort clear the
    # site's cookies from the persistent context via chat. The row delete is
    # the user-visible source of truth; cookie clearing is a side effect that
    # must not fail the request (cookies also drop when the site re-challenges).
    async with user_scoped_tx(pool, user.id) as conn:
        await BrowserLoginsRepository(user.id, conn).delete(domain)
    try:
        await clear_site_cookies(pool=pool, user_id=user.id, site_domain=domain)
    except HTTPException as e:
        logger.warning("clear-site cookies failed user=%s domain=%s: %s", user.id, domain, e.detail)
    return {"ok": True, "siteDomain": domain}
