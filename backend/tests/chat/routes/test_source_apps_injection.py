"""_serialize_cards 给每张提交卡注入 sourceApps + run-scoped id(确定性,非 LLM)。"""

from __future__ import annotations

from agent_engine.transport.routes.generate import _serialize_cards
from pinai_contracts.api_models import GeneratedCard, GeneratorOutput


def _card(intent_key: str) -> GeneratedCard:
    return GeneratedCard.model_validate(
        {
            "intentKey": intent_key,
            "goalBasket": "work",
            "title": "t",
            "whyNow": "w",
            "summary": "s",
            "primaryAction": {"label": "Do", "type": "confirm"},
            "confidence": 0.5,
            "urgency": 0.5,
            "importance": 0.5,
            "sources": [
                "world event id=evt_w1, title=news",
                "gmail event id=evt_m1, title=s",
            ],
        }
    )


def _output(*cards: GeneratedCard) -> GeneratorOutput:
    return GeneratorOutput(reasoning="r", cards=list(cards), evaluations=[], batch_feedback="")


def test_serialize_stamps_source_apps_and_ids() -> None:
    cards = _serialize_cards(_output(_card("k1")), run_id="run1", max_cards=1)
    assert cards[0]["sourceApps"] == ["web", "gmail"]
    assert cards[0]["id"] == "run1_card_00"


def test_serialize_zero_cards_is_valid() -> None:
    # 0 张是正常结果(宁缺毋滥)——不抛错、不造 fallback 卡。
    assert _serialize_cards(_output(), run_id="run1", max_cards=8) == []


def test_serialize_caps_to_max_cards() -> None:
    cards = _serialize_cards(
        _output(_card("k1"), _card("k2"), _card("k3")), run_id="run1", max_cards=2
    )
    assert [c["intentKey"] for c in cards] == ["k1", "k2"]
    assert [c["id"] for c in cards] == ["run1_card_00", "run1_card_01"]
