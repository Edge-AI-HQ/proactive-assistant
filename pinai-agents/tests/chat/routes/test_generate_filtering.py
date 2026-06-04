from __future__ import annotations

import inspect

from pinai_agents.chat.transport.routes import generate as generate_route
from pinai_agents.chat.transport.routes.generate import _serialize_passing_cards
from pinai_agents.shared.api_models import (
    CardAction,
    CardEvaluation,
    GeneratedCard,
    GeneratorOutput,
)


def _card(intent_key: str) -> GeneratedCard:
    return GeneratedCard(
        intentKey=intent_key,
        goalBasket="work",
        title="Investigate CPO supplier earnings",
        whyNow="A high-salience world signal and user preference both mention CPO suppliers.",
        summary="Review the latest supplier signal and decide whether to add it to the PM market watchlist.",
        primaryAction=CardAction(label="Review signal", type="confirm"),
        confidence=0.8,
        urgency=0.6,
        importance=0.7,
        sources=[
            "world id=world_pm_positive_optical_1, title=US optical module suppliers rally on CPO demand checks"
        ],
    )


def _evaluation(intent_key: str, *, passed: bool, overall: float | None = None) -> CardEvaluation:
    score = overall if overall is not None else (8 if passed else 0)
    return CardEvaluation(
        intentKey=intent_key,
        relevance=score,
        actionability=score,
        whyNowClarity=score,
        novelty=score,
        decisionCompression=score,
        overall=score,
        pass_=passed,
        feedback="usable card" if passed else "error placeholder, not a real card",
    )


def test_generate_route_drops_failed_cards_before_returning_to_web() -> None:
    parsed = GeneratorOutput(
        reasoning="one real card and one failed placeholder",
        cards=[_card("real-cpo-card"), _card("network-error-placeholder")],
        evaluations=[
            _evaluation("real-cpo-card", passed=True),
            _evaluation("network-error-placeholder", passed=False),
        ],
        batchFeedback="drop failed placeholder",
    )

    cards, evals = _serialize_passing_cards(parsed, run_id="run_filter", max_cards=10)

    assert [card["intentKey"] for card in cards] == ["real-cpo-card"]
    assert cards[0]["id"] == "run_filter_card_00"
    assert [ev["cardId"] for ev in evals] == ["run_filter_card_00", None]


def test_generate_route_keeps_best_candidate_when_evaluator_fails_all_cards() -> None:
    parsed = GeneratorOutput(
        reasoning="all candidates failed the evaluator",
        cards=[_card("weak-card"), _card("less-weak-card")],
        evaluations=[
            _evaluation("weak-card", passed=False, overall=3),
            _evaluation("less-weak-card", passed=False, overall=4),
        ],
        batchFeedback="no passing card",
    )

    cards, evals = _serialize_passing_cards(parsed, run_id="run_filter", max_cards=10)

    assert [card["intentKey"] for card in cards] == ["less-weak-card"]
    assert cards[0]["id"] == "run_filter_card_00"
    assert [ev["cardId"] for ev in evals] == [None, "run_filter_card_00"]


def test_generate_route_caps_returned_cards_to_requested_count() -> None:
    parsed = GeneratorOutput(
        reasoning="more passing cards than requested",
        cards=[_card("first-card"), _card("second-card"), _card("third-card")],
        evaluations=[
            _evaluation("first-card", passed=True, overall=6),
            _evaluation("second-card", passed=True, overall=7),
            _evaluation("third-card", passed=True, overall=8),
        ],
        batchFeedback="cap to requested count",
    )

    cards, evals = _serialize_passing_cards(parsed, run_id="run_filter", max_cards=1)

    assert [card["intentKey"] for card in cards] == ["first-card"]
    assert cards[0]["id"] == "run_filter_card_00"
    assert [ev["cardId"] for ev in evals] == ["run_filter_card_00", None, None]


def test_generate_route_caps_agent_runtime_to_ten_minutes() -> None:
    source = inspect.getsource(generate_route.generate)

    assert generate_route._GENERATE_AGENT_TIMEOUT_SECONDS == 600.0
    assert "asyncio.timeout(_GENERATE_AGENT_TIMEOUT_SECONDS)" in source
