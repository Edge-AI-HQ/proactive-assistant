"""/api/agent/composio/* — agent-side Composio access.

Two endpoint groups:

  Native path (chat process forwards Composio meta-tool calls):
    POST /meta/SEARCH_TOOLS         → session.execute("COMPOSIO_SEARCH_TOOLS", ...)
    POST /meta/GET_TOOL_SCHEMAS     → session.execute("COMPOSIO_GET_TOOL_SCHEMAS", ...)
    POST /meta/MULTI_EXECUTE_TOOL   → session.execute("COMPOSIO_MULTI_EXECUTE_TOOL", ...)
    POST /meta/MANAGE_CONNECTIONS   → session.execute("COMPOSIO_MANAGE_CONNECTIONS", ...)

  SDK code-mode path (sandbox `client.composio.*` calls):
    GET  /connections               → list_connections
    POST /search                    → search_tools
    GET  /schema/{slug}             → get_tool_schema
    POST /execute                   → execute(slug, args, ...)
    POST /multi_execute             → multi_execute(calls)

Both groups authenticate via the agent-run JWT (chat) or phantom token
(sandbox); the JWT carries `user_id` so the underlying service knows
whose Composio account to target.

Side-effect gate: deferred. The plan currently relies on session
`tools=` allowlist as the physical guard; per-call HITL approval is
TBD pending DeepAgents permission middleware integration.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field

from ... import composio_service as cs
from ...auth.deps import AgentRun, current_agent_run

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/agent/composio", tags=["agent-composio"])


# Whitelist of Composio meta-tool slugs we forward. Anything else 404s
# rather than letting an arbitrary slug reach the session.execute path
# (defense against the LLM hallucinating a slug into the URL).
_ALLOWED_META_TOOLS = frozenset({
    "SEARCH_TOOLS",
    "GET_TOOL_SCHEMAS",
    "MULTI_EXECUTE_TOOL",
    "MANAGE_CONNECTIONS",
    # REMOTE_WORKBENCH / REMOTE_BASH_TOOL deliberately omitted: agents
    # already have a Daytona sandbox; introducing a second one would
    # confuse the runtime. Re-enable behind a flag if needed.
})


def _map_error(e: cs.ComposioError) -> HTTPException:
    """4xx → 4xx; 5xx → 502 ("downstream"). 0 → 503 (config issue)."""
    if e.status_code == 0:
        return HTTPException(status_code=503, detail=str(e))
    if 400 <= e.status_code < 500:
        return HTTPException(status_code=e.status_code, detail=str(e))
    return HTTPException(status_code=502, detail=str(e))


# ── Native path: meta-tool forwarding ──────────────────────────────────


class _MetaCallBody(BaseModel):
    args: dict[str, Any] = Field(default_factory=dict)
    toolkits: list[str] | None = None  # filter session at create time
    tools: list[str] | None = None      # slug allowlist


@router.post("/meta/{tool_name}")
async def meta_call(
    tool_name: str,
    body: _MetaCallBody = Body(default_factory=_MetaCallBody),
    run: AgentRun = Depends(current_agent_run),
) -> dict[str, Any]:
    """Forward one Composio meta-tool call through the user's Tool
    Router session. The session is created (or reused from cache) on
    first call; subsequent calls reuse it for the chat thread.
    """
    if tool_name not in _ALLOWED_META_TOOLS:
        raise HTTPException(
            status_code=404,
            detail=f"unknown meta tool: {tool_name}",
        )
    composio_slug = f"COMPOSIO_{tool_name}"
    try:
        return await cs.execute_meta_tool(
            run.user_id, composio_slug, body.args,
            toolkits=body.toolkits, tools=body.tools,
        )
    except cs.ComposioError as e:
        raise _map_error(e) from e


# ── SDK direct path ────────────────────────────────────────────────────


@router.get("/connections")
async def list_connections(
    run: AgentRun = Depends(current_agent_run),
) -> dict[str, Any]:
    try:
        items = await cs.list_connections(run.user_id)
    except cs.ComposioError as e:
        raise _map_error(e) from e
    return {"items": [c.model_dump() for c in items]}


class _SearchBody(BaseModel):
    query: str
    toolkit: str | None = None
    limit: int = Field(default=10, ge=1, le=50)


@router.post("/search")
async def search_tools(
    body: _SearchBody,
    run: AgentRun = Depends(current_agent_run),
) -> dict[str, Any]:
    try:
        hits = await cs.search_tools(
            run.user_id, body.query, toolkit=body.toolkit, limit=body.limit,
        )
    except cs.ComposioError as e:
        raise _map_error(e) from e
    return {"items": [h.model_dump() for h in hits]}


@router.get("/schema/{slug}")
async def get_tool_schema(
    slug: str,
    run: AgentRun = Depends(current_agent_run),
) -> dict[str, Any]:
    _ = run  # reserved for future per-user filtering
    try:
        schema = await cs.get_tool_schema(slug)
    except cs.ComposioError as e:
        raise _map_error(e) from e
    return schema.model_dump()


class _ExecuteBody(BaseModel):
    slug: str
    args: dict[str, Any] = Field(default_factory=dict)
    connected_account_id: str | None = None


@router.post("/execute")
async def execute(
    body: _ExecuteBody,
    run: AgentRun = Depends(current_agent_run),
) -> dict[str, Any]:
    try:
        result = await cs.execute(
            run.user_id, body.slug, body.args,
            connected_account_id=body.connected_account_id,
        )
    except cs.ComposioError as e:
        raise _map_error(e) from e
    return result.model_dump()


class _MultiExecuteBody(BaseModel):
    calls: list[cs.ExecuteCall]
    parallelism: int = Field(default=8, ge=1, le=50)


@router.post("/multi_execute")
async def multi_execute(
    body: _MultiExecuteBody,
    run: AgentRun = Depends(current_agent_run),
) -> dict[str, Any]:
    try:
        results = await cs.multi_execute(
            run.user_id, body.calls, parallelism=body.parallelism,
        )
    except cs.ComposioError as e:
        raise _map_error(e) from e
    return {"results": [r.model_dump() for r in results]}
