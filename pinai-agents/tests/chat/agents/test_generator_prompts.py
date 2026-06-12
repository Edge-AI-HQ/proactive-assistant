"""Prompt rendering + structured-stage tool_choice guards.

Stage prompt bodies are full of literal braces (JSON examples, set notation
like ``{gmail, ...}``), which makes ``str.format()`` a landmine: it parses
every ``{...}`` as a replacement field and raises KeyError. It bit twice —
first the card-generator prompt's JSON examples, then PR #70's connector
list in the planner prompt (``KeyError: 'gmail, google_calendar, slack,
github, google_drive'`` on every generate). Templates now render through
``_render_prompt`` (sentinel replace, no escaping); these tests pin that
contract and the kimi-compatible ``tool_choice="required"`` invocation.
"""

from __future__ import annotations

import inspect
from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableLambda
from pydantic import BaseModel

from pinai_agents.chat.agents import generator as generator_module
from pinai_agents.chat.agents.generator import (
    _CARD_GENERATOR_PROMPT,
    _EVALUATOR_PROMPT,
    _FINAL_SELECTION_PROMPT,
    _PLANNER_PROMPT,
    _invoke_structured_stage,
    _render_prompt,
)


def test_planner_prompt_renders_with_real_placeholder() -> None:
    rendered = _render_prompt(_PLANNER_PROMPT, cards_to_generate="12")
    assert "{cards_to_generate}" not in rendered
    assert "1-12 planned" in rendered
    # PR #70's connector list reaches the LLM as literal text.
    assert "{gmail, google_calendar, slack, github, google_drive}" in rendered


def test_card_generator_prompt_renders_lang_clause() -> None:
    rendered = _render_prompt(_CARD_GENERATOR_PROMPT, lang_clause="Respond in English.")
    assert "{lang_clause}" not in rendered
    assert "Respond in English." in rendered


def test_render_prompt_rejects_unknown_sentinel() -> None:
    with pytest.raises(ValueError, match="no placeholder"):
        _render_prompt("body without sentinels", cards_to_generate="3")


@pytest.mark.parametrize(
    "template",
    [_PLANNER_PROMPT, _CARD_GENERATOR_PROMPT, _EVALUATOR_PROMPT, _FINAL_SELECTION_PROMPT],
    ids=["planner", "card_generator", "evaluator", "final_selection"],
)
def test_templates_carry_no_format_escapes(template: str) -> None:
    # ``{{``/``}}`` only mean something to str.format(); under sentinel
    # replace they'd ship verbatim to the LLM.
    assert "{{" not in template
    assert "}}" not in template


def test_prompt_templates_never_use_str_format() -> None:
    source = inspect.getsource(generator_module)
    assert "_PROMPT.format(" not in source


class _Probe(BaseModel):
    value: int


async def test_structured_stage_binds_required_tool_choice() -> None:
    """tool_choice must stay "required": naming the tool (specified) is
    rejected by Moonshot whenever thinking is on, and kimi-k2.6 thinking
    cannot be turned off through LiteLLM."""
    captured: dict[str, object] = {}

    def bind_tools(tools: list[type], tool_choice: object = None) -> RunnableLambda:
        captured["tools"] = tools
        captured["tool_choice"] = tool_choice
        return RunnableLambda(
            lambda _msgs: AIMessage(
                content="",
                tool_calls=[{"name": "_Probe", "args": {"value": 7}, "id": "tc1"}],
            )
        )

    result = await _invoke_structured_stage(
        SimpleNamespace(bind_tools=bind_tools),
        _Probe,
        system="s",
        content="c",
        run_id="run",
        user_id=1,
        stage="planner",
    )
    assert captured["tool_choice"] == "required"
    assert captured["tools"] == [_Probe]
    assert result == _Probe(value=7)


async def test_structured_stage_retries_prose_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A prose answer (no tool call) parses to None and must be retried,
    not returned."""
    monkeypatch.setattr(generator_module, "_STRUCTURED_STAGE_RETRY_BACKOFF_S", 0.0)
    calls = {"n": 0}

    def bind_tools(tools: list[type], tool_choice: object = None) -> RunnableLambda:
        def respond(_msgs: object) -> AIMessage:
            calls["n"] += 1
            if calls["n"] == 1:
                return AIMessage(content="let me think about that")
            return AIMessage(
                content="",
                tool_calls=[{"name": "_Probe", "args": {"value": 1}, "id": "tc1"}],
            )

        return RunnableLambda(respond)

    result = await _invoke_structured_stage(
        SimpleNamespace(bind_tools=bind_tools),
        _Probe,
        system="s",
        content="c",
        run_id="run",
        user_id=1,
        stage="planner",
    )
    assert calls["n"] == 2
    assert result == _Probe(value=1)


def test_card_generator_prompt_title_is_action_first() -> None:
    rendered = _render_prompt(_CARD_GENERATOR_PROMPT, lang_clause="x")
    assert "ACTION-FIRST" in rendered
    assert "70 chars" in rendered
    # 旧"事实先行"公式必须从生成规则里消失
    assert 'built as "concrete fact / number / time' not in rendered


def test_card_generator_prompt_requires_reasoning_steps() -> None:
    rendered = _render_prompt(_CARD_GENERATOR_PROMPT, lang_clause="x")
    assert "reasoningSteps" in rendered
    assert "`observed` /" in rendered


def test_evaluator_prompt_audits_reasoning_steps_and_action_first_title() -> None:
    assert "reasoningSteps` are audited the same way" in _EVALUATOR_PROMPT
    assert "action-first formula" in _EVALUATOR_PROMPT
    assert "concrete fact / number / time + human stake" not in _EVALUATOR_PROMPT


def test_card_generator_prompt_has_good_bad_title_examples() -> None:
    rendered = _render_prompt(_CARD_GENERATOR_PROMPT, lang_clause="x")
    assert "Review your tech concentration — chip stocks fell 3%" in rendered
    assert "帮你复查科技股持仓集中度" in rendered
    assert "(fact-first)" in rendered


def test_why_now_adds_context_beyond_title() -> None:
    rendered = _render_prompt(_CARD_GENERATOR_PROMPT, lang_clause="x")
    assert "never restate the title" in rendered


def test_evaluator_caps_actionability_for_fact_first_titles() -> None:
    assert "caps actionability" in _EVALUATOR_PROMPT
