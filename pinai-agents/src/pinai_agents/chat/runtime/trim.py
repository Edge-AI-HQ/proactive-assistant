"""Bounded agent context — slide the LangGraph message window.

Main chat is a persistent singleton thread (migration 053). Without
bounding, every send reloads and re-sends the entire history: slow state
reconstruction, large LLM context, and O(N^2) checkpoint-blob growth from
the add_messages full-snapshot-per-step reducer.

We keep only the most recent `keep_turns` user-turns in the thread, dropping
older messages with langgraph-native `RemoveMessage` (the same primitive
chat regenerate already uses — no dependency on deepagents' summarization,
which isn't configurable: langchain-ai/deepagents#2622). The agent's working
context stays bounded turn-over-turn.

Nothing is lost by trimming: full history lives in pai_chat_messages (for
display) and durable facts in pai_memory (recalled via memory tools). The
thread is only the agent's short-term working set.

`compute_trim_message_ids` is a pure function (unit-tested for turn-boundary
and tool-call/tool-result pairing safety); `trim_thread` applies it through
the compiled agent's state.
"""

from __future__ import annotations

import logging
from typing import Any

from langchain_core.messages import HumanMessage, RemoveMessage

logger = logging.getLogger(__name__)


def compute_trim_message_ids(
    messages: list[Any], *, keep_turns: int,
) -> list[str]:
    """Ids of the oldest messages to drop so only the last `keep_turns`
    user-turns remain. Returns [] when the thread is at or under the limit.

    A turn starts at a HumanMessage and runs until the next HumanMessage, so
    cutting at a turn boundary is what guarantees safety: we never orphan a
    ToolMessage, never leave an AIMessage's tool_calls without their
    ToolMessage (the provider API rejects a dangling tool_use), and the
    remaining window always begins with a HumanMessage.
    """
    if keep_turns <= 0:
        return [m.id for m in messages if getattr(m, "id", None)]
    turn_starts = [
        i for i, m in enumerate(messages) if isinstance(m, HumanMessage)
    ]
    if len(turn_starts) <= keep_turns:
        return []
    # Cut everything before the start of the kept window. The window begins
    # at the HumanMessage that opens the (len - keep_turns)-th turn.
    cut = turn_starts[len(turn_starts) - keep_turns]
    return [m.id for m in messages[:cut] if getattr(m, "id", None)]


async def trim_thread(agent: Any, *, thread_id: str, keep_turns: int) -> int:
    """Trim a thread's message window to the last `keep_turns` turns.

    Reads state through the compiled agent (aget_state — the only reliable
    way to get the assembled messages under deepagents/langgraph 1.x) and
    drops the overflow via RemoveMessage. Returns the number of messages
    removed (0 if already within the window). Best-effort: the caller wraps
    this so a trim failure never breaks the just-finished response.
    """
    config = {"configurable": {"thread_id": thread_id}}
    snapshot = await agent.aget_state(config)
    messages = (snapshot.values or {}).get("messages", []) if snapshot else []
    ids = compute_trim_message_ids(messages, keep_turns=keep_turns)
    if not ids:
        return 0
    await agent.aupdate_state(
        config, {"messages": [RemoveMessage(id=i) for i in ids]},
    )
    logger.info(
        "trimmed thread=%s removed=%d kept_turns=%d",
        thread_id, len(ids), keep_turns,
    )
    return len(ids)
