"""Profile-portrait native @tool — chat agent maintains the L2 portrait.

`memory_edit` applies add/replace/remove ops to any of the five portrait slots
via api /api/agent/user-strings/edit: USER/GOALS (the standing view of the user)
AND IDENTITY/SOUL/TOOLS (the agent's own standing persona — who you are to this
user, your voice, your tool preferences). This is how the agent durably updates
both who-the-user-is and who-it-is between turns; events_search/event_append
handle the timeline, memory_edit the standing portrait. (The AGENTS safety
constant is not a slot and can't be edited.)
"""

from __future__ import annotations

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .. import http_client


class MemoryEditOp(BaseModel):
    op: str = Field(description="add | replace | remove")
    text: str = Field(default="", description="New entry text (for add / replace).")
    target: str = Field(
        default="", description="Substring identifying the entry to replace / remove."
    )


class MemoryEditInput(BaseModel):
    slot: str = Field(
        description=(
            "Portrait section. About the user: USER (durable facts/preferences) "
            "| GOALS (long-term goals). About yourself (your standing persona): "
            "IDENTITY (who you are to this user) | SOUL (personality/voice) | "
            "TOOLS (tool-use preferences)."
        )
    )
    operations: list[MemoryEditOp] = Field(description="Ops applied in order (a batch).")
    evidence_event_ids: list[str] | None = Field(
        default=None,
        max_length=20,
        description=(
            "Optional: ids of the events (from events_search) that support this "
            "portrait change — cite your evidence when the edit is distilled "
            "from specific events."
        ),
    )


@tool("memory_edit", args_schema=MemoryEditInput)
async def memory_edit(
    slot: str,
    operations: list[MemoryEditOp],
    evidence_event_ids: list[str] | None = None,
):
    """Update the durable portrait — about the user (USER facts/preferences,
    GOALS) or about yourself (IDENTITY/SOUL/TOOLS persona). `add` a new entry;
    `replace`/`remove` with a `target` substring to revise one. On `over_budget`
    you get every entry back — consolidate and resend as one batch. Don't churn:
    edit only when something durable actually changed. Every successful edit is
    recorded as a change event in the timeline automatically (no extra call)."""
    body: dict = {
        "slot": slot,
        "operations": [{"op": o.op, "text": o.text, "target": o.target} for o in operations],
    }
    if evidence_event_ids:
        body["evidenceEventIds"] = evidence_event_ids
    return await http_client.post("/api/agent/user-strings/edit", body)
