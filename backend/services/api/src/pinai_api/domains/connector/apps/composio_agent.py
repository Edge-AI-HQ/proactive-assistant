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

Side-effect gate (sandbox path): the SDK code-mode `/execute` and
`/multi_execute` routes below block side-effecting Composio slugs
(`is_side_effecting`, fail-closed by VERB). Sandbox scripts have no
interactive HITL, so a side-effecting tool must go through the native
COMPOSIO_MULTI_EXECUTE_TOOL meta-tool (human-gated in the engine).
Read-only slugs run freely.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from pinai_contracts.composio_policy import is_side_effecting
from pydantic import BaseModel, Field

from ....domains.billing.metering import (
    estimate_composio_tool_call_charge,
    record_provider_usage_charge,
)
from ....platform.auth.deps import AgentRun, current_agent_run, get_pool
from ....platform.auth.user_service import User, load_user_by_id
from . import composio_service as cs
from . import custom_mcp
from .raw_agent import raw_sources_for_composio_toolkit

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/agent/composio", tags=["agent-composio"])


async def _agent_user(
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
) -> User:
    """Hydrate the User row behind an agent-run principal. The agent JWT
    only carries the internal BIGINT id; the Composio service layer
    requires the Supabase UUID to derive the external namespace
    (`pai-{supabase_user_id}`). See AGENTS.md "用户标识规约"."""
    user = await load_user_by_id(pool, run.user_id)
    if user is None:
        raise HTTPException(
            status_code=404,
            detail=f"user {run.user_id} not found",
        )
    return user


# Whitelist of Composio meta-tool slugs we forward. Anything else 404s
# rather than letting an arbitrary slug reach the session.execute path
# (defense against the LLM hallucinating a slug into the URL).
_ALLOWED_META_TOOLS = frozenset(
    {
        "SEARCH_TOOLS",
        "GET_TOOL_SCHEMAS",
        "MULTI_EXECUTE_TOOL",
        "MANAGE_CONNECTIONS",
        # REMOTE_WORKBENCH / REMOTE_BASH_TOOL deliberately omitted: agents
        # already have a Daytona sandbox; introducing a second one would
        # confuse the runtime. Re-enable behind a flag if needed.
    }
)


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
    tools: list[str] | None = None  # slug allowlist


@router.post("/meta/{tool_name}")
async def meta_call(
    tool_name: str,
    body: _MetaCallBody = Body(default_factory=_MetaCallBody),
    user: User = Depends(_agent_user),
    pool=Depends(get_pool),
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
        result = await cs.execute_meta_tool(
            user,
            composio_slug,
            body.args,
            toolkits=body.toolkits,
            tools=body.tools,
        )
    except cs.ComposioError as e:
        raise _map_error(e) from e
    await _record_composio_tool_calls(
        pool,
        user,
        tool_calls=_meta_tool_call_count(tool_name, body.args),
        source=f"composio:meta:{tool_name.lower()}",
        metadata={"tool_name": composio_slug},
    )
    return result


# ── SDK direct path ────────────────────────────────────────────────────


@router.get("/connections")
async def list_connections(
    user: User = Depends(_agent_user),
    pool=Depends(get_pool),
) -> dict[str, Any]:
    try:
        items = await cs.list_connections(user)
    except cs.ComposioError as e:
        raise _map_error(e) from e
    out = []
    for c in items:
        d = c.model_dump()
        # Where this connection's ingested data is readable
        # (/api/agent/raw/{toolkit}/{entity}) — lets the chat process
        # discover generic + fanout raw sources without a static map.
        d["rawSources"] = [
            {"toolkit": tk, "entity": ent}
            for tk, ent in raw_sources_for_composio_toolkit(c.toolkit)
        ]
        out.append(d)
    for connector in await custom_mcp.list_custom_mcp_connectors(pool, user.id):
        d = custom_mcp.connector_to_connection_payload(connector)
        d["rawSources"] = connector.raw_sources
        out.append(d)
    return {"items": out}


class _SearchBody(BaseModel):
    query: str
    toolkit: str | None = None
    limit: int = Field(default=10, ge=1, le=50)


@router.post("/search")
async def search_tools(
    body: _SearchBody,
    user: User = Depends(_agent_user),
    pool=Depends(get_pool),
) -> dict[str, Any]:
    try:
        hits = await cs.search_tools(
            user,
            body.query,
            toolkit=body.toolkit,
            limit=body.limit,
        )
    except cs.ComposioError as e:
        raise _map_error(e) from e
    await _record_composio_tool_calls(
        pool,
        user,
        tool_calls=1,
        source="composio:agent_search",
        metadata={"toolkit": body.toolkit, "limit": body.limit},
    )
    return {"items": [h.model_dump() for h in hits]}


@router.get("/schema/{slug}")
async def get_tool_schema(
    slug: str,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
) -> dict[str, Any]:
    user = await load_user_by_id(pool, run.user_id)
    if user is None:
        raise HTTPException(status_code=404, detail=f"user {run.user_id} not found")
    try:
        schema = await cs.get_tool_schema(slug)
    except cs.ComposioError as e:
        raise _map_error(e) from e
    await _record_composio_tool_calls(
        pool,
        user,
        tool_calls=1,
        source="composio:agent_schema",
        metadata={"slug": slug},
    )
    return schema.model_dump()


class _ExecuteBody(BaseModel):
    slug: str
    args: dict[str, Any] = Field(default_factory=dict)
    connected_account_id: str | None = None


@router.post("/execute")
async def execute(
    body: _ExecuteBody,
    user: User = Depends(_agent_user),
    pool=Depends(get_pool),
) -> dict[str, Any]:
    if is_side_effecting(body.slug):
        logger.warning(
            "sandbox composio execute blocked: side-effecting slug %s (user %s)",
            body.slug,
            user.id,
        )
        raise HTTPException(
            status_code=403,
            detail={
                "error": "side_effect_blocked_in_sandbox",
                "slug": body.slug,
                "hint": (
                    "This tool has side effects and cannot run from sandbox "
                    "code-mode. Use the COMPOSIO_MULTI_EXECUTE_TOOL meta-tool "
                    "(human-gated) instead."
                ),
            },
        )
    try:
        result = await cs.execute(
            user,
            body.slug,
            body.args,
            connected_account_id=body.connected_account_id,
        )
    except cs.ComposioError as e:
        raise _map_error(e) from e
    await _record_composio_tool_calls(
        pool,
        user,
        tool_calls=1,
        source="composio:agent_execute",
        metadata={"slug": body.slug, "successful": result.successful},
        status="succeeded" if result.successful else "failed",
    )
    return result.model_dump()


class _MultiExecuteBody(BaseModel):
    calls: list[cs.ExecuteCall]
    parallelism: int = Field(default=8, ge=1, le=50)


@router.post("/multi_execute")
async def multi_execute(
    body: _MultiExecuteBody,
    user: User = Depends(_agent_user),
    pool=Depends(get_pool),
) -> dict[str, Any]:
    blocked = sorted({c.slug for c in body.calls if is_side_effecting(c.slug)})
    if blocked:
        logger.warning(
            "sandbox composio multi_execute blocked: side-effecting slugs %s (user %s)",
            blocked,
            user.id,
        )
        raise HTTPException(
            status_code=403,
            detail={
                "error": "side_effect_blocked_in_sandbox",
                "slugs": blocked,
                "hint": (
                    "These tools have side effects and cannot run from sandbox "
                    "code-mode. Use the COMPOSIO_MULTI_EXECUTE_TOOL meta-tool "
                    "(human-gated) instead."
                ),
            },
        )
    try:
        results = await cs.multi_execute(
            user,
            body.calls,
            parallelism=body.parallelism,
        )
    except cs.ComposioError as e:
        raise _map_error(e) from e
    await _record_composio_tool_calls(
        pool,
        user,
        tool_calls=len(body.calls),
        source="composio:agent_multi_execute",
        metadata={
            "parallelism": body.parallelism,
            "slugs": [call.slug for call in body.calls],
            "successful": sum(1 for result in results if result.successful),
        },
    )
    return {"results": [r.model_dump() for r in results]}


def _meta_tool_call_count(tool_name: str, args: dict[str, Any]) -> int:
    if tool_name == "MULTI_EXECUTE_TOOL":
        tools = args.get("tools")
        if isinstance(tools, list):
            return max(1, len(tools))
    return 1


async def _record_composio_tool_calls(
    pool,
    user: User,
    *,
    tool_calls: int,
    source: str,
    metadata: dict[str, Any],
    status: str = "succeeded",
) -> None:
    if tool_calls <= 0:
        return
    charge = estimate_composio_tool_call_charge(
        tool_calls=tool_calls,
        source=source,
        metadata=metadata,
        status="succeeded" if status == "succeeded" else "failed",
    )
    await record_provider_usage_charge(
        pool,
        user_id=user.id,
        supabase_user_id=user.supabase_user_id,
        charge=charge,
    )
