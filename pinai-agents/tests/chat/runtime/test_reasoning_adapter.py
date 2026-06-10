from __future__ import annotations

from importlib import import_module
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage


def test_chat_prompts_do_not_request_inline_thinking_tags() -> None:
    root = Path(__file__).resolve().parents[3]
    prompt_paths = [
        root / "src" / "pinai_agents" / "chat" / "agents" / "main_chat.py",
        root / "src" / "pinai_agents" / "chat" / "agents" / "card_execution.py",
    ]

    for prompt_path in prompt_paths:
        text = prompt_path.read_text()
        assert "<thinking_protocol>" not in text
        assert "<thinking>" not in text
        assert "<think>" not in text


def test_main_chat_prompt_treats_card_context_as_current_card() -> None:
    root = Path(__file__).resolve().parents[3]
    prompt_source = root / "src" / "pinai_agents" / "chat" / "agents" / "main_chat.py"

    text = prompt_source.read_text()

    assert "<card_context>" in text
    assert "exact card" in text
    assert "Do not call `cards_recent`" in text


def test_card_execution_prompt_treats_user_correction_as_card_feedback() -> None:
    root = Path(__file__).resolve().parents[3]
    prompt_source = root / "src" / "pinai_agents" / "chat" / "agents" / "card_execution.py"

    text = prompt_source.read_text()

    assert "<card_context>" in text
    assert "feedback on this exact card" in text
    assert "preference_add" in text
    assert "MUST call `preference_add`" in text
    assert "Do not say you remembered" in text
    assert "card_id" in text
    assert "Do not call `cards_recent`" in text


def test_reasoning_extractor_reads_openai_response_summary() -> None:
    try:
        module = import_module("pinai_agents.chat.harness.reasoning")
    except ModuleNotFoundError as exc:
        pytest.fail(f"reasoning adapter module is missing: {exc}")

    extract_reasoning_text = getattr(module, "extract_reasoning_text", None)
    assert callable(extract_reasoning_text)

    response = {
        "output": [
            {
                "type": "reasoning",
                "summary": [
                    {
                        "type": "summary_text",
                        "text": "Checked recent signals and cards first.",
                    }
                ],
            },
            {
                "type": "message",
                "content": [{"type": "output_text", "text": "Here is the answer."}],
            },
        ]
    }

    assert extract_reasoning_text(response) == "Checked recent signals and cards first."


def test_reasoning_extractor_reads_responses_streaming_summary_blocks() -> None:
    try:
        module = import_module("pinai_agents.chat.harness.reasoning")
    except ModuleNotFoundError as exc:
        pytest.fail(f"reasoning adapter module is missing: {exc}")

    extract_reasoning_text = getattr(module, "extract_reasoning_text", None)
    assert callable(extract_reasoning_text)

    chunk_content = [
        {
            "type": "reasoning",
            "summary": [
                {
                    "type": "summary_text",
                    "text": "Summarized the model's real reasoning.",
                }
            ],
        }
    ]

    assert extract_reasoning_text(chunk_content) == "Summarized the model's real reasoning."


def test_reasoning_extractor_keeps_litellm_reasoning_content_support() -> None:
    try:
        module = import_module("pinai_agents.chat.harness.reasoning")
    except ModuleNotFoundError as exc:
        pytest.fail(f"reasoning adapter module is missing: {exc}")

    extract_reasoning_text = getattr(module, "extract_reasoning_text", None)
    assert callable(extract_reasoning_text)

    message = {
        "reasoning_content": "Claude/LiteLLM streamed this reasoning block.",
        "content": "Here is the answer.",
    }

    assert extract_reasoning_text(message) == "Claude/LiteLLM streamed this reasoning block."


def test_reasoning_extractor_keeps_claude_v1_reasoning_block_support() -> None:
    try:
        module = import_module("pinai_agents.chat.harness.reasoning")
    except ModuleNotFoundError as exc:
        pytest.fail(f"reasoning adapter module is missing: {exc}")

    extract_reasoning_text = getattr(module, "extract_reasoning_text", None)
    assert callable(extract_reasoning_text)

    content = [{"type": "reasoning", "reasoning": "Claude v1 reasoning text."}]

    assert extract_reasoning_text(content) == "Claude v1 reasoning text."


def test_gpt55_uses_high_effort_responses_api_reasoning_summary_protocol() -> None:
    try:
        module = import_module("pinai_agents.chat.harness.reasoning")
    except ModuleNotFoundError as exc:
        pytest.fail(f"reasoning adapter module is missing: {exc}")

    build_reasoning_options = getattr(module, "build_reasoning_options", None)
    assert callable(build_reasoning_options)

    options = build_reasoning_options(
        model="gpt-5.5",
        enable_prompt_cache=True,
        enable_thinking=True,
        thinking_budget=5000,
    )

    assert options.extra_body == {}
    assert options.use_responses_api is True
    assert options.output_version == "responses/v1"
    assert options.reasoning == {"effort": "high", "summary": "auto"}
    assert options.include == ["reasoning.encrypted_content"]
    assert options.use_previous_response_id is True
    assert options.force_temperature_one is False


def test_claude_model_still_uses_anthropic_thinking_protocol() -> None:
    try:
        module = import_module("pinai_agents.chat.harness.reasoning")
    except ModuleNotFoundError as exc:
        pytest.fail(f"reasoning adapter module is missing: {exc}")

    build_reasoning_options = getattr(module, "build_reasoning_options", None)
    assert callable(build_reasoning_options)

    options = build_reasoning_options(
        model="claude-sonnet-4-6",
        enable_prompt_cache=True,
        enable_thinking=True,
        thinking_budget=5000,
    )

    # cache_control injection is now config-driven (ops/litellm/litellm_config.yaml),
    # no longer per-request extra_body — see reasoning.py. extra_body carries thinking only.
    assert options.extra_body == {
        "thinking": {"type": "enabled", "budget_tokens": 5000},
    }
    assert options.use_responses_api is False
    assert options.output_version == "v1"
    assert options.reasoning is None
    assert options.include is None
    assert options.force_temperature_one is True


def test_kimi_model_forces_temperature_one_even_without_thinking() -> None:
    try:
        module = import_module("pinai_agents.chat.harness.reasoning")
    except ModuleNotFoundError as exc:
        pytest.fail(f"reasoning adapter module is missing: {exc}")

    build_reasoning_options = getattr(module, "build_reasoning_options", None)
    assert callable(build_reasoning_options)

    # Moonshot rejects any temperature other than 1 for Kimi thinking-series
    # models, independent of our enable_thinking flag.
    for enable_thinking in (True, False):
        options = build_reasoning_options(
            model="kimi-k2.6",
            enable_prompt_cache=True,
            enable_thinking=enable_thinking,
            thinking_budget=5000,
        )
        assert options.force_temperature_one is True
        # Kimi is neither Claude nor an OpenAI reasoning model: no thinking
        # params should be injected.
        assert options.extra_body == {}
        assert options.use_responses_api is False
        assert options.reasoning is None


def test_openai_responses_reasoning_keeps_streaming_enabled() -> None:
    try:
        module = import_module("pinai_agents.chat.harness.reasoning")
    except ModuleNotFoundError as exc:
        pytest.fail(f"reasoning adapter module is missing: {exc}")

    build_reasoning_options = getattr(module, "build_reasoning_options", None)
    assert callable(build_reasoning_options)

    options = build_reasoning_options(
        model="openai/gpt-5.5",
        enable_prompt_cache=True,
        enable_thinking=True,
        thinking_budget=5000,
    )

    assert options.allow_streaming is True


def test_streaming_reasoning_deltas_keep_token_boundary_whitespace() -> None:
    # Regression (kimi-k2.6): reasoning_content streams as token-level
    # fragments (" is", " asking"). The chunk converter must NOT strip them —
    # stripping shaves the boundary spaces and the aggregated thinking text
    # runs its words together ("Theuserisasking…").
    from langchain_core.messages import AIMessageChunk

    from pinai_agents.chat.harness.llm import ChatLiteLLMReasoning

    model = ChatLiteLLMReasoning(
        model="kimi-k2.6",
        api_key="sk-test",
        base_url="http://example.invalid/v1",
        output_version="v1",
    )

    def chunk_of(fragment: str) -> dict:
        return {
            "id": "chatcmpl-x",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "kimi-k2.6",
            "choices": [
                {
                    "index": 0,
                    "delta": {"content": "", "reasoning_content": fragment},
                    "finish_reason": None,
                }
            ],
        }

    fragments = ["The user", " is asking", " casually."]
    merged: AIMessageChunk | None = None
    for fragment in fragments:
        gen = model._convert_chunk_to_generation_chunk(chunk_of(fragment), AIMessageChunk, None)
        assert gen is not None and isinstance(gen.message, AIMessageChunk)
        reasoning_blocks = [
            b for b in gen.message.content if isinstance(b, dict) and b.get("type") == "reasoning"
        ]
        # Each delta's fragment survives verbatim — leading space intact.
        assert [b.get("reasoning") for b in reasoning_blocks] == [fragment]
        merged = gen.message if merged is None else merged + gen.message
    assert merged is not None
    merged_reasoning = "".join(
        b.get("reasoning", "")
        for b in merged.content
        if isinstance(b, dict) and b.get("type") == "reasoning"
    )
    assert merged_reasoning == "The user is asking casually."


def test_openai_responses_payload_drops_legacy_call_ids_from_message_ids() -> None:
    from pinai_agents.chat.harness.llm import ChatLiteLLMReasoning

    model = ChatLiteLLMReasoning(
        model="gpt-5.5",
        api_key="sk-test",
        base_url="http://example.invalid/v1",
        use_responses_api=True,
        output_version="responses/v1",
        reasoning={"effort": "medium", "summary": "detailed"},
        include=["reasoning.encrypted_content"],
    )

    payload = model._get_request_payload(
        [
            HumanMessage(content="hi"),
            AIMessage(
                content=[
                    {
                        "type": "text",
                        "id": "call_bad",
                        "name": "signals_recent",
                        "text": "<thinking>old prompt fallback text</thinking>",
                    },
                    {"type": "tool_call", "id": "call_tool", "name": "memory_list", "args": {}},
                ],
                tool_calls=[{"name": "memory_list", "args": {}, "id": "call_tool"}],
            ),
            ToolMessage(content="[]", tool_call_id="call_tool"),
        ]
    )

    message_ids = [item.get("id") for item in payload["input"] if item.get("type") == "message"]
    assert "call_bad" not in message_ids
    assert any(
        item.get("type") == "function_call" and item.get("call_id") == "call_tool"
        for item in payload["input"]
    )
