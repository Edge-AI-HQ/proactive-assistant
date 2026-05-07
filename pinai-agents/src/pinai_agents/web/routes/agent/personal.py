"""/api/agent/personal/* — agent-side Composio access.

Two endpoints:
  GET  /connections — list ACTIVE connected accounts (gmail / gcal / etc)
  POST /exec        — execute a Composio tool against one of those accounts.

No server-side verb gating: the agent loop drives Composio directly and
we trust Composio's own auth / scopes for what is or isn't allowed.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException

from ....config import get_web_settings
from ...auth.deps import AgentRun, current_agent_run
from ...composio import (
    ComposioError,
    composio_user_id,
    list_connections,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/agent/personal", tags=["agent-personal"])


def _api_key() -> str:
    s = get_web_settings()
    if not s.composio_api_key:
        raise HTTPException(
            status_code=400, detail="COMPOSIO_API_KEY not configured",
        )
    return s.composio_api_key


@router.get("/connections")
async def connections(run: AgentRun = Depends(current_agent_run)):
    """List the user's ACTIVE Composio connections — same shape as
    /api/composio/connections, just authed via agent JWT instead of
    Supabase JWT."""
    api_key = _api_key()
    try:
        items = await list_connections(api_key, run.user_id)
    except ComposioError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {"items": items}


@router.post("/exec")
async def exec_tool(
    body: dict, run: AgentRun = Depends(current_agent_run),
):
    """Execute a Composio tool. Body shape:
        { "tool": "GMAIL_LIST_THREADS", "args": {...} }
    """
    tool = str(body.get("tool") or "").strip()
    if not tool:
        raise HTTPException(status_code=400, detail="tool required")
    args = body.get("args")
    if args is not None and not isinstance(args, dict):
        raise HTTPException(status_code=400, detail="args must be an object")

    api_key = _api_key()
    user_id = composio_user_id(run.user_id)
    # Composio v3 actions/{slug}/execute is the canonical path. v2 fallback
    # (/actions/{slug}/execute on /api/v2) covers older deployments where
    # v3 returns 404 for legacy tools — same path shape, different base.
    try:
        result = await _execute(api_key, tool, user_id, args or {})
    except ComposioError as e:
        # 4xx → surface to agent so it can adjust args. 5xx → 502 for the
        # caller, signaling "downstream broken, retry won't help".
        if 400 <= e.status_code < 500:
            raise HTTPException(status_code=e.status_code, detail=str(e)) from e
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {"tool": tool, "result": result}


async def _execute(
    api_key: str, slug: str, entity_id: str, args: dict[str, Any],
) -> Any:
    """Composio /actions/{slug}/execute. Defaults to v3; falls back to v2
    on 404 because some legacy connectors haven't been migrated. Composio
    namespacing of the user happens via `entityId`."""
    body = {"entityId": entity_id, "input": args}
    headers = {"Content-Type": "application/json", "x-api-key": api_key}
    timeout = httpx.Timeout(connect=5.0, read=60.0, write=10.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout) as cli:
        resp = await cli.post(
            f"https://backend.composio.dev/api/v3/actions/{slug}/execute",
            json=body, headers=headers,
        )
        if resp.status_code == 404:
            resp = await cli.post(
                f"https://backend.composio.dev/api/v2/actions/{slug}/execute",
                json=body, headers=headers,
            )
    if not resp.is_success:
        try:
            payload = resp.json()
            msg = str(payload.get("message") or payload.get("error") or resp.text[:200])
        except ValueError:
            msg = resp.text[:200]
        raise ComposioError(resp.status_code, msg)
    if not resp.text.strip():
        return None
    return resp.json()
