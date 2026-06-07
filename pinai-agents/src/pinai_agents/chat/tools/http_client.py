"""Shared httpx client for native tools to call web's /api/agent/*.

The chat process is the LLM loop's host — it must NOT hold service_role.
Native tools call back into web over HTTPS with the per-run EdDSA JWT
(verified by web's current_agent_run dependency).

One module-level AsyncClient with HTTP/2 + keep-alive for connection
reuse. Tool calls in a single chat turn share the connection pool.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

from ..harness.ctx import current_run_jwt

logger = logging.getLogger(__name__)


def _web_url() -> str:
    return os.environ.get("WEB_INTERNAL_URL", "http://pinai-web:8000")


# Module-level — process-wide client. Closed automatically on interpreter
# exit; we don't bother with explicit shutdown because chat is short-lived
# (per-request scope from web's perspective).
_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            base_url=_web_url(),
            timeout=httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=10.0),
            headers={"User-Agent": "pinai-chat-native-tool/0.1"},
        )
    return _client


def _auth_headers() -> dict[str, str]:
    jwt = current_run_jwt.get()
    if not jwt:
        msg = "current_run_jwt unset — call native tool inside run_context()"
        raise RuntimeError(msg)
    return {"Authorization": f"Bearer {jwt}"}


async def get(path: str, **params: Any) -> Any:
    """GET /api/agent/<path>?<params>. Returns parsed JSON. Strips Nones from params."""
    cleaned = {k: v for k, v in params.items() if v is not None}
    resp = await _get_client().get(path, params=cleaned, headers=_auth_headers())
    if resp.status_code >= 400:
        logger.warning("native tool GET %s → %d: %s", path, resp.status_code, resp.text[:200])
        return {"error": f"http_{resp.status_code}", "detail": resp.text[:500]}
    return resp.json()


async def post(path: str, body: dict[str, Any]) -> Any:
    resp = await _get_client().post(path, json=body, headers=_auth_headers())
    if resp.status_code >= 400:
        logger.warning("native tool POST %s → %d: %s", path, resp.status_code, resp.text[:200])
        return {"error": f"http_{resp.status_code}", "detail": resp.text[:500]}
    return resp.json()
