"""ReasoningStep / GeneratedCard.reasoning_steps — LLM 输出的分步推理 schema。

详见 docs/plans/2026-06-11-card-title-sources-reasoning.mdx C 节:
label 小枚举(归一化大小写/连字符),detail ≤200 截断(_AgentModel clip),
缺省 [](旧 artifact / 测试 fixture 兼容)。
"""

from __future__ import annotations

from pinai_agents.shared.api_models import GeneratedCard, ReasoningStep


def _card_payload(**overrides: object) -> dict:
    payload: dict = {
        "intentKey": "k",
        "goalBasket": "work",
        "title": "t",
        "whyNow": "w",
        "summary": "s",
        "primaryAction": {"label": "Do it", "type": "confirm"},
        "confidence": 0.5,
        "urgency": 0.5,
        "importance": 0.5,
        "sources": ["signal id=1, title=x"],
    }
    payload.update(overrides)
    return payload


def test_reasoning_steps_parse_camelcase() -> None:
    card = GeneratedCard.model_validate(
        _card_payload(
            reasoningSteps=[
                {"label": "observed", "detail": "saw a signal"},
                {"label": "decided", "detail": "surfaced the card"},
            ]
        )
    )
    assert [s.label for s in card.reasoning_steps] == ["observed", "decided"]
    dumped = card.model_dump(by_alias=True)
    assert dumped["reasoningSteps"][0] == {"label": "observed", "detail": "saw a signal"}


def test_reasoning_steps_default_empty() -> None:
    card = GeneratedCard.model_validate(_card_payload())
    assert card.reasoning_steps == []


def test_reasoning_step_label_normalized() -> None:
    # LLM 偶发 "Cross-referenced" / "Pattern matched" 大小写连字符变体,
    # before-validator 归一化而不是让整张卡验证失败。
    step = ReasoningStep.model_validate({"label": "Cross-referenced", "detail": "d"})
    assert step.label == "cross_referenced"
    step2 = ReasoningStep.model_validate({"label": "Pattern matched", "detail": "d"})
    assert step2.label == "pattern_matched"


def test_reasoning_step_detail_clipped_not_rejected() -> None:
    step = ReasoningStep.model_validate({"label": "observed", "detail": "x" * 500})
    assert len(step.detail) == 200
