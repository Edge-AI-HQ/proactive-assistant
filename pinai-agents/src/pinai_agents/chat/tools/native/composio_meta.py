"""Composio meta-tool wrappers — main_chat / card_chat native @tools.

Each tool is a thin forwarder to `/api/agent/composio/meta/{NAME}`.
Web mints/reuses a per-user Composio Tool Router session and forwards
the meta-tool call to Composio Cloud. The chat process never holds
the Composio API key.

Names mirror Composio's official meta-tool slugs (without the
`COMPOSIO_` prefix on the wrapper end — keeps the tool surface
ergonomic for the LLM). REMOTE_WORKBENCH / REMOTE_BASH_TOOL are
intentionally not exposed: agents already have a Daytona sandbox; a
second Composio-managed sandbox would confuse the runtime.
"""

from __future__ import annotations

from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .. import http_client


class _SearchToolsInput(BaseModel):
    queries: list[dict[str, Any]] = Field(
        description=(
            "List of {use_case: '...', known_fields?: {...}} entries. "
            "Each query returns ranked tool slugs + schemas + plan steps."
        ),
    )


@tool("COMPOSIO_SEARCH_TOOLS", args_schema=_SearchToolsInput)
async def composio_search_tools(queries: list[dict[str, Any]]):
    """Search Composio's tool catalog by use case across the user's
    connected toolkits. Use this BEFORE executing any tool when you're
    not sure of the exact slug or args shape — it returns ranked
    candidate slugs with their schemas and a recommended plan."""
    return await http_client.post(
        "/api/agent/composio/meta/SEARCH_TOOLS",
        {"args": {"queries": queries}},
    )


class _GetSchemasInput(BaseModel):
    tool_slugs: list[str] = Field(
        min_length=1,
        max_length=20,
        description="Tool slugs to fetch full input/output schemas for.",
    )


@tool("COMPOSIO_GET_TOOL_SCHEMAS", args_schema=_GetSchemasInput)
async def composio_get_tool_schemas(tool_slugs: list[str]):
    """Fetch full input/output JSON schemas for specific Composio tool
    slugs. Use after SEARCH_TOOLS narrowed the candidates and you want
    to confirm exact arg shapes before executing."""
    return await http_client.post(
        "/api/agent/composio/meta/GET_TOOL_SCHEMAS",
        {"args": {"tool_slugs": tool_slugs}},
    )


class _MultiExecuteInput(BaseModel):
    calls: list[dict[str, Any]] = Field(
        min_length=1,
        max_length=50,
        description=(
            "List of tool calls to run in parallel. Each: "
            "{tool_slug: '...', arguments: {...}}. Up to 50 calls."
        ),
    )


@tool("COMPOSIO_MULTI_EXECUTE_TOOL", args_schema=_MultiExecuteInput)
async def composio_multi_execute_tool(calls: list[dict[str, Any]]):
    """Execute one or many Composio tool calls in parallel. Each call
    is {tool_slug, arguments}. Use this for both single executions and
    cross-toolkit data extraction (e.g. Gmail + Calendar in one turn)."""
    # Composio's actual MULTI_EXECUTE_TOOL slug expects `tools` (not
    # `calls`) and a required `sync_response_to_workbench` flag. We keep
    # the LLM-facing arg name as `calls` to match the prompt + avoid an
    # Anthropic prompt cache invalidation; rename inside the wrapper.
    # `sync_response_to_workbench=False` keeps the full response inline —
    # the workbench is a separate Composio-managed sandbox we don't use.
    return await http_client.post(
        "/api/agent/composio/meta/MULTI_EXECUTE_TOOL",
        {"args": {"tools": calls, "sync_response_to_workbench": False}},
    )


class _ManageConnectionsInput(BaseModel):
    toolkits: list[str] = Field(
        min_length=1,
        max_length=20,
        description="Toolkit slugs to check / initiate connections for.",
    )


@tool("COMPOSIO_MANAGE_CONNECTIONS", args_schema=_ManageConnectionsInput)
async def composio_manage_connections(toolkits: list[str]):
    """Check whether the user has connected the requested Composio
    toolkits, and if not, return Connect Link URLs the user can click
    to OAuth in-chat. Call this when SEARCH_TOOLS surfaced a candidate
    slug whose toolkit isn't yet connected."""
    return await http_client.post(
        "/api/agent/composio/meta/MANAGE_CONNECTIONS",
        {"args": {"toolkits": toolkits}},
    )
