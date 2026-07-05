"""_AgentModel clips over-`max_length` LLM strings instead of rejecting.

Regression guard for the recurring card-generation failure where an LLM
emits a field longer than its schema ceiling (decision/why_now_trigger
200→400, then agentPrompt 600, …). Provider structured output does not
enforce JSON-Schema `maxLength`, so the ceiling is a soft target clipped at
the validation boundary — an over-long field must NOT abort the batch.
"""

from __future__ import annotations

import logging

import pytest
from pinai_contracts.api_models import (
    CardAction,
    GeneratedCard,
    PlanItem,
)


def _full_card(agent_prompt: str) -> dict:
    """Minimal complete GeneratedCard payload (camelCase, as an LLM emits)."""
    return {
        "intentKey": "k",
        "goalBasket": "health",
        "title": "t",
        "whyNow": "w",
        "summary": "s",
        "primaryAction": {"label": "Do it", "type": "confirm", "agentPrompt": agent_prompt},
        "confidence": 0.5,
        "urgency": 0.5,
        "importance": 0.5,
        "sources": ["signal id=1, title=x"],
    }


@pytest.mark.parametrize("key", ["whyNowTrigger", "why_now_trigger"])
def test_planitem_clips_overlong_why_now_trigger(key: str) -> None:
    # max_length=400; both the camelCase alias (LLM path) and the snake_case
    # name (SDK path) must be clipped, not rejected.
    item = PlanItem.model_validate(
        {"intentKey": "k", "goalBasket": "health", "decision": "ok", key: "x" * 500}
    )
    assert len(item.why_now_trigger) == 400


def test_cardaction_clips_overlong_agent_prompt() -> None:
    action = CardAction.model_validate({"label": "Go", "agentPrompt": "x" * 700})
    assert action.agent_prompt is not None
    assert len(action.agent_prompt) == 600


def test_nested_overlong_agent_prompt_does_not_raise() -> None:
    # The exact production failure: primaryAction.agentPrompt > 600. The
    # nested CardAction inherits the clip validator, so the card survives.
    card = GeneratedCard.model_validate(_full_card("x" * 700))
    clipped = card.primary_action.agent_prompt
    assert clipped is not None and len(clipped) == 600


def test_within_limit_is_left_unchanged() -> None:
    action = CardAction.model_validate({"label": "Go", "agentPrompt": "short prompt"})
    assert action.agent_prompt == "short prompt"


def test_clip_is_logged(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="pinai_contracts.api_models"):
        CardAction.model_validate({"label": "Go", "agentPrompt": "x" * 700})
    assert any("clipped over-long LLM field" in r.message for r in caplog.records)
