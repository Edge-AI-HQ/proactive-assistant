"""Per-run context for the chat process.

ContextVars carry user_id / run_id / run_jwt / virtual_key / session_key
from the route handler through LangGraph + native @tool calls without
making them parameters on every function.

Pattern:
    async def chat_route(req):
        with run_context(user_id=…, run_id=…, run_jwt=…,
                         virtual_key=…, session_key=…):
            await agent.astream_events(...)
            # native tools read current_agent_user_id.get() etc.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar

current_agent_user_id: ContextVar[int] = ContextVar("current_agent_user_id", default=0)
current_agent_run_id: ContextVar[str] = ContextVar("current_agent_run_id", default="")
current_run_jwt: ContextVar[str] = ContextVar("current_run_jwt", default="")
current_virtual_key: ContextVar[str] = ContextVar("current_virtual_key", default="")
# session_key doubles as Daytona thread sandbox key — sandbox.py uses it
# to look up the per-thread sandbox so tool calls (DeepAgents fs +
# execute middleware) hit the same cloud resource across turns.
current_session_key: ContextVar[str] = ContextVar("current_session_key", default="")
# Per-user persistent Browserbase context id (from RunPrincipal.bbctx).
# Empty string when Browserbase is unconfigured / provisioning failed —
# browser_tool falls back to ephemeral sessions in that case.
current_browserbase_context_id: ContextVar[str] = ContextVar(
    "current_browserbase_context_id", default="",
)


@contextmanager
def run_context(
    *,
    user_id: int,
    run_id: str,
    run_jwt: str,
    virtual_key: str = "",
    session_key: str = "",
    browserbase_context_id: str = "",
):
    """Set ContextVars for the duration of a chat agent run."""
    t1 = current_agent_user_id.set(user_id)
    t2 = current_agent_run_id.set(run_id)
    t3 = current_run_jwt.set(run_jwt)
    t4 = current_virtual_key.set(virtual_key)
    t5 = current_session_key.set(session_key)
    t6 = current_browserbase_context_id.set(browserbase_context_id)
    try:
        yield
    finally:
        current_agent_user_id.reset(t1)
        current_agent_run_id.reset(t2)
        current_run_jwt.reset(t3)
        current_virtual_key.reset(t4)
        current_session_key.reset(t5)
        current_browserbase_context_id.reset(t6)
