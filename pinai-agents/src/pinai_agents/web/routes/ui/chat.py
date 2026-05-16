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
    ChatThreadItem,
    ChatThreadListResponse,
)
from ...auth.deps import User, current_user, get_pool
from ...db.repositories.chat_threads import ChatThreadsRepository
from ...db.rls import user_scoped_tx
from ...services.chat_proxy import (
    call_chat_exists,
    call_chat_history,
    stream_chat,
)

_CARD_THREAD_PREFIX = "card-thread-"


def _classify_session_key(session_key: str, user_id: int) -> tuple[str, str | None]:
    """Map a session_key to (kind, card_id) for pai_chat_threads.

    Validates that frontend-provided session_keys belong to the calling
    user (main-<user_id>-...) or are card-thread-<card_id> shape — anything
    else is rejected so a malicious / buggy client can't spawn metadata
    rows under arbitrary user_ids.
    """
    if session_key.startswith(_CARD_THREAD_PREFIX):
        card_id = session_key[len(_CARD_THREAD_PREFIX):]
        if not card_id:
            raise HTTPException(status_code=400, detail="empty card_id in session_key")
        return "card", card_id
    main_prefix = f"main-{user_id}-"
    if session_key.startswith(main_prefix) and len(session_key) > len(main_prefix):
        return "main", None
    raise HTTPException(
        status_code=400,
        detail="session_key must be 'card-thread-<id>' or 'main-<your_user_id>-<rand>'",
    )

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/chat-stream", tags=["chat"])


@router.post("/init", response_model=ChatInitResponse)
async def chat_init(
    body: ChatInitRequest,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> ChatInitResponse:
    """Resolve the session_key + check whether the thread already exists.

    Resolution order:
      1. body.session_key explicit (FE has localStorage cache or card path) —
         validate it belongs to this user, ensure metadata row exists.
      2. body.card_id (card chat first-open) — derive
         card-thread-<card_id>, kind='card'.
      3. neither (Main Chat first-open / cache miss) — look up the user's
         most-recently-active main thread in pai_chat_threads. If found,
         reuse it so the user resumes their history. If none, mint a new
         main-<user_id>-<rand> thread (genuinely first time).

    The third case is the bug fix that motivated 035_pai_chat_threads:
    minting blindly here orphaned LangGraph history whenever localStorage
    got cleared. The pai_chat_threads metadata table is the source of
    truth for "what threads does this user have"; we trust it over the
    browser cache.
    """
    kind: str
    card_id: str | None
    title: str | None = None

    if body.session_key:
        session_key = body.session_key
        kind, card_id = _classify_session_key(session_key, user.id)
    elif body.card_id:
        session_key = f"{_CARD_THREAD_PREFIX}{body.card_id}"
        kind, card_id = "card", body.card_id
    else:
        # Main chat with no hint — recover the user's existing thread
        # from pai_chat_threads. Mint a new one only if they truly have none.
        async with user_scoped_tx(pool, user.id) as conn:
            existing_thread_id = await ChatThreadsRepository(
                user_id=user.id, conn=conn,
            ).get_latest_main_thread_id()
        if existing_thread_id is not None:
            session_key = existing_thread_id
        else:
            session_key = f"main-{user.id}-{uuid.uuid4().hex[:12]}"
        kind, card_id = "main", None

    # Idempotent INSERT into pai_chat_threads — the metadata row should
    # exist for every active thread. ON CONFLICT DO NOTHING handles the
    # common case (sessionKey already known to us).
    async with user_scoped_tx(pool, user.id) as conn:
        await ChatThreadsRepository(
            user_id=user.id, conn=conn,
        ).insert_thread(
            thread_id=session_key, kind=kind,
            card_id=card_id, title=title,
        )

    existing = await call_chat_exists(user_id=user.id, session_key=session_key)
    return ChatInitResponse(
        session_key=session_key, existing=existing,
    )


@router.get("/threads", response_model=ChatThreadListResponse)
async def list_chat_threads(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    kind: str | None = Query(None, pattern="^(main|card)$"),
    limit: int = Query(50, ge=1, le=200),
) -> ChatThreadListResponse:
    """List the user's chat threads, latest-active first. Reads only
    pai_chat_threads (no LangGraph hop) — fast list endpoint for a
    sidebar / picker UI."""
    async with user_scoped_tx(pool, user.id) as conn:
        rows = await ChatThreadsRepository(
            user_id=user.id, conn=conn,
        ).list_threads(kind=kind, limit=limit)
    return ChatThreadListResponse(
        threads=[
            ChatThreadItem(
                thread_id=r.thread_id,
                kind=r.kind,
                card_id=r.card_id,
                title=r.title,
                archived=r.archived,
                created_at=r.created_at,
                last_message_at=r.last_message_at,
                message_count=r.message_count,
            )
            for r in rows
        ],
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

    # Wrap the SSE generator with a finalizer that bumps the chat
    # thread's last_message_at + message_count once the stream
    # completes (success or client disconnect — either way the user
    # turn was accepted by chat). Best-effort: if the bump itself
    # fails we log and move on; the metadata can be reconciled by
    # next list query and chat history is unaffected.
    async def _stream_with_metadata_bump():
        try:
            hints_dict = (
                body.client_hints.model_dump(by_alias=False)
                if body.client_hints is not None
                else None
            )
            async for chunk in stream_chat(
                user_id=user.id,
                session_key=body.session_key,
                message=body.message,
                card_context=body.card_context,
                virtual_key=user.litellm_virtual_key,
                browserbase_context_id=user.browserbase_context_id,
                client_hints=hints_dict,
            ):
                yield chunk
        finally:
            try:
                async with user_scoped_tx(pool, user.id) as conn:
                    await ChatThreadsRepository(
                        user_id=user.id, conn=conn,
                    ).bump_after_send(thread_id=body.session_key)
            except Exception:
                logger.exception(
                    "bump_after_send failed user=%d thread=%s",
                    user.id, body.session_key,
                )

    return StreamingResponse(
        _stream_with_metadata_bump(),
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
