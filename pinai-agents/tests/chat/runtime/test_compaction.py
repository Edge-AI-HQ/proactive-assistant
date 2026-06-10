"""compact_thread + helpers: turn-boundary split, token accounting, write-back.

The safety properties that matter (verified here, not at runtime): splitting on
turn boundaries never orphans a ToolMessage, never strands an AIMessage's
tool_calls without their ToolMessage, and always leaves a kept tail that begins
with a HumanMessage. The orchestration tests pin the in-place REMOVE_ALL
rewrite, the token/message triggers, and the summary-failure no-op.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from langchain_core.messages import AIMessage, HumanMessage, RemoveMessage, ToolMessage
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from pinai_agents.chat.harness import compaction
from pinai_agents.chat.harness.compaction import (
    _reported_input_tokens,
    _split_at_turn_boundary,
    compact_thread,
)


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


def _ai_with_usage(idx: str, *, input_tokens: int, output_tokens: int) -> AIMessage:
    return AIMessage(
        content="x",
        id=idx,
        usage_metadata={
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
        },
    )


# ── _split_at_turn_boundary ──────────────────────────────────────────


def test_split_empty() -> None:
    assert _split_at_turn_boundary([], keep_recent_turns=5) == 0


def test_split_under_limit() -> None:
    assert _split_at_turn_boundary(_turn(1) + _turn(2), keep_recent_turns=3) == 0


def test_split_exactly_at_limit() -> None:
    assert _split_at_turn_boundary(_turn(1) + _turn(2), keep_recent_turns=2) == 0


def test_split_oldest_turn() -> None:
    msgs = _turn(1) + _turn(2) + _turn(3)
    cut = _split_at_turn_boundary(msgs, keep_recent_turns=2)
    old, tail = msgs[:cut], msgs[cut:]
    assert [m.id for m in old] == ["h1", "af1"]
    assert isinstance(tail[0], HumanMessage) and tail[0].id == "h2"


def test_split_keeps_tool_turn_whole() -> None:
    msgs = _turn(1, tool=True) + _turn(2) + _turn(3)
    cut = _split_at_turn_boundary(msgs, keep_recent_turns=2)
    old, tail = msgs[:cut], msgs[cut:]
    assert {m.id for m in old} == {"h1", "a1", "t1", "af1"}
    assert isinstance(tail[0], HumanMessage)
    assert _no_orphans(tail)


def test_split_keep_one() -> None:
    msgs = _turn(1) + _turn(2, tool=True) + _turn(3)
    cut = _split_at_turn_boundary(msgs, keep_recent_turns=1)
    tail = msgs[cut:]
    assert tail[0].id == "h3"
    assert _no_orphans(tail)


def test_split_keep_zero_takes_all() -> None:
    msgs = _turn(1) + _turn(2)
    assert _split_at_turn_boundary(msgs, keep_recent_turns=0) == len(msgs)


def test_split_window_starts_human_no_orphans() -> None:
    msgs = _turn(1, tool=True) + _turn(2, tool=True) + _turn(3, tool=True) + _turn(4)
    cut = _split_at_turn_boundary(msgs, keep_recent_turns=2)
    tail = msgs[cut:]
    assert isinstance(tail[0], HumanMessage)
    assert _no_orphans(tail)
    assert [m.id for m in tail if isinstance(m, HumanMessage)] == ["h3", "h4"]


# ── _reported_input_tokens ───────────────────────────────────────────


def test_tokens_prefers_reported_usage() -> None:
    msgs = [
        HumanMessage(content="hi", id="h1"),
        _ai_with_usage("a1", input_tokens=1000, output_tokens=50),
    ]
    assert _reported_input_tokens(msgs) == 1050


def test_tokens_uses_latest_ai_message() -> None:
    msgs = [
        _ai_with_usage("a1", input_tokens=100, output_tokens=10),
        HumanMessage(content="next", id="h2"),
        _ai_with_usage("a2", input_tokens=5000, output_tokens=200),
    ]
    assert _reported_input_tokens(msgs) == 5200


def test_tokens_fallback_without_usage() -> None:
    msgs = [HumanMessage(content="hello world", id="h1"), AIMessage(content="hi there", id="a1")]
    assert _reported_input_tokens(msgs) > 0


# ── compact_thread orchestration ─────────────────────────────────────


def _mock_agent(msgs: list) -> MagicMock:
    agent = MagicMock()
    agent.aget_state = AsyncMock(return_value=SimpleNamespace(values={"messages": msgs}, next=()))
    agent.aupdate_state = AsyncMock()
    return agent


def _msgs_over_token_trigger() -> list:
    msgs = _turn(1) + _turn(2) + _turn(3)
    msgs[-1] = _ai_with_usage("af3", input_tokens=200, output_tokens=10)  # 210 > trigger
    return msgs


async def test_compact_token_trigger_rewrites_in_place(monkeypatch) -> None:
    monkeypatch.setattr(compaction, "_summarize", AsyncMock(return_value="SUMMARY"))
    agent = _mock_agent(_msgs_over_token_trigger())

    folded = await compact_thread(
        agent,
        thread_id="main-1",
        virtual_key="vk",
        token_trigger=100,
        keep_recent_turns=1,
    )

    assert folded > 0
    # write-back is REMOVE_ALL + summary + tail, in place (no checkpointer delete)
    written = agent.aupdate_state.await_args.args[1]["messages"]
    assert isinstance(written[0], RemoveMessage) and written[0].id == REMOVE_ALL_MESSAGES
    assert written[1].additional_kwargs.get("lc_source") == "summarization"
    assert isinstance(written[2], HumanMessage) and written[2].id == "h3"  # tail = last turn


async def test_compact_message_trigger_fires_without_token_pressure(monkeypatch) -> None:
    monkeypatch.setattr(compaction, "_summarize", AsyncMock(return_value="SUMMARY"))
    # 5 turns, no usage attached → tiny token estimate, but message count crosses
    agent = _mock_agent(_turn(1) + _turn(2) + _turn(3) + _turn(4) + _turn(5))

    folded = await compact_thread(
        agent,
        thread_id="main-1",
        virtual_key="vk",
        token_trigger=10_000_000,  # not crossed
        message_trigger=4,  # 10 messages > 4 → fires
        keep_recent_turns=1,
    )

    assert folded > 0
    agent.aupdate_state.assert_awaited_once()


async def test_compact_no_trigger_is_noop(monkeypatch) -> None:
    monkeypatch.setattr(compaction, "_summarize", AsyncMock(return_value="SUMMARY"))
    agent = _mock_agent(_turn(1) + _turn(2))

    folded = await compact_thread(
        agent,
        thread_id="main-1",
        virtual_key="vk",
        token_trigger=10_000_000,
        message_trigger=1000,
        keep_recent_turns=12,
    )

    assert folded == 0
    agent.aupdate_state.assert_not_awaited()


async def test_compact_nothing_compressible_skips(monkeypatch) -> None:
    monkeypatch.setattr(compaction, "_summarize", AsyncMock(return_value="SUMMARY"))
    agent = _mock_agent(_msgs_over_token_trigger())  # token over, but keep covers all

    folded = await compact_thread(
        agent,
        thread_id="main-1",
        virtual_key="vk",
        token_trigger=100,
        keep_recent_turns=10,
    )

    assert folded == 0
    agent.aupdate_state.assert_not_awaited()


async def test_compact_summary_failure_skips(monkeypatch) -> None:
    monkeypatch.setattr(compaction, "_summarize", AsyncMock(side_effect=RuntimeError("llm down")))
    agent = _mock_agent(_msgs_over_token_trigger())

    folded = await compact_thread(
        agent,
        thread_id="main-1",
        virtual_key="vk",
        token_trigger=100,
        keep_recent_turns=1,
    )

    # A summary outage must not write a half-baked window.
    assert folded == 0
    agent.aupdate_state.assert_not_awaited()
