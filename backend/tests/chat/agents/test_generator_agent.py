"""Agentic generator unit surface: submit_card collection + validation.

The generator is one multi-turn agent run; `submit_card` is its only write.
Validation (schema / cap / duplicate intent_key) happens at the tool layer so
the agent gets a readable error and can fix + resubmit (design §四:出卡时
验证已完毕,无独立后置校验步)。
"""

from __future__ import annotations

import pytest
from agent_engine.agents.generator import (
    _RECURSION_LIMIT,
    _make_submit_card_tool,
)
from pinai_contracts.api_models import GeneratedCard
from pydantic import ValidationError

_CARD_ARGS = {
    "intent_key": "reply-diana",
    "goal_basket": "work",
    "title": "Confirm Friday 10:00 with Diana",
    "why_now": "Reschedule collides with Friday onsite",
    "summary": "Diana moved the sync; confirm the new slot before EOD.",
    "primary_action": {"label": "Reply", "type": "confirm"},
    "confidence": 0.8,
    "urgency": 0.7,
    "importance": 0.8,
    "sources": ["gmail event id=evt_e9, title=Diana rescheduled"],
}


@pytest.mark.asyncio
async def test_submit_card_collects_valid_cards_in_order():
    collected: list[GeneratedCard] = []
    tool = _make_submit_card_tool(collected, cap=8)

    out1 = await tool.ainvoke(_CARD_ARGS)
    out2 = await tool.ainvoke({**_CARD_ARGS, "intent_key": "second-card"})

    assert "accepted (1/8)" in out1
    assert "accepted (2/8)" in out2
    assert [c.intent_key for c in collected] == ["reply-diana", "second-card"]


@pytest.mark.asyncio
async def test_submit_card_rejects_beyond_cap_without_collecting():
    collected: list[GeneratedCard] = []
    tool = _make_submit_card_tool(collected, cap=1)

    await tool.ainvoke(_CARD_ARGS)
    out = await tool.ainvoke({**_CARD_ARGS, "intent_key": "one-too-many"})

    assert "REJECTED" in out
    assert len(collected) == 1


@pytest.mark.asyncio
async def test_submit_card_rejects_duplicate_intent_key():
    collected: list[GeneratedCard] = []
    tool = _make_submit_card_tool(collected, cap=8)

    await tool.ainvoke(_CARD_ARGS)
    out = await tool.ainvoke(_CARD_ARGS)

    assert "REJECTED" in out
    assert "already submitted" in out
    assert len(collected) == 1


@pytest.mark.asyncio
async def test_submit_card_schema_rejects_ungrounded_card():
    """sources min_length=1 (schema-level grounding) still holds at the tool."""
    collected: list[GeneratedCard] = []
    tool = _make_submit_card_tool(collected, cap=8)

    with pytest.raises(ValidationError):
        await tool.ainvoke({**_CARD_ARGS, "sources": []})
    assert collected == []


def test_generator_recursion_limit_is_bounded():
    # One loop: seed → a few searches → ≤8 submits → summary. 80 is headroom,
    # not unbounded.
    assert 25 < _RECURSION_LIMIT <= 120
