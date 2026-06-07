"""`notify_user` — the proactive agent's unprompted-OUTREACH channel.

Distinct from replying to a message the user just sent (that's plain inline
text, no notification). notify_user is for reaching out on the agent's own
initiative — typically on a heartbeat beat. Calling it (a) shows up in the
live stream as a tool call whose `message` arg the frontend renders in the
tool chip (the worker relays notify_user's args verbatim via FrameBus), and
(b) calls back to web /api/agent/proactive/emit which fires a push
notification (the client suppresses it when foreground).

Attached only to the proactive agent (chat/agents/proactive.py). The
card-execution agent has no notify_user — it replies inline.
"""

from __future__ import annotations

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .. import http_client


class NotifyUserInput(BaseModel):
    message: str = Field(
        min_length=1,
        max_length=4000,
        description="The message to send the user. Plain, direct, in their language.",
    )


@tool("notify_user", args_schema=NotifyUserInput)
async def notify_user(message: str):
    """Proactively reach out to the user — sends a push notification. Use ONLY
    for unprompted, timely outreach (typically on a heartbeat beat) worth
    interrupting them for. Do NOT use it to reply to a message the user just
    sent you — reply inline in plain text for that (no notification). Most
    heartbeats should NOT call this. Say only what the user needs; don't
    narrate your thinking."""
    return await http_client.post("/api/agent/proactive/emit", {"message": message})
