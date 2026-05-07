"""/api/browser/* — frontend browser SSE + control surface.

Long-lived session SSE on the frontend side, served by streaming bytes
from the chat process verbatim. REST endpoints are thin pass-through —
chat is the single source of truth for session state.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Path, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ...auth.deps import User, current_user
from ...services.browser_proxy import proxy_browser_action, stream_browser_events

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
        user_id=user.id, method="POST",
        path=f"/agent/browser/sessions/{session_key}/control",
        body=body.model_dump(exclude_none=True),
    )


class InputBody(BaseModel):
    type: str = Field(pattern="^(text|key|click|scroll|navigate|back|forward|reload)$")
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
        user_id=user.id, method="POST",
        path=f"/agent/browser/sessions/{session_key}/input",
        body=body.model_dump(exclude_none=True),
    )


@router.post("/sessions/{session_key}/heartbeat")
async def browser_heartbeat(
    session_key: str = _SESSION_KEY,
    user: User = Depends(current_user),
) -> dict:
    return await proxy_browser_action(
        user_id=user.id, method="POST",
        path=f"/agent/browser/sessions/{session_key}/heartbeat",
    )


@router.post("/sessions/{session_key}/refresh-live-view")
async def browser_refresh_live_view(
    session_key: str = _SESSION_KEY,
    user: User = Depends(current_user),
) -> dict:
    return await proxy_browser_action(
        user_id=user.id, method="POST",
        path=f"/agent/browser/sessions/{session_key}/refresh-live-view",
    )


@router.delete("/sessions/{session_key}")
async def browser_destroy(
    session_key: str = _SESSION_KEY,
    user: User = Depends(current_user),
) -> dict:
    return await proxy_browser_action(
        user_id=user.id, method="DELETE",
        path=f"/agent/browser/sessions/{session_key}",
    )
