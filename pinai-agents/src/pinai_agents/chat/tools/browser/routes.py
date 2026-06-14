"""Browser HTTP surface (chat process).

  GET    /agent/browser/events?sessionKey=...                  — SSE
  POST   /agent/browser/sessions/{sessionKey}/control          — body {mode, reason?}
  POST   /agent/browser/sessions/{sessionKey}/input            — body {type, ...}
  POST   /agent/browser/sessions/{sessionKey}/heartbeat
  POST   /agent/browser/sessions/{sessionKey}/refresh-live-view
  DELETE /agent/browser/sessions/{sessionKey}

The web process proxies frontend traffic here with a verified agent JWT.
URL key is `sessionKey` (frontend's stable chat-thread id) — the
Browserbase session id is internal and never appears in URLs.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator

from fastapi import APIRouter, Header, HTTPException, Path, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ...auth.run_jwt import RunJWTError, verify_run_jwt
from .control_state import normalize_mode
from .events import browser_events
from .manager import get_browser_manager

logger = logging.getLogger(__name__)
router = APIRouter()

_SESSION_KEY = Path(..., min_length=1, max_length=200, alias="session_key")
_INPUT_TEXT_MAX = 2000


def _verify_or_401(authorization: str | None) -> None:
    if not (authorization and authorization.lower().startswith("bearer ")):
        return
    token = authorization[len("bearer ") :].strip()
    try:
        verify_run_jwt(token)
    except RunJWTError as e:
        logger.warning("browser routes: invalid run JWT — %s", e)
        raise HTTPException(401, "invalid run JWT") from e


# ── SSE ──


@router.get("/agent/browser/events")
async def browser_events_sse(
    sessionKey: str = Query(..., min_length=1, max_length=200),  # noqa: N803
    authorization: str | None = Header(default=None),
) -> StreamingResponse:
    _verify_or_401(authorization)
    return StreamingResponse(
        _event_stream(sessionKey),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _event_stream(session_key: str) -> AsyncIterator[bytes]:
    async with browser_events.subscribe(session_key) as q:
        while True:
            try:
                envelope = await asyncio.wait_for(q.get(), timeout=25.0)
                yield (b"data: " + json.dumps(envelope, ensure_ascii=False).encode() + b"\n\n")
            except TimeoutError:
                yield b": ping\n\n"


# ── REST ──


class ControlBody(BaseModel):
    mode: str = Field(pattern="^(ai|user)$")
    reason: str | None = None


@router.post("/agent/browser/sessions/{session_key}/control")
async def browser_control(
    body: ControlBody,
    session_key: str = _SESSION_KEY,
    authorization: str | None = Header(default=None),
) -> dict:
    _verify_or_401(authorization)
    mode = normalize_mode(body.mode)
    await get_browser_manager().set_control_mode(
        session_key,
        mode,
        reason=body.reason if body.mode == "user" else None,
    )
    return {"ok": True, "mode": mode.value}


class InputBody(BaseModel):
    type: str = Field(pattern="^(tap|text|key|click|scroll|navigate|back|forward|reload)$")
    text: str | None = None
    key: str | None = None
    x: float | None = None
    y: float | None = None
    dx: float | None = None
    dy: float | None = None
    url: str | None = None


@router.post("/agent/browser/sessions/{session_key}/input")
async def browser_input(
    body: InputBody,
    session_key: str = _SESSION_KEY,
    authorization: str | None = Header(default=None),
) -> dict:
    _verify_or_401(authorization)
    if body.type == "text" and (not body.text or len(body.text) > _INPUT_TEXT_MAX):
        raise HTTPException(400, f"text required and ≤ {_INPUT_TEXT_MAX} chars")
    payload = body.model_dump(exclude_none=True)
    payload.pop("type", None)
    try:
        result = await get_browser_manager().apply_user_input(session_key, body.type, payload)
    except RuntimeError as e:
        # session not found
        raise HTTPException(404, str(e)) from e
    return {"ok": True, **(result or {})}


@router.post("/agent/browser/sessions/{session_key}/heartbeat")
async def browser_heartbeat(
    session_key: str = _SESSION_KEY,
    authorization: str | None = Header(default=None),
) -> dict:
    _verify_or_401(authorization)
    alive = await get_browser_manager().heartbeat(session_key)
    if not alive:
        raise HTTPException(404, "session not found")
    return {"ok": True}


@router.post("/agent/browser/sessions/{session_key}/refresh-live-view")
async def browser_refresh_live_view(
    session_key: str = _SESSION_KEY,
    authorization: str | None = Header(default=None),
) -> dict:
    _verify_or_401(authorization)
    url = await get_browser_manager().refresh_live_view(session_key)
    if url is None:
        raise HTTPException(404, "session not found")
    return {"ok": True, "liveViewUrl": url}


@router.delete("/agent/browser/sessions/{session_key}")
async def browser_destroy(
    session_key: str = _SESSION_KEY,
    authorization: str | None = Header(default=None),
) -> dict:
    _verify_or_401(authorization)
    await get_browser_manager().destroy(session_key)
    return {"ok": True}
