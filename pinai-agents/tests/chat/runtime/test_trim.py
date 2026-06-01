"""compute_trim_message_ids: bounded message-window math.

The safety properties that matter (verified here, not at runtime): cutting
on turn boundaries never orphans a ToolMessage, never strands an
AIMessage's tool_calls without their ToolMessage, and always leaves a
window that begins with a HumanMessage.
"""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from pinai_agents.chat.runtime.trim import compute_trim_message_ids


def _turn(n: int, *, tool: bool = False) -> list:
    """One conversation turn: Human → [AI(tool_call) → Tool] → AI(answer)."""
    msgs: list = [HumanMessage(content=f"q{n}", id=f"h{n}")]
    if tool:
        msgs.append(
            AIMessage(
                content="",
                id=f"a{n}",
                tool_calls=[{"id": f"tc{n}", "name": "foo", "args": {}}],
            ),
        )
        msgs.append(ToolMessage(content="result", id=f"t{n}", tool_call_id=f"tc{n}"))
    msgs.append(AIMessage(content=f"ans{n}", id=f"af{n}"))
    return msgs


def _no_orphans(messages: list) -> bool:
    open_tc: set[str] = set()
    for m in messages:
        if isinstance(m, AIMessage):
            for tc in m.tool_calls or []:
                open_tc.add(tc["id"])
        if isinstance(m, ToolMessage) and m.tool_call_id not in open_tc:
            return False
    return True


def test_empty() -> None:
    assert compute_trim_message_ids([], keep_turns=5) == []


def test_under_limit_no_trim() -> None:
    assert compute_trim_message_ids(_turn(1) + _turn(2), keep_turns=3) == []


def test_exactly_at_limit_no_trim() -> None:
    assert compute_trim_message_ids(_turn(1) + _turn(2), keep_turns=2) == []


def test_trims_oldest_turn() -> None:
    msgs = _turn(1) + _turn(2) + _turn(3)
    assert compute_trim_message_ids(msgs, keep_turns=2) == ["h1", "af1"]


def test_trims_whole_turn_including_tool_pairing() -> None:
    msgs = _turn(1, tool=True) + _turn(2) + _turn(3)
    ids = compute_trim_message_ids(msgs, keep_turns=2)
    # The entire tool-using turn 1 goes — no half-turn.
    assert set(ids) == {"h1", "a1", "t1", "af1"}
    remaining = [m for m in msgs if m.id not in ids]
    assert isinstance(remaining[0], HumanMessage)
    assert _no_orphans(remaining)


def test_keep_one_turn() -> None:
    msgs = _turn(1) + _turn(2, tool=True) + _turn(3)
    ids = compute_trim_message_ids(msgs, keep_turns=1)
    remaining = [m for m in msgs if m.id not in ids]
    assert remaining[0].id == "h3"
    assert _no_orphans(remaining)


def test_keep_zero_removes_all() -> None:
    msgs = _turn(1) + _turn(2)
    assert len(compute_trim_message_ids(msgs, keep_turns=0)) == len(msgs)


def test_window_always_starts_human_no_orphans() -> None:
    msgs = _turn(1, tool=True) + _turn(2, tool=True) + _turn(3, tool=True) + _turn(4)
    ids = compute_trim_message_ids(msgs, keep_turns=2)
    remaining = [m for m in msgs if m.id not in ids]
    assert isinstance(remaining[0], HumanMessage)
    assert _no_orphans(remaining)
    # exactly the last 2 turns remain
    assert [m.id for m in remaining if isinstance(m, HumanMessage)] == ["h3", "h4"]
