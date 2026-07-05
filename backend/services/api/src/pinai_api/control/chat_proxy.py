"""web → chat one-shot HTTP proxies.

The conversation path (/api/conversation/*) drives chat through
execution_client.py (ChatRunClient); this module holds the remaining
one-shot proxies web needs: history reads (conversation backfill + the
proactive page) and the generator call. Each signs a per-call EdDSA agent
run JWT — chat never reads the DB.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime
from typing import Any

import httpx
from fastapi import HTTPException, status

from pinai_api.config import get_web_settings

from ..platform.auth.agent_jwt import sign_agent_run_jwt

logger = logging.getLogger(__name__)


def _chat_internal_url() -> str:
    """Step C default. Step F+: WEB_INTERNAL_URL / CHAT_INTERNAL_URL split."""
    return os.environ.get("CHAT_INTERNAL_URL", "http://agent-engine:8001")


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
    focus: str | None = None,
    anchor: datetime | None = None,
    cache_ttl: str | None = None,
    generation_request: dict[str, Any] | None = None,
    timezone: str | None = None,
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
    if focus:
        body["focus"] = focus
    if anchor is not None:
        # Per-user context anchor (design §4.2) — the engine rebuilds the
        # cache-stable arrival log deterministically from it.
        body["anchor"] = anchor.isoformat()
    if cache_ttl:
        body["cache_ttl"] = cache_ttl
    if generation_request is not None:
        body["generation_request"] = generation_request
    if timezone:
        # Profile timezone → chat computes "Today is …" as the user-local
        # date instead of bare UTC.
        body["timezone"] = timezone
    url = f"{_chat_internal_url()}/agent/generate"
    # +30s over the chat-side guard so chat's own 504 (with run context)
    # arrives before this read timeout severs the connection.
    read_timeout_seconds = get_web_settings().generate_timeout_seconds + 30.0
    timeout = httpx.Timeout(
        connect=5.0,
        read=read_timeout_seconds,
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
                int(read_timeout_seconds),
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=(
                    "chat worker timed out after "
                    f"{int(read_timeout_seconds)}s waiting for /agent/generate"
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
