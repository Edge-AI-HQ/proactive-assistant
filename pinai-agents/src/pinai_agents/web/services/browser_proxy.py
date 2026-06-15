"""web → chat proxy for browser endpoints.

SSE pipe-through for `/api/browser/events`; one-shot JSON for the REST
control surface. Mirrors `chat_proxy.py` — same JWT pattern, same
chat-internal URL.
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import HTTPException, status
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from ..auth.agent_jwt import sign_agent_run_jwt
from ..db.rls import service_tx

logger = logging.getLogger(__name__)


def _chat_internal_url() -> str:
    return os.environ.get("CHAT_INTERNAL_URL", "http://pinai-chat:8001")


async def stream_browser_events(
    *,
    user_id: int,
    session_key: str,
) -> AsyncIterator[bytes]:
    token, run_id = sign_agent_run_jwt(user_id=user_id)
    url = f"{_chat_internal_url()}/agent/browser/events"
    # Long-lived: keep `read` very large; chat heartbeats every 25s.
    timeout = httpx.Timeout(connect=5.0, read=None, write=10.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            async with client.stream(
                "GET",
                url,
                params={"sessionKey": session_key},
                headers={"Authorization": f"Bearer {token}", "X-Run-Id": run_id},
            ) as resp:
                if resp.status_code >= 400:
                    payload = await resp.aread()
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail=f"chat browser SSE {resp.status_code}: {payload[:200].decode(errors='replace')}",
                    )
                async for chunk in resp.aiter_bytes():
                    if chunk:
                        yield chunk
        except httpx.RequestError as e:
            logger.exception("browser SSE unreachable run=%s", run_id)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"chat worker unreachable: {type(e).__name__}: {e}",
            ) from e


async def proxy_browser_action(
    *,
    user_id: int,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Forward a one-shot REST call. `path` is the chat-side suffix
    (e.g. `/agent/browser/sessions/{key}/control`)."""
    token, run_id = sign_agent_run_jwt(user_id=user_id)
    url = f"{_chat_internal_url()}{path}"
    timeout = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            resp = await client.request(
                method,
                url,
                json=body,
                headers={"Authorization": f"Bearer {token}", "X-Run-Id": run_id},
            )
        except httpx.RequestError as e:
            logger.exception("browser action %s %s unreachable run=%s", method, path, run_id)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"chat worker unreachable: {type(e).__name__}: {e}",
            ) from e
    if resp.status_code >= 400:
        # Surface chat-side validation errors verbatim so the frontend can
        # tell "session not found" (404) from "bad input" (400).
        try:
            payload = resp.json()
        except Exception:
            payload = {"error": resp.text[:200]}
        raise HTTPException(status_code=resp.status_code, detail=payload)
    return resp.json()


async def clear_site_cookies(
    *,
    pool: AsyncConnectionPool,
    user_id: int,
    site_domain: str,
) -> None:
    """Clear one site's cookies/storage from the user's persistent
    Browserbase context. Chat opens a throwaway session bound to the
    context (persist:True), runs CDP `Storage.clearDataForOrigin`, and
    releases — so the deletion is written back to the context. No-op if the
    user has no context yet (nothing to clear).

    The `bbctx` claim lets chat resolve the context without DB access
    (trust boundary). context_id is read via service_tx (bypasses RLS —
    same posture as worker._user_keys)."""
    async with service_tx(pool) as conn, conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(
            "SELECT browserbase_context_id FROM users WHERE id = %s",
            (user_id,),
        )
        row = await cur.fetchone()
    context_id = row["browserbase_context_id"] if row else None
    if not context_id:
        return
    token, run_id = sign_agent_run_jwt(user_id=user_id, browserbase_context_id=context_id)
    url = f"{_chat_internal_url()}/agent/browser/context/clear-site"
    # Clearing opens a fresh (cold) Browserbase session — allow a longer read.
    timeout = httpx.Timeout(connect=5.0, read=45.0, write=5.0, pool=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            resp = await client.post(
                url,
                json={"siteDomain": site_domain},
                headers={"Authorization": f"Bearer {token}", "X-Run-Id": run_id},
            )
        except httpx.RequestError as e:
            logger.exception("clear-site unreachable run=%s", run_id)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"chat worker unreachable: {type(e).__name__}: {e}",
            ) from e
    if resp.status_code >= 400:
        try:
            payload = resp.json()
        except Exception:
            payload = {"error": resp.text[:200]}
        raise HTTPException(status_code=resp.status_code, detail=payload)
