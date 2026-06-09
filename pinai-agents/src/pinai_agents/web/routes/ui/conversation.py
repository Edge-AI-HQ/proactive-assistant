"""/api/conversation/* — unified actor-kernel entry for conversational agents.

Single frontend entry for main chat, card execution, and the proactive agent —
all three are sessions on the Agent Core actor kernel (AgentRunService). A send
enqueues onto the session mailbox and returns 202; the agent's turn streams back
over the long-lived /stream connection; a HITL tool pause surfaces as a
`chat:requires_action` frame that /decision resolves on the same thread.

  POST /init      → resolve session_key (main singleton / card / proactive) + existing
  POST /send      → enqueue a user message (+ optional cardContext); 202
  GET  /stream    → long-lived SSE: thinking / tool / text / requires_action frames
  POST /decision  → HITL: approve/reject/edit/respond a paused tool call
  POST /cancel    → stop the in-flight turn
  GET  /history   → persisted turns (pai_chat_messages), cursor-paginated

The reply is async — it arrives on /stream, not the /send response — so the
frontend opens one /stream per session and posts sends/decisions against it.
Main chat, card execution, and the proactive page all run on this kernel-native
path now. The legacy /api/proactive/* (ui/proactive.py) and /api/chat-stream/*
(ui/chat.py) routes have been removed — this is the only conversational
surface.

AgentRunWorker drives every agent_kind through chat /agent/chat (which picks the
agent by session_key prefix) and persists turns to pai_chat_messages. chat never
reads the DB; the LiteLLM key rides the per-run EdDSA JWT (trust boundary).
regenerate / edit run under the actor model via history pop+rewrite (the worker
mirrors the chat-side checkpoint surgery).
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import AsyncIterator
from typing import Any, Literal, cast, get_args

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from psycopg.types.json import Jsonb

from ...agent_core.mailbox import MailboxRepository
from ...agent_core.runs import RunRepository
from ...auth.deps import User, current_user, get_pool
from ...db.repositories.chat_messages import ChatMessagesRepository
from ...db.repositories.chat_threads import ChatThreadsRepository, ThreadKind
from ...db.rls import user_scoped_tx
from ...services.chat_proxy import call_chat_history

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/conversation", tags=["conversation"])

_CARD_THREAD_PREFIX = "card-thread-"
# Lazy-backfill cap for a thread that predates pai_chat_messages: how many of
# its newest checkpoint turns to seed on first read.
_BACKFILL_LIMIT = 500

# session_key kind → the actor-kernel agent_kind the worker routes/accounts on.
# chat /agent/chat independently re-derives the agent from the session_key
# prefix; this mapping is what the worker stamps on the Session + Run rows.
_AGENT_KIND_BY_THREAD: dict[ThreadKind, str] = {
    "main": "main_chat",
    "card": "card_execution",
    "proactive": "proactive",
}

_DecisionT = Literal["approve", "reject", "edit", "respond"]
_VALID_DECISIONS = get_args(_DecisionT)


def _classify(session_key: str, user_id: int) -> tuple[ThreadKind, str | None]:
    """Map a session_key to (kind, card_id), enforcing it belongs to this user.

    Shapes (one per conversational agent):
      * proactive-<user_id>      → the user's proactive thread
      * card-thread-<card_id>    → a card execution / feedback thread
      * main-<user_id>-<rand>    → the user's main chat singleton

    Cross-user isolation: main + proactive encode the owner in the key (prefix
    check here). card carries only a card_id, so the caller additionally
    verifies card ownership via pai_pipeline_runs (chat checkpoints have no RLS,
    so a forged card-thread-<id> must be rejected before it's driven)."""
    if session_key.startswith(_CARD_THREAD_PREFIX):
        card_id = session_key[len(_CARD_THREAD_PREFIX) :]
        if not card_id:
            raise HTTPException(status_code=400, detail="empty card_id in session_key")
        return "card", card_id
    if session_key == f"proactive-{user_id}":
        return "proactive", None
    main_prefix = f"main-{user_id}-"
    if session_key.startswith(main_prefix) and len(session_key) > len(main_prefix):
        return "main", None
    raise HTTPException(
        status_code=400,
        detail=(
            "session_key must be 'card-thread-<id>', 'proactive-<your_id>', "
            "or 'main-<your_id>-<rand>'"
        ),
    )


async def _assert_card_owned(card_id: str, user_id: int, conn: Any) -> None:
    """Verify a card was generated for this user before its thread is driven
    (RLS-scoped containment on pai_pipeline_runs.final_cards). Must run inside a
    user_scoped_tx for user_id."""
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT 1 FROM pai_pipeline_runs WHERE user_id = %s AND final_cards @> %s LIMIT 1",
            (user_id, Jsonb([{"id": card_id}])),
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=403, detail="card does not belong to this user")


async def _resolve_owned(
    session_key: str, user_id: int, conn: Any
) -> tuple[ThreadKind, str | None]:
    """_classify + card-ownership check (403 if a card-thread isn't this user's),
    then an idempotent thread-metadata insert. Returns (kind, card_id). Must run
    inside a user_scoped_tx for user_id."""
    kind, card_id = _classify(session_key, user_id)
    if kind == "card":
        assert card_id is not None  # _classify guarantees non-empty for card
        await _assert_card_owned(card_id, user_id, conn)
    await ChatThreadsRepository(user_id, conn).insert_thread(
        thread_id=session_key, kind=kind, card_id=card_id
    )
    return kind, card_id


@router.post("/init")
async def init(
    body: dict,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict[str, Any]:
    """Resolve the session_key for a conversational agent + report whether it
    already has history.

      * body.session_key explicit → validate ownership, ensure metadata row.
      * body.card_id → derive card-thread-<card_id> (card chat first-open).
      * body.kind == 'proactive' → the user's proactive thread
        (proactive-<user_id>; the FE can't know user_id, so it asks by kind).
      * neither → the user's singleton main thread (recover the most-recent,
        else mint main-<user_id>-<rand>; one-thread-per-user, migration 053)."""
    explicit = (body.get("session_key") or "").strip()
    card_id_hint = (body.get("card_id") or "").strip()
    kind_hint = (body.get("kind") or "").strip()
    if explicit:
        session_key = explicit
    elif card_id_hint:
        session_key = f"{_CARD_THREAD_PREFIX}{card_id_hint}"
    elif kind_hint == "proactive":
        session_key = f"proactive-{user.id}"
    else:
        async with user_scoped_tx(pool, user.id) as conn:
            existing_id = await ChatThreadsRepository(user.id, conn).get_latest_main_thread_id()
        session_key = existing_id or f"main-{user.id}-{uuid.uuid4().hex[:12]}"

    async with user_scoped_tx(pool, user.id) as conn:
        kind, _card_id = await _resolve_owned(session_key, user.id, conn)
        # `existing` decides whether the FE lands on the conversation surface
        # or the empty-state entry. True when the thread has persisted turns OR
        # an in-flight one (active run / unconsumed mailbox rows): finalize
        # writes history rows only at turn END, so a refresh mid-first-turn
        # must still land in the conversation, where /history's `active`
        # rebuilds the in-flight turn.
        latest = await ChatMessagesRepository(user.id, conn).latest_id(thread_id=session_key)
        existing = latest is not None
        if not existing:
            existing = await RunRepository(user.id, conn).get_active(
                session_id=session_key
            ) is not None or bool(
                await MailboxRepository(user.id, conn).peek_pending(session_id=session_key)
            )
    return {"sessionKey": session_key, "kind": kind, "existing": existing}


@router.post("/send", status_code=status.HTTP_202_ACCEPTED)
async def send(
    body: dict,
    request: Request,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict[str, Any]:
    """Enqueue a user message onto the session mailbox. The reply streams back
    over /stream (not this response). `cardContext` (optional) rides along for a
    card / feedback turn — chat injects it as a <card_context> SystemMessage."""
    session_key = (body.get("session_key") or "").strip()
    if not session_key:
        raise HTTPException(status_code=400, detail="session_key required")
    regenerate = bool(body.get("regenerate"))
    # regenerate (Retry / Edit) re-runs the last turn; `message` is the (possibly
    # edited) trailing user text — pure-rerun may echo the last user text or omit
    # it, so message is optional when regenerating.
    message = (body.get("message") or "").strip()
    if not message and not regenerate:
        raise HTTPException(status_code=400, detail="message required")
    card_context = body.get("cardContext")
    if card_context is not None and not isinstance(card_context, dict):
        raise HTTPException(status_code=400, detail="cardContext must be an object")

    async with user_scoped_tx(pool, user.id) as conn:
        kind, _card_id = await _resolve_owned(session_key, user.id, conn)

    meta: dict[str, Any] = {}
    if card_context:
        meta["card_context"] = card_context
    if regenerate:
        meta["regenerate"] = True
    await request.app.state.agent_service.post_message(
        session_key,
        user_id=user.id,
        agent_kind=_AGENT_KIND_BY_THREAD[kind],
        source="user",
        content=message or None,
        meta=meta or None,
    )
    # Best-effort thread-list freshness; never blocks the send.
    try:
        async with user_scoped_tx(pool, user.id) as conn:
            await ChatThreadsRepository(user.id, conn).bump_after_send(thread_id=session_key)
    except Exception:
        logger.exception("bump_after_send failed user=%d thread=%s", user.id, session_key)
    return {"ok": True}


@router.post("/decision")
async def decision(
    body: dict,
    request: Request,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict[str, Any]:
    """HITL: resolve a paused tool call. The agent pauses on a side-effect tool
    (a `chat:requires_action` frame on /stream); the user's approve / reject /
    edit / respond rides back through the mailbox and resumes the run via
    Command(resume=) on the same thread. `toolUseId` is the interrupt id from
    the frame (matched against the awaiting run's pending_action)."""
    session_key = (body.get("session_key") or "").strip()
    tool_use_id = (body.get("toolUseId") or "").strip()
    decision_val = (body.get("decision") or "").strip()
    if not session_key or not tool_use_id:
        raise HTTPException(status_code=400, detail="session_key + toolUseId required")
    if decision_val not in _VALID_DECISIONS:
        raise HTTPException(status_code=400, detail="decision must be approve/reject/edit/respond")
    message = body.get("message")
    if message is not None and not isinstance(message, str):
        raise HTTPException(status_code=400, detail="message must be a string")

    async with user_scoped_tx(pool, user.id) as conn:
        kind, _card_id = await _resolve_owned(session_key, user.id, conn)
    await request.app.state.agent_service.submit_decision(
        session_key,
        user_id=user.id,
        agent_kind=_AGENT_KIND_BY_THREAD[kind],
        tool_use_id=tool_use_id,
        # Validated against _VALID_DECISIONS above — cast narrows str → Literal.
        decision=cast(_DecisionT, decision_val),
        message=message,
    )
    return {"ok": True}


@router.post("/cancel")
async def cancel(
    body: dict,
    request: Request,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict[str, Any]:
    """Stop the session's in-flight turn (idempotent — no-op if nothing runs)."""
    session_key = (body.get("session_key") or "").strip()
    if not session_key:
        raise HTTPException(status_code=400, detail="session_key required")
    async with user_scoped_tx(pool, user.id) as conn:
        await _resolve_owned(session_key, user.id, conn)
    await request.app.state.agent_service.cancel(session_key, user_id=user.id)
    return {"ok": True}


@router.get("/stream")
async def stream(
    request: Request,
    session: str = Query(..., min_length=1, max_length=200),
    last_event_id: str | None = Query(default=None, alias="lastEventId"),
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> StreamingResponse:
    """Live, resumable event stream for a session (read via fetch +
    ReadableStream; EventSource can't send the Authorization header).

    Each frame carries its Redis Stream entry id as the SSE `id:` line. The
    client echoes the last one back as `?lastEventId=` on reconnect and we
    replay every frame after it (then tail) — a dropped stream (the old
    keepalive self-disconnect, a network blip, a fly restart) loses nothing.
    No cursor (first connect) tails from now; the client's past loads from
    /history. A cursor pointing at an expired stream (TTL elapsed) can never
    catch up, so we emit `conversation:resync` to make the client refetch
    history + reconnect fresh. Multi-instance safe: the frames live in Redis,
    not this process, so the worker need not run on this web instance."""
    service = request.app.state.agent_service
    async with user_scoped_tx(pool, user.id) as conn:
        await _resolve_owned(session, user.id, conn)

    async def gen() -> AsyncIterator[bytes]:
        # Initial event so the client flips to "connected" on an idle stream.
        hello = json.dumps({"type": "conversation:hello", "ts": 0, "data": {"sessionKey": session}})
        yield f"data: {hello}\n\n".encode()
        # Stale-cursor guard: a reconnect whose cursor's stream has expired can
        # never catch up — tell the client to resync from history.
        if last_event_id and not await service.stream_exists(session):
            resync = json.dumps({"type": "conversation:resync", "ts": 0, "data": {}})
            yield f"data: {resync}\n\n".encode()
        # "$" = tail from now (first connect); a concrete id = replay-then-tail.
        start = last_event_id or "$"
        async for item in service.subscribe(session, last_id=start):
            if item is None:
                yield b": ping\n\n"  # XREAD BLOCK window elapsed — keepalive, stream stays open
                continue
            entry_id, frame = item
            data = json.dumps(frame, ensure_ascii=False)
            yield f"id: {entry_id}\ndata: {data}\n\n".encode()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _row_to_message(row: dict[str, Any]) -> dict[str, Any]:
    """A pai_chat_messages row → the frontend HistoryMessage shape. `trigger`
    rides along so the proactive page can mark tick-triggered assistant turns
    (absent / 'user' for main + card)."""
    out: dict[str, Any] = {"id": str(row["id"]), "role": row["role"], "parts": row["parts"]}
    trigger = row.get("trigger")
    if trigger and trigger != "user":
        out["trigger"] = trigger
    created = row.get("created_at")
    if created is not None:
        out["createdAt"] = int(created.timestamp() * 1000)
    return out


async def _replay_cursor(service: Any, session: str, run_id: str) -> str | None:
    """Stream cursor to replay the in-flight run's frames from: the entry id
    just BEFORE the run's first frame (chat stamps every frame's traceId with
    the run id), so an XREAD from it replays the WHOLE turn — thinking /
    deltas / tools — while skipping frames of already-finished turns (those
    are in pai_chat_messages). None when the run has no frames yet (just
    claimed — the live tail carries them as they come)."""
    cursor = "0"
    for entry_id, frame in await service.stream_history(session):
        if frame.get("traceId") == run_id:
            return cursor
        cursor = entry_id
    return None


@router.get("/history")
async def history(
    request: Request,
    session: str = Query(..., min_length=1, max_length=200),
    before: int | None = Query(default=None, ge=1),
    limit: int = Query(default=50, ge=1, le=200),
    include_debug: bool = Query(default=False),
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict[str, Any]:
    """One page of the session's persisted turns from pai_chat_messages, read
    newest-first then reversed to oldest-first. `before` is the load-older
    cursor (a row id). A thread that predates the table lazily backfills once
    from the chat checkpoint (aget_state) then serves O(page) from the table.

    `include_debug` mirrors the proactive Debug toggle: false (default) hides
    heartbeat input rows + 'silent' tick turns so the page matches the non-Debug
    live view; true returns the full proactive transcript. A no-op for main /
    card threads (they have no debug-only rows)."""
    async with user_scoped_tx(pool, user.id) as conn:
        await _resolve_owned(session, user.id, conn)
        repo = ChatMessagesRepository(user_id=user.id, conn=conn)
        if before is None and await repo.latest_id(thread_id=session) is None:
            # Backfill seeds a pre-actor thread's history from the chat
            # checkpoint ONCE. Skip it while a run is active: the worker is
            # mid-turn and writes this turn to pai_chat_messages itself, so
            # backfilling from the in-progress checkpoint would double-write the
            # user turn (call_chat_history reads the HumanMessage the agent
            # already received; _finalize_turn then appends it again). A
            # finished run committed its turns in the same tx as the status
            # flip, so latest_id is non-None and we never reach here.
            active_run = await RunRepository(user.id, conn).get_active(session_id=session)
            if active_run is None:
                backfilled = await call_chat_history(user_id=user.id, session_key=session)
                if backfilled:
                    await repo.bulk_append(thread_id=session, turns=backfilled)
        rows = await repo.get_page(
            thread_id=session, before_id=before, limit=limit, include_debug=include_debug
        )
        # Newest page (connect / refresh) surfaces a paused HITL run so the FE
        # can rebuild the approval gate — /stream is live-only and never replays
        # the requires_action frame. Older pages (before set) skip it: the gate
        # is current state, not history.
        awaiting: dict[str, Any] | None = None
        active: dict[str, Any] | None = None
        if before is None:
            run = await RunRepository(user.id, conn).get_awaiting(session_id=session)
            pa = run.pending_action if run else None
            if pa and pa.get("interrupt_id"):
                awaiting = {
                    "toolUseId": pa["interrupt_id"],
                    "toolName": pa.get("tool_name") or "tool",
                    "argsPreview": pa.get("args_preview"),
                    "allowedDecisions": pa.get("allowed_decisions") or [],
                    # The reasoning / tool-call parts the agent streamed BEFORE
                    # the interrupt. They're NOT in pai_chat_messages yet (they
                    # land on resume via _finalize_turn), so a refresh would
                    # otherwise show the gate with the in-progress turn wiped.
                    # Same shape as a history message's parts.
                    "partialParts": pa.get("partial_parts") or [],
                }
            else:
                # No paused run. An in-flight turn isn't in pai_chat_messages
                # yet (finalize writes it on completion), so a refresh would
                # show a blank where it should be. Rebuild it from the two
                # durable sources: the unconsumed mailbox rows ARE the user
                # text(s) (consume-on-completion — they stay pending until the
                # turn finalizes, covering the sent-but-not-yet-claimed window
                # too), and the Redis stream gives the cursor to replay the
                # agent's frames from. A regenerate message renders no bubble —
                # its user turn is already in history.
                pending = await MailboxRepository(user.id, conn).peek_pending(session_id=session)
                user_texts = [
                    m.content
                    for m in pending
                    if m.source == "user" and m.content and not (m.meta or {}).get("regenerate")
                ]
                running = await RunRepository(user.id, conn).get_active(session_id=session)
                if running is not None and running.status == "running":
                    active = {
                        "userTexts": user_texts,
                        "replayFrom": await _replay_cursor(
                            request.app.state.agent_service, session, running.id
                        ),
                    }
                elif user_texts:
                    # Sent but not yet claimed (no run row): show the user
                    # bubble(s); the turn's frames arrive on the live tail
                    # once the worker picks it up.
                    active = {"userTexts": user_texts, "replayFrom": None}
    next_cursor = rows[-1]["id"] if len(rows) == limit else None
    messages = [_row_to_message(r) for r in reversed(rows)]
    return {
        "messages": messages,
        "nextCursor": next_cursor,
        "awaiting": awaiting,
        "active": active,
    }
