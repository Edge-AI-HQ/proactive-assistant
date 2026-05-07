"""/api/chat-stream/* — frontend chat SSE entry; web → chat proxy.

Wire layout:
    POST /init     → mints / echoes session_key + tells caller whether the
                     thread already has persisted turns (drives card-chat
                     bootstrap on the frontend).
    POST /send     → SSE pipe to the chat worker.
    GET  /history  → returns the merged turn list in HistoryMessage shape.

The chat worker is the only process with access to LangGraph's checkpoint
table, so init/history both forward there over a signed agent JWT. Web
never reads checkpoints itself — separation of trust per
docs/plans/2026-05-04-pinai-agents-backend-consolidation.mdx § 鉴权.
"""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse

from ....shared.api_models import (
    ChatHistoryResponse,
    ChatInitRequest,
    ChatInitResponse,
    ChatSendRequest,
)
from ...auth.deps import User, current_user, get_pool
from ...services.chat_proxy import (
    call_chat_exists,
    call_chat_history,
    stream_chat,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/chat-stream", tags=["chat"])


@router.post("/init", response_model=ChatInitResponse)
async def chat_init(
    body: ChatInitRequest,
    user: User = Depends(current_user),
) -> ChatInitResponse:
    """Resolve the session_key + check whether the thread already exists.

    Naming convention:
      - card threads: `card-thread-<card_id>` (deterministic per card; the
        same card resumes the same conversation).
      - main threads: `main-<user_id>-<rand>` (random-suffix per session;
        frontend caches the active main session id).

    `existing` is consulted by chat worker's /agent/chat/exists, not
    inferred from session_key shape — a freshly-named thread is still
    "existing" the moment the first turn lands.
    """
    if body.session_key:
        session_key = body.session_key
    elif body.card_id:
        session_key = f"card-thread-{body.card_id}"
    else:
        session_key = f"main-{user.id}-{uuid.uuid4().hex[:12]}"

    existing = await call_chat_exists(user_id=user.id, session_key=session_key)
    return ChatInitResponse(
        session_key=session_key, existing=existing,
    )


@router.post("/send")
async def chat_send(
    body: ChatSendRequest,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """Stream SSE from chat worker back to the frontend.

    The user's LiteLLM virtual_key travels in the signed JWT claims (not
    in the request body) so the chat worker never needs to know the
    body shape. See web/auth/agent_jwt.py § extra claims.
    """
    if not user.litellm_virtual_key:
        # Should be rare — provisioning runs synchronously on first user
        # upsert. If we get here, the LiteLLM admin call failed back then;
        # try once more before giving up.
        from ...services.litellm_provisioning import (  # noqa: PLC0415
            ensure_user_litellm_key,
        )
        try:
            user = await ensure_user_litellm_key(pool, user)
        except Exception as e:
            logger.exception("lazy LiteLLM provisioning failed user=%d", user.id)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"unable to provision LiteLLM key: {type(e).__name__}: {e}",
            ) from e
        if not user.litellm_virtual_key:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="LiteLLM key missing after provisioning",
            )

    # Lazy-provision a per-user persistent Browserbase context on first
    # chat-send (one-shot ~200ms). Best-effort: if Browserbase isn't
    # configured or the API call fails, falls through with bbctx=None
    # and the chat agent uses ephemeral sessions for that user.
    if not user.browserbase_context_id:
        from ...services.browserbase_provisioning import (  # noqa: PLC0415
            ensure_browserbase_context,
        )
        user = await ensure_browserbase_context(pool, user)

    return StreamingResponse(
        stream_chat(
            user_id=user.id,
            session_key=body.session_key,
            message=body.message,
            card_context=body.card_context,
            virtual_key=user.litellm_virtual_key,
            browserbase_context_id=user.browserbase_context_id,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/history", response_model=ChatHistoryResponse)
async def chat_history(
    sessionKey: str = Query(..., min_length=1, max_length=200),  # noqa: N803
    user: User = Depends(current_user),
) -> ChatHistoryResponse:
    """Fetch persisted turns for `sessionKey` from LangGraph checkpointer.

    The frontend query param is camelCase (matches the rest of the
    /api/* surface). Empty list on missing thread — caller renders a
    fresh chat.
    """
    messages = await call_chat_history(user_id=user.id, session_key=sessionKey)
    return ChatHistoryResponse(messages=messages)
