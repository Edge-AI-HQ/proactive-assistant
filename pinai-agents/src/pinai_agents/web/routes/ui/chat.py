"""/api/chat-stream/* — frontend chat SSE entry; web → chat proxy.

Wire layout:
    POST /init     → resolves the user's session_key. Main chat is a
                     singleton per user (one row, kind='main'); the
                     row is created lazily on first call. Card chat
                     uses a deterministic card-thread-<id> key.
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
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from psycopg.types.json import Jsonb

from ....shared.api_models import (
    ChatHistoryResponse,
    ChatInitRequest,
    ChatInitResponse,
    ChatSendRequest,
)
from ...auth.deps import User, current_user, get_pool
from ...db.repositories.chat_messages import ChatMessagesRepository
from ...db.repositories.chat_threads import ChatThreadsRepository, ThreadKind
from ...db.rls import user_scoped_tx
from ...services.chat_proxy import (
    call_chat_exists,
    call_chat_history,
    stream_chat,
)
from ...services.chat_turn_recorder import ChatTurnRecorder

_CARD_THREAD_PREFIX = "card-thread-"


def _classify_session_key(session_key: str, user_id: int) -> tuple[ThreadKind, str | None]:
    """Map a session_key to (kind, card_id) for pai_chat_threads.

    Validates that frontend-provided session_keys belong to the calling
    user (main-<user_id>-...) or are card-thread-<card_id> shape — anything
    else is rejected so a malicious / buggy client can't spawn metadata
    rows under arbitrary user_ids.
    """
    if session_key.startswith(_CARD_THREAD_PREFIX):
        card_id = session_key[len(_CARD_THREAD_PREFIX) :]
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


async def _assert_session_owned(
    session_key: str,
    user_id: int,
    conn: Any,
) -> tuple[ThreadKind, str | None]:
    """Authorize that `session_key` belongs to `user_id` (raises 403 if not).

    main threads encode the owner in the key — `_classify_session_key`'s
    prefix check covers them. card threads carry only a card_id, so we
    verify the card was generated for this user via an RLS-scoped
    containment check on `pai_pipeline_runs.final_cards`. Without this a
    client could pass any `card-thread-<id>` and read another user's
    card-chat checkpoint (langgraph checkpoints have no RLS). Must run
    inside a `user_scoped_tx` for `user_id`.
    """
    kind, card_id = _classify_session_key(session_key, user_id)
    if kind == "card":
        assert card_id is not None  # _classify guarantees non-empty for card
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT 1 FROM pai_pipeline_runs WHERE user_id = %s AND final_cards @> %s LIMIT 1",
                (user_id, Jsonb([{"id": card_id}])),
            )
            if await cur.fetchone() is None:
                raise HTTPException(
                    status_code=403,
                    detail="card does not belong to this user",
                )
    return kind, card_id


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
      1. body.session_key explicit (FE has cached the key, or card chat
         resumes a card-thread-<id>) — validate it belongs to this user,
         ensure the metadata row exists.
      2. body.card_id (card chat first-open) — derive
         card-thread-<card_id>, kind='card'.
      3. neither (Main Chat) — return the user's singleton main thread.
         Main chat is one thread per user: pick the most-recently-active
         existing main row, or mint a new one if the user has none yet.

    This was previously a 3-thread-per-user model with `new_thread=true`
    starting fresh threads. The model collapsed to "one main thread per
    user, history accumulates" — see migration 053 for the cleanup +
    UNIQUE constraint enforcing this going forward.
    """
    # Resolve the session_key first (no ownership decision yet).
    if body.session_key:
        session_key = body.session_key
    elif body.card_id:
        session_key = f"{_CARD_THREAD_PREFIX}{body.card_id}"
    else:
        # Main chat with no hint — recover the singleton main thread for
        # this user. Mint only if they truly have none.
        async with user_scoped_tx(pool, user.id) as conn:
            existing_thread_id = await ChatThreadsRepository(
                user_id=user.id,
                conn=conn,
            ).get_latest_main_thread_id()
        session_key = existing_thread_id or f"main-{user.id}-{uuid.uuid4().hex[:12]}"

    # Authorize ownership + idempotent metadata insert in one tx. The
    # ownership check (403 if this session_key isn't the user's) is the
    # primary cross-user isolation guard here — chat checkpoints have no
    # RLS, so a bad card-thread-<id> must be rejected before we touch it.
    async with user_scoped_tx(pool, user.id) as conn:
        kind, card_id = await _assert_session_owned(session_key, user.id, conn)
        await ChatThreadsRepository(
            user_id=user.id,
            conn=conn,
        ).insert_thread(
            thread_id=session_key,
            kind=kind,
            card_id=card_id,
        )
        # main: `existing` = has any pai_chat_messages row (O(1) index hit),
        # replacing the chat-worker aget_state full-state rebuild that
        # dominated open-chat white-screen latency (plan 2026-06-01 §5.4 P0).
        main_latest_id = (
            await ChatMessagesRepository(
                user_id=user.id,
                conn=conn,
            ).latest_id(thread_id=session_key)
            if kind == "main"
            else None
        )

    # card thread: pai_chat_messages stays empty until /send persists its
    # first turn, so the table can't answer "existing" — probe the checkpoint.
    if kind == "main":
        existing = main_latest_id is not None
    else:
        existing = await call_chat_exists(user_id=user.id, session_key=session_key)

    return ChatInitResponse(
        session_key=session_key,
        existing=existing,
    )


def _row_to_history_message(row: dict[str, Any]) -> dict[str, Any]:
    """A pai_chat_messages row → the frontend HistoryMessage shape."""
    out: dict[str, Any] = {
        "id": str(row["id"]),
        "role": row["role"],
        "parts": row["parts"],
    }
    created = row.get("created_at")
    if created is not None:
        out["createdAt"] = int(created.timestamp() * 1000)
    return out


async def _persist_turn(
    repo: ChatMessagesRepository,
    *,
    body: ChatSendRequest,
    assistant_parts: list[dict[str, Any]],
) -> None:
    """Append this turn to pai_chat_messages, kept consistent with chat's
    RemoveMessage surgery on regenerate / edit.

    A normal send appends unconditionally — even on a brand-new thread or one
    whose /history lazy backfill silently timed out — so the thread always
    records its first turn here. This unblocks the "new messages never
    persist" chicken-and-egg: the old `latest_id is None → return` guard
    assumed backfill had seeded row 1, but backfill can time out and write
    nothing (plan 2026-06-01 §5.4 P0). regenerate/edit still needs an existing
    tail to pop, so it no-ops on an empty table.
    """
    sk = body.session_key

    if body.regenerate:
        # No tail to pop on an empty table (thread predates pai_chat_messages
        # and backfill hasn't run) — skip surgery; next normal send records it.
        if await repo.latest_id(thread_id=sk) is None:
            return
        # Mirror chat's pop-tail-and-rerun: an edit (user text changed)
        # replaces user+assistant; a pure regenerate replaces only assistant.
        new_text = (body.message or "").strip()
        last_user = (await repo.last_user_text(thread_id=sk)) or ""
        if new_text and new_text != last_user.strip():
            await repo.delete_tail(thread_id=sk, count=2)
            await repo.append_turn(
                thread_id=sk,
                role="user",
                parts=[{"type": "text", "text": body.message}],
            )
        else:
            await repo.delete_tail(thread_id=sk, count=1)
    else:
        await repo.append_turn(
            thread_id=sk,
            role="user",
            parts=[{"type": "text", "text": body.message}],
        )
    if assistant_parts:
        await repo.append_turn(
            thread_id=sk,
            role="assistant",
            parts=assistant_parts,
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
    # The LiteLLM virtual_key + Browserbase context are provisioned at
    # onboarding completion (web/routes/ui/profile.py:update_settings) and
    # the SPA gates the app on onboarding, so both are already on the user
    # row by the time chat-send runs — no lazy provisioning here.

    # Wrap the SSE generator with a finalizer that bumps the chat
    # thread's last_message_at + message_count once the stream
    # completes (success or client disconnect — either way the user
    # turn was accepted by chat). Best-effort: if the bump itself
    # fails we log and move on; the metadata can be reconciled by
    # next list query and chat history is unaffected.

    # Cross-user isolation: the session_key must belong to this user before
    # we drive the chat worker against it (chat checkpoints have no RLS).
    # 403 otherwise — primary guard for /send.
    async with user_scoped_tx(pool, user.id) as conn:
        await _assert_session_owned(body.session_key, user.id, conn)

    async def _stream_and_persist():
        # Record the assistant turn off the SSE bytes as they flow to the
        # client, then persist (user + assistant) to pai_chat_messages and
        # bump thread metadata once the stream ends — success or client
        # disconnect. Best-effort: a persistence failure is logged, never
        # surfaced (chat data already landed in the checkpoint; /history
        # lazy-backfills from there on the next read).
        recorder = ChatTurnRecorder()
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
                regenerate=body.regenerate,
            ):
                recorder.feed(chunk)
                yield chunk
        finally:
            try:
                async with user_scoped_tx(pool, user.id) as conn:
                    await _persist_turn(
                        ChatMessagesRepository(user_id=user.id, conn=conn),
                        body=body,
                        assistant_parts=recorder.parts(),
                    )
                    # message_count tracks real conversation turns; a
                    # regenerate replaces a turn rather than adding one.
                    if not body.regenerate:
                        await ChatThreadsRepository(
                            user_id=user.id,
                            conn=conn,
                        ).bump_after_send(thread_id=body.session_key)
            except Exception:
                logger.exception(
                    "persist chat turn failed user=%d thread=%s",
                    user.id,
                    body.session_key,
                )

    return StreamingResponse(
        _stream_and_persist(),
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
    beforeId: int | None = Query(default=None, ge=1),  # noqa: N803
    limit: int = Query(default=50, ge=1, le=200),
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> ChatHistoryResponse:
    """Paginated chat history from pai_chat_messages.

    Returned oldest-first per page (the table is read newest-first then
    reversed). `beforeId` is the "load older" cursor; the response's
    `nextCursor` is the smallest id of this page when more may exist.

    The first read of a thread that predates pai_chat_messages lazily
    backfills its full history from the chat worker's checkpoint
    (aget_state), then serves from the table — so reads are O(page), not
    O(whole-thread state reconstruction). Empty list on a missing thread.
    """
    async with user_scoped_tx(pool, user.id) as conn:
        await _assert_session_owned(sessionKey, user.id, conn)
        repo = ChatMessagesRepository(user_id=user.id, conn=conn)
        if beforeId is None and await repo.latest_id(thread_id=sessionKey) is None:
            backfilled = await call_chat_history(
                user_id=user.id,
                session_key=sessionKey,
            )
            if backfilled:
                await repo.bulk_append(thread_id=sessionKey, turns=backfilled)
        rows = await repo.get_page(
            thread_id=sessionKey,
            before_id=beforeId,
            limit=limit,
        )
    # A full page means older rows may exist before its smallest id.
    next_cursor = rows[-1]["id"] if len(rows) == limit else None
    messages = [_row_to_history_message(r) for r in reversed(rows)]
    return ChatHistoryResponse(messages=messages, next_cursor=next_cursor)
