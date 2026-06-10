"""Thread-state facade.

The single place that touches a compiled agent's langgraph state methods
(`aget_state` / `astream_events` / `aupdate_state`). Transport routes pass
in their already-built agent and call these helpers; they never invoke the
langgraph methods or import langgraph themselves, so the framework
dependency stays inside `harness/` (plan 2026-06-02 §PR-C, facade 铁律).

The caller owns agent construction (its topology must match the send-path
factory so the assembled state schema lines up): `transport/routes/history.py`
builds a cached read-only agent per kind; `chat.py` reuses the live
send-path agent. State reads never invoke the model or backend.

Note on the `messages` channel: under deepagents / langgraph 1.x it is a
reducer channel surfaced only by the compiled graph's `aget_state()` — raw
`checkpointer.aget_tuple().channel_values` exposes control-flow channels
(`__pregel_tasks`, `branch:to:*`) but NOT the user-visible messages list.
"""

from __future__ import annotations

from typing import Any

from langchain_core.messages import ToolMessage
from langgraph.types import Command


def _thread_config(session_key: str) -> dict[str, Any]:
    return {"configurable": {"thread_id": session_key}}


def command_tool_message(output: Any) -> ToolMessage | None:
    """The ToolMessage embedded in a `Command` tool output, else None.

    Tools that update graph state (task, write_todos) return a langgraph
    `Command` whose user-facing payload is the ToolMessage inside
    `update["messages"]` — for `task`, the subagent's final answer. Keeping
    the Command unwrap here lets transport read tool results without
    importing langgraph (facade 铁律, see module docstring).
    """
    if isinstance(output, Command) and isinstance(output.update, dict):
        raw = output.update.get("messages")
        if isinstance(raw, list):
            msgs = [m for m in raw if isinstance(m, ToolMessage)]
            if msgs:
                return msgs[-1]
    return None


async def read_state_messages(agent: Any, session_key: str) -> list[Any]:
    """Return a thread's `messages` list, or `[]` if it has no state yet."""
    snapshot = await agent.aget_state(_thread_config(session_key))
    if snapshot is None:
        return []
    return (snapshot.values or {}).get("messages", []) or []


def stream_events(agent: Any, inputs: Any, config: dict[str, Any]) -> Any:
    """The single call to `agent.astream_events` (langgraph v2 event stream).

    `inputs` is either `{"messages": [...]}` for a normal/regenerate turn or a
    langgraph `Command` (HITL resume, built by `make_resume_input`) — both are
    valid astream_events inputs. Returns the raw async event iterator;
    transport's `langgraph_to_sse` translates it into chat:* SSE frames.
    `config` (thread_id, tags, recursion_limit, …) is the per-turn run config.
    """
    return agent.astream_events(inputs, config=config, version="v2")


def make_resume_input(decisions: list[dict[str, Any]]) -> Command:
    """Build the langgraph resume input for a HITL decision. Kept in this
    facade so transport never imports langgraph (banned-api). `decisions`
    matches HumanInTheLoopMiddleware's resume schema — a list of
    `{type: approve|edit|reject|respond, ...}` aligned with the interrupt's
    action_requests (verified 2026-06-05: resume={"decisions": [...]})."""
    return Command(resume={"decisions": decisions})


async def apply_message_updates(agent: Any, session_key: str, updates: list[Any]) -> None:
    """Apply a `messages`-channel state update via `agent.aupdate_state`.

    Used by regenerate / edit to pop trailing AI/Tool/Human messages
    (`RemoveMessage` instances built by the caller) before re-running.
    """
    await agent.aupdate_state(_thread_config(session_key), {"messages": updates})
