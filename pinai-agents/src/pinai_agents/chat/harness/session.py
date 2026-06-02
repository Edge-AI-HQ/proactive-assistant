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


def _thread_config(session_key: str) -> dict[str, Any]:
    return {"configurable": {"thread_id": session_key}}


async def read_state_messages(agent: Any, session_key: str) -> list[Any]:
    """Return a thread's `messages` list, or `[]` if it has no state yet."""
    snapshot = await agent.aget_state(_thread_config(session_key))
    if snapshot is None:
        return []
    return (snapshot.values or {}).get("messages", []) or []


def stream_events(agent: Any, inputs: dict[str, Any], config: dict[str, Any]) -> Any:
    """The single call to `agent.astream_events` (langgraph v2 event stream).

    Returns the raw async event iterator; transport's `langgraph_to_sse`
    translates it into chat:* SSE frames. `config` (thread_id, tags,
    recursion_limit, …) is the caller's per-turn run config.
    """
    return agent.astream_events(inputs, config=config, version="v2")


async def apply_message_updates(agent: Any, session_key: str, updates: list[Any]) -> None:
    """Apply a `messages`-channel state update via `agent.aupdate_state`.

    Used by regenerate / edit to pop trailing AI/Tool/Human messages
    (`RemoveMessage` instances built by the caller) before re-running.
    """
    await agent.aupdate_state(_thread_config(session_key), {"messages": updates})
