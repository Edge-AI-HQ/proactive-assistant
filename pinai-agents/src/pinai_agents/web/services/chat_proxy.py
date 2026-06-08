"""web → chat HTTP proxy + SSE pipe-through.

Used by the legacy /api/chat-stream/* routes (ui/chat.py, slated for removal);
the new /api/conversation/* path drives chat through agent_core/client.py
instead, and only reuses call_chat_history() here for history backfill.

stream_chat flow — web takes a Supabase-authenticated request and:
  1. resolves to BIGINT user_id
  2. signs an EdDSA agent run JWT
  3. POST chat:8001/agent/chat with JWT in Authorization
  4. streams the chat worker's SSE response back to the client byte-for-byte
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any

import httpx
from fastapi import HTTPException, status

from ..auth.agent_jwt import sign_agent_run_jwt

logger = logging.getLogger(__name__)

_GENERATE_READ_TIMEOUT_SECONDS = 600.0


def _chat_internal_url() -> str:
    """Step C default. Step F+: WEB_INTERNAL_URL / CHAT_INTERNAL_URL split."""
    return os.environ.get("CHAT_INTERNAL_URL", "http://pinai-chat:8001")


async def stream_chat(
    *,
    user_id: int,
    session_key: str,
    message: str,
    card_context: dict[str, Any] | None,
    virtual_key: str,
    browserbase_context_id: str | None = None,
    client_hints: dict[str, Any] | None = None,
    regenerate: bool = False,
) -> AsyncIterator[bytes]:
    """Forward to chat worker /agent/chat and yield SSE bytes back.

    Caller (route handler) wraps the returned iterator in a
    StreamingResponse(media_type="text/event-stream"). The user's LiteLLM
    `virtual_key` and Browserbase `bbctx` ride in the JWT claims so the
    chat worker process never needs DB access for these. `client_hints`
    is the frontend's device profile (viewport + mobile/tablet/desktop)
    — passed through to the chat worker which feeds it to BB session
    creation so mobile users get mobile-rendered pages.
    """
    token, run_id = sign_agent_run_jwt(
        user_id=user_id,
        virtual_key=virtual_key,
        browserbase_context_id=browserbase_context_id,
    )
    body: dict[str, Any] = {
        "session_key": session_key,
        "message": message,
        "card_context": card_context,
        "regenerate": regenerate,
    }
    if client_hints is not None:
        body["client_hints"] = client_hints
    url = f"{_chat_internal_url()}/agent/chat"

    timeout = httpx.Timeout(connect=5.0, read=600.0, write=10.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            async with client.stream(
                "POST",
                url,
                json=body,
                headers={"Authorization": f"Bearer {token}", "X-Run-Id": run_id},
            ) as resp:
                if resp.status_code >= 400:
                    payload = await resp.aread()
                    logger.warning(
                        "chat worker returned %d for run=%s body=%r",
                        resp.status_code,
                        run_id,
                        payload[:300],
                    )
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail=f"chat worker {resp.status_code}: {payload[:200].decode(errors='replace')}",
                    )
                async for chunk in resp.aiter_bytes():
                    if chunk:
                        yield chunk
        except httpx.RequestError as e:
            logger.exception("chat worker unreachable run=%s", run_id)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"chat worker unreachable: {type(e).__name__}: {e}",
            ) from e


async def call_chat_exists(*, user_id: int, session_key: str) -> bool:
    """One-shot proxy to chat worker /agent/chat/exists.

    Tells whether a LangGraph thread already has any persisted turn.
    Frontend uses this to decide whether to bootstrap a fresh card-chat
    session vs replay history. Returns False on any 4xx (e.g. checkpoint
    table missing in tests) so the caller treats it as a new thread.
    """
    token, run_id = sign_agent_run_jwt(user_id=user_id)
    url = f"{_chat_internal_url()}/agent/chat/exists"
    timeout = httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            resp = await client.get(
                url,
                params={"session_key": session_key},
                headers={"Authorization": f"Bearer {token}", "X-Run-Id": run_id},
            )
        except httpx.RequestError as e:
            logger.warning("chat /exists unreachable run=%s: %s", run_id, e)
            return False
    if resp.status_code >= 400:
        logger.warning(
            "chat /exists returned %d for run=%s body=%r",
            resp.status_code,
            run_id,
            resp.text[:200],
        )
        return False
    return bool(resp.json().get("existing", False))


async def call_chat_history(
    *,
    user_id: int,
    session_key: str,
) -> list[dict[str, Any]]:
    """One-shot proxy to chat worker /agent/chat/history.

    Returns the merged turn list in frontend HistoryMessage shape. Empty
    list on missing thread or 4xx. The chat worker is the only side that
    can read LangGraph's checkpoint table, so web cannot do this lookup
    itself — it has to forward.
    """
    token, run_id = sign_agent_run_jwt(user_id=user_id)
    url = f"{_chat_internal_url()}/agent/chat/history"
    # 60s read: a large thread's checkpoint aget_state rebuild can take tens
    # of seconds; 15s was timing out → silently returning [] (treated as "no
    # history", so backfill never wrote — plan 2026-06-01 §5.4). New turns are
    # seeded by /send's _persist_turn regardless, so this only widens the
    # one-shot legacy-thread backfill window.
    timeout = httpx.Timeout(connect=5.0, read=60.0, write=5.0, pool=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            resp = await client.get(
                url,
                params={"session_key": session_key},
                headers={"Authorization": f"Bearer {token}", "X-Run-Id": run_id},
            )
        except httpx.RequestError as e:
            logger.warning("chat /history unreachable run=%s: %s", run_id, e)
            return []
    if resp.status_code >= 400:
        logger.warning(
            "chat /history returned %d for run=%s body=%r",
            resp.status_code,
            run_id,
            resp.text[:200],
        )
        return []
    payload = resp.json()
    msgs = payload.get("messages")
    return msgs if isinstance(msgs, list) else []


class StaleCursorError(Exception):
    """The chat worker said our `before` cursor is no longer in the
    filtered list (thread mutated, debug-filter changed, etc.). Callers
    should surface this to the client as a 400 so the FE refetches the
    first page."""


_EMPTY_PROACTIVE_HISTORY: dict[str, Any] = {
    "messages": [],
    "hasMore": False,
    "oldestCursor": None,
}


async def call_proactive_history(
    *,
    user_id: int,
    session_key: str,
    include_debug: bool = False,
    before: str | None = None,
    limit: int = 200,
) -> dict[str, Any]:
    """Cursor-paginated proxy to chat worker /agent/chat/history, for the
    proactive page (separate from main chat's `call_chat_history`, which
    returns the bare list it has always returned).

    Forwards the cursor-pagination params and returns the worker's full
    payload (`{messages, hasMore, oldestCursor}`) so the web→FE chain
    preserves pagination state end-to-end. Raises `StaleCursorError` for a
    400 from the worker (cursor-out-of-window). Returns an empty payload on
    missing thread / other 4xx / connection failure.
    """
    token, run_id = sign_agent_run_jwt(user_id=user_id)
    url = f"{_chat_internal_url()}/agent/chat/history"
    params: dict[str, Any] = {"session_key": session_key, "limit": limit}
    if include_debug:
        params["include_debug"] = "1"
    if before:
        params["before"] = before
    timeout = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            resp = await client.get(
                url,
                params=params,
                headers={"Authorization": f"Bearer {token}", "X-Run-Id": run_id},
            )
        except httpx.RequestError as e:
            logger.warning("proactive /history unreachable run=%s: %s", run_id, e)
            return dict(_EMPTY_PROACTIVE_HISTORY)
    if resp.status_code == 400:
        detail = ""
        try:
            detail = resp.json().get("detail", "")
        except Exception:
            detail = resp.text[:200]
        raise StaleCursorError(detail or "stale cursor")
    if resp.status_code >= 400:
        logger.warning(
            "proactive /history returned %d for run=%s body=%r",
            resp.status_code,
            run_id,
            resp.text[:200],
        )
        return dict(_EMPTY_PROACTIVE_HISTORY)
    payload = resp.json()
    msgs = payload.get("messages")
    return {
        "messages": msgs if isinstance(msgs, list) else [],
        "hasMore": bool(payload.get("hasMore", False)),
        "oldestCursor": payload.get("oldestCursor"),
    }


async def call_generate(
    *,
    user_id: int,
    cards_to_generate: int,
    output_language: str,
    virtual_key: str,
    run_id: str | None = None,
    matched_patterns: list[dict[str, Any]] | None = None,
    context_since: datetime | None = None,
    context_until: datetime | None = None,
    generation_request: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One-shot proxy to chat worker /agent/generate. JSON in / JSON out.

    Same virtual_key-via-JWT pattern as stream_chat — the worker reads
    `vk` off the verified principal, so the body stays free of credentials.

    If `run_id` is given, the chat worker uses it instead of generating
    its own — so the dispatcher can keep one stable id from
    pai_scheduled_tasks → pai_scheduled_task_runs → pai_pipeline_runs.
    Sync /api/generate callers leave it None and accept the chat
    worker's own id (legacy behavior).

    `matched_patterns` is the web-side pattern matcher output (see
    docs/plans/2026-05-15-pattern-driven-card-generation.mdx Phase 2).
    Chat reads it from the payload; chat must NOT query the pattern DB.
    """
    token, jwt_run_id = sign_agent_run_jwt(
        user_id=user_id,
        virtual_key=virtual_key,
        run_id=run_id,
    )
    # Outbound run_id for tracing headers / fallback if chat doesn't echo it.
    outbound_run_id = run_id or jwt_run_id
    body: dict[str, Any] = {
        "cards_to_generate": cards_to_generate,
        "output_language": output_language,
    }
    if run_id is not None:
        body["run_id"] = run_id
    if matched_patterns:
        body["matched_patterns"] = matched_patterns
    if context_since is not None:
        body["context_since"] = context_since.isoformat()
    if context_until is not None:
        body["context_until"] = context_until.isoformat()
    if generation_request is not None:
        body["generation_request"] = generation_request
    url = f"{_chat_internal_url()}/agent/generate"
    timeout = httpx.Timeout(
        connect=5.0,
        read=_GENERATE_READ_TIMEOUT_SECONDS,
        write=10.0,
        pool=10.0,
    )
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            resp = await client.post(
                url,
                json=body,
                headers={"Authorization": f"Bearer {token}", "X-Run-Id": outbound_run_id},
            )
        except httpx.ReadTimeout as e:
            logger.exception(
                "generate worker timed out run=%s read_timeout_seconds=%d",
                outbound_run_id,
                int(_GENERATE_READ_TIMEOUT_SECONDS),
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=(
                    "chat worker timed out after "
                    f"{int(_GENERATE_READ_TIMEOUT_SECONDS)}s waiting for /agent/generate"
                ),
            ) from e
        except httpx.RequestError as e:
            logger.exception("generate worker unreachable run=%s", outbound_run_id)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"chat worker unreachable: {type(e).__name__}: {e}",
            ) from e
    if resp.status_code >= 400:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"generate worker {resp.status_code}: {resp.text[:200]}",
        )
    return resp.json()
