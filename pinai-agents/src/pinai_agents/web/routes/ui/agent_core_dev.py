"""TEMP — CORE-3 / CORE-4 end-to-end verification harness (plan §十四).

Drives the actor kernel directly to prove the loop end-to-end without a
frontend:
  POST /api/agent-core/send    — enqueue a user message, stream live frames
                                 until a terminal (chat:done / chat:error) or a
                                 HITL pause (chat:requires_action).
  POST /api/agent-core/decide  — submit a HITL decision (approve / reject) for
                                 the paused run, stream the resumed frames.

NOT a stable API: fixed session id, no card_context. The real frontend surface
(unified useAgentRun, waiting/reconnect, approval UI) lands in RC-5, which
DELETES this file + its include line in web/app.py.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from ...auth.deps import User, current_user

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/agent-core", tags=["agent-core-dev"])

# Frames that end this SSE response: a real terminal, or a HITL pause (the run
# is now awaiting_input — the client submits a decision via /decide to resume).
_STOP_FRAMES = {"chat:done", "chat:error", "chat:requires_action"}


def _service(request: Request) -> Any:
    service = getattr(request.app.state, "agent_service", None)
    if service is None:
        raise HTTPException(status_code=503, detail="agent core worker not started")
    return service


def _session_id(user: User) -> str:
    # Fixed per-user main session (prefix matches _classify_session_key).
    return f"main-{user.id}-coretest"


async def _drive(
    service: Any,
    session_id: str,
    trigger: Callable[[], Awaitable[None]],
) -> AsyncIterator[bytes]:
    """Subscribe to the session's live frames (BEFORE firing `trigger`, so the
    worker's first frame — which only lands after drain + chat connect — is
    never missed), run the trigger, relay frames until a stop frame."""
    sub = service.subscribe(session_id)
    await trigger()
    try:
        async for frame in sub:
            yield f"data: {json.dumps(frame, ensure_ascii=False)}\n\n".encode()
            if frame.get("type") in _STOP_FRAMES:
                break
    finally:
        logger.info("agent_core stream ended session=%s", session_id)


@router.post("/send")
async def agent_core_send(
    request: Request,
    body: dict[str, Any] = Body(...),
    user: User = Depends(current_user),
) -> StreamingResponse:
    """Enqueue one user message + stream the actor kernel's live frames."""
    service = _service(request)
    message = str(body.get("message", "")).strip()
    if not message:
        raise HTTPException(status_code=400, detail="message required")
    sid = _session_id(user)

    def trigger() -> Awaitable[None]:
        return service.post_message(
            sid, user_id=user.id, agent_kind="main_chat", source="user", content=message
        )

    return StreamingResponse(
        _drive(service, sid, trigger),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/decide")
async def agent_core_decide(
    request: Request,
    body: dict[str, Any] = Body(...),
    user: User = Depends(current_user),
) -> StreamingResponse:
    """Submit a HITL decision for the paused run + stream the resumed frames."""
    service = _service(request)
    interrupt_id = str(body.get("interruptId") or "")
    decision = str(body.get("decision") or "")
    if not interrupt_id or decision not in {"approve", "reject", "edit", "respond"}:
        raise HTTPException(
            status_code=400, detail="interruptId + valid decision (approve/reject/…) required"
        )
    msg = body.get("message")
    sid = _session_id(user)

    def trigger() -> Awaitable[None]:
        return service.submit_decision(
            sid,
            user_id=user.id,
            agent_kind="main_chat",
            tool_use_id=interrupt_id,
            decision=decision,
            message=msg,
        )

    return StreamingResponse(
        _drive(service, sid, trigger),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
