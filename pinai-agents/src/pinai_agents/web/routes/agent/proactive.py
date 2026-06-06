"""/api/agent/proactive/* — agent-side proactive callbacks (EdDSA JWT).

The chat process's `notify_user` tool calls /emit here to fire the push
notification. Live rendering of the say is handled separately by the stream
relay (the notify_user tool call rides the chat SSE + is persisted to
pai_chat_messages), so /emit owns the push only — no DB write.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from ...auth.deps import AgentRun, current_agent_run, get_pool
from ...services.push_notifier import notify_proactive_message

router = APIRouter(prefix="/api/agent/proactive", tags=["agent-proactive"])


@router.post("/emit")
async def emit(
    body: dict,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Fire an APNs push for a notify_user message. The visible message rides
    the chat SSE (notify_user tool-call frame) + lands in pai_chat_messages, so
    this endpoint owns notification only."""
    message = (body.get("message") or "").strip()
    if not message:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="message required",
        )
    # Best-effort push. The OS banner only surfaces when the app is NOT
    # foregrounded — iOS foreground presentation is suppressed client-side via
    # capacitor `presentationOptions: []` (an in-app user already gets the
    # message on the live stream).
    await notify_proactive_message(pool, user_id=run.user_id, message=message)
    return {"ok": True}
