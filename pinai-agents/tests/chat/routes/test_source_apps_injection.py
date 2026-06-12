"""_serialize_passing_cards 给每张选中卡注入 sourceApps(确定性,非 LLM)。"""

from __future__ import annotations

from pinai_agents.chat.transport.routes.generate import _serialize_passing_cards
from pinai_agents.shared.api_models import (
    CardEvaluation,
    GeneratedCard,
    GeneratorOutput,
)


def _output_with_one_card() -> GeneratorOutput:
    card = GeneratedCard.model_validate(
        {
            "intentKey": "k1",
            "goalBasket": "work",
            "title": "t",
            "whyNow": "w",
            "summary": "s",
            "primaryAction": {"label": "Do", "type": "confirm"},
            "confidence": 0.5,
            "urgency": 0.5,
            "importance": 0.5,
            "sources": [
                "world id=w1, title=news",
                "gmail message id=m1, subject=s",
            ],
        }
    )
    evaluation = CardEvaluation.model_validate(
        {
            "intentKey": "k1",
            "relevance": 7,
            "actionability": 7,
            "whyNowClarity": 7,
            "novelty": 7,
            "decisionCompression": 7,
            "overall": 7,
            "pass": True,
            "feedback": "ok",
        }
    )
    return GeneratorOutput.model_validate(
        {"reasoning": "r", "cards": [card], "evaluations": [evaluation], "batchFeedback": "b"}
    )


def test_serialize_stamps_source_apps() -> None:
    cards, _evals = _serialize_passing_cards(_output_with_one_card(), run_id="run1", max_cards=1)
    assert cards[0]["sourceApps"] == ["web", "gmail"]
    assert cards[0]["id"] == "run1_card_00"
