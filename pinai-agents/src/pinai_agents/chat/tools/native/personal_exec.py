"""personal_exec native @tool — invoke a Composio tool against the
user's connected account (Gmail / GCal / etc.). Wire layer only;
permissions are handled by Composio itself."""

from __future__ import annotations

from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .. import http_client


class PersonalExecInput(BaseModel):
    tool: str = Field(
        min_length=1, max_length=100,
        description="Composio tool slug (e.g. 'GMAIL_CREATE_EMAIL_DRAFT').",
    )
    args: dict[str, Any] = Field(
        default_factory=dict,
        description="Tool arguments matching the Composio tool schema.",
    )


@tool("personal_exec", args_schema=PersonalExecInput)
async def personal_exec(tool: str, args: dict[str, Any]):
    """Execute a Composio tool against the user's connected account
    (Gmail / GCal / etc.)."""
    return await http_client.post(
        "/api/agent/personal/exec",
        {"tool": tool, "args": args},
    )
