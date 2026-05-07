"""web → chat HTTP proxy + SSE pipe-through.

Frontend hits /api/chat-stream/send on web (Supabase JWT). web:
  1. resolves to BIGINT user_id
  2. signs an HS256 agent run JWT
  3. POST chat-worker:8001/agent/chat with JWT in Authorization
  4. streams the chat worker's SSE response back to the client byte-for-byte

Until Step F-1 introduces a chat /run endpoint, we forward to the legacy
/agent/chat path that's already serving SSE.
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import HTTPException, status

from ..auth.agent_jwt import sign_agent_run_jwt

logger = logging.getLogger(__name__)


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
) -> AsyncIterator[bytes]:
    """Forward to chat worker /agent/chat and yield SSE bytes back.

    Caller (route handler) wraps the returned iterator in a
    StreamingResponse(media_type="text/event-stream"). The user's LiteLLM
    `virtual_key` and Browserbase `bbctx` ride in the JWT claims so the
    chat worker process never needs DB access for these.
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
    }
    url = f"{_chat_internal_url()}/agent/chat"

    timeout = httpx.Timeout(connect=5.0, read=600.0, write=10.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            async with client.stream(
                "POST", url,
                json=body,
                headers={"Authorization": f"Bearer {token}", "X-Run-Id": run_id},
            ) as resp:
                if resp.status_code >= 400:
                    payload = await resp.aread()
                    logger.warning(
                        "chat worker returned %d for run=%s body=%r",
                        resp.status_code, run_id, payload[:300],
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
                url, params={"session_key": session_key},
                headers={"Authorization": f"Bearer {token}", "X-Run-Id": run_id},
            )
        except httpx.RequestError as e:
            logger.warning("chat /exists unreachable run=%s: %s", run_id, e)
            return False
    if resp.status_code >= 400:
        logger.warning(
            "chat /exists returned %d for run=%s body=%r",
            resp.status_code, run_id, resp.text[:200],
        )
        return False
    return bool(resp.json().get("existing", False))


async def call_chat_history(
    *, user_id: int, session_key: str,
) -> list[dict[str, Any]]:
    """One-shot proxy to chat worker /agent/chat/history.

    Returns the merged turn list in frontend HistoryMessage shape. Empty
    list on missing thread or 4xx. The chat worker is the only side that
    can read LangGraph's checkpoint table, so web cannot do this lookup
    itself — it has to forward.
    """
    token, run_id = sign_agent_run_jwt(user_id=user_id)
    url = f"{_chat_internal_url()}/agent/chat/history"
    timeout = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            resp = await client.get(
                url, params={"session_key": session_key},
                headers={"Authorization": f"Bearer {token}", "X-Run-Id": run_id},
            )
        except httpx.RequestError as e:
            logger.warning("chat /history unreachable run=%s: %s", run_id, e)
            return []
    if resp.status_code >= 400:
        logger.warning(
            "chat /history returned %d for run=%s body=%r",
            resp.status_code, run_id, resp.text[:200],
        )
        return []
    payload = resp.json()
    msgs = payload.get("messages")
    return msgs if isinstance(msgs, list) else []


async def call_generate(
    *,
    user_id: int,
    cards_to_generate: int,
    output_language: str,
    virtual_key: str,
    run_id: str | None = None,
) -> dict[str, Any]:
    """One-shot proxy to chat worker /agent/generate. JSON in / JSON out.

    Same virtual_key-via-JWT pattern as stream_chat — the worker reads
    `vk` off the verified principal, so the body stays free of credentials.

    If `run_id` is given, the chat worker uses it instead of generating
    its own — so the dispatcher can keep one stable id from
    pai_scheduled_tasks → pai_scheduled_task_runs → pai_pipeline_runs.
    Sync /api/generate callers leave it None and accept the chat
    worker's own id (legacy behavior).
    """
    token, jwt_run_id = sign_agent_run_jwt(
        user_id=user_id, virtual_key=virtual_key, run_id=run_id,
    )
    # Outbound run_id for tracing headers / fallback if chat doesn't echo it.
    outbound_run_id = run_id or jwt_run_id
    body: dict[str, Any] = {
        "cards_to_generate": cards_to_generate,
        "output_language": output_language,
    }
    if run_id is not None:
        body["run_id"] = run_id
    url = f"{_chat_internal_url()}/agent/generate"
    timeout = httpx.Timeout(connect=5.0, read=600.0, write=10.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            resp = await client.post(
                url, json=body,
                headers={"Authorization": f"Bearer {token}", "X-Run-Id": outbound_run_id},
            )
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
