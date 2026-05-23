from __future__ import annotations

from importlib import import_module
from pathlib import Path

import pytest


def test_main_chat_prompt_does_not_request_inline_thinking_tags() -> None:
    root = Path(__file__).resolve().parents[3]
    prompt_source = root / "src" / "pinai_agents" / "chat" / "agents" / "main_chat.py"

    text = prompt_source.read_text()

    assert "<thinking_protocol>" not in text
    assert "<thinking>" not in text
    assert "<think>" not in text


def test_reasoning_extractor_reads_openai_response_summary() -> None:
    try:
        module = import_module("pinai_agents.chat.runtime.reasoning")
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


def test_reasoning_extractor_keeps_litellm_reasoning_content_support() -> None:
    try:
        module = import_module("pinai_agents.chat.runtime.reasoning")
    except ModuleNotFoundError as exc:
        pytest.fail(f"reasoning adapter module is missing: {exc}")

    extract_reasoning_text = getattr(module, "extract_reasoning_text", None)
    assert callable(extract_reasoning_text)

    message = {
        "reasoning_content": "Claude/LiteLLM streamed this reasoning block.",
        "content": "Here is the answer.",
    }

    assert extract_reasoning_text(message) == "Claude/LiteLLM streamed this reasoning block."


def test_openai_reasoning_model_uses_summary_protocol_not_anthropic_thinking() -> None:
    try:
        module = import_module("pinai_agents.chat.runtime.reasoning")
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

    assert options.extra_body == {"reasoning": {"effort": "medium", "summary": "auto"}}
    assert options.force_temperature_one is False
