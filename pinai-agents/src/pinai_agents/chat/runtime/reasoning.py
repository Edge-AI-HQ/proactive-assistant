"""Provider-specific reasoning adapters for the chat model factory.

The frontend speaks one local protocol: reasoning text is a distinct content
block, not inline assistant prose. Providers expose that data differently:
Claude/LiteLLM uses ``reasoning_content`` while OpenAI reasoning models expose
reasoning summaries via Responses-style ``reasoning`` items.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

ANTHROPIC_CACHE_INJECTION_POINTS: list[dict[str, str | int]] = [
    {"location": "message", "role": "system"},
    {"location": "message", "role": "user", "index": -1},
]


@dataclass(frozen=True)
class ReasoningOptions:
    extra_body: dict[str, Any]
    force_temperature_one: bool


def is_openai_reasoning_model(model: str | None) -> bool:
    """Return true for OpenAI models whose reasoning is configured via
    ``reasoning={...}``, not Anthropic's ``thinking={...}``.
    """

    if not model:
        return False
    normalized = model.lower().removeprefix("openai/")
    return normalized.startswith(("gpt-5", "o1", "o3", "o4"))


def build_reasoning_options(
    *,
    model: str | None,
    enable_prompt_cache: bool,
    enable_thinking: bool,
    thinking_budget: int,
) -> ReasoningOptions:
    extra_body: dict[str, Any] = {}
    openai_reasoning = is_openai_reasoning_model(model)

    if enable_prompt_cache and not openai_reasoning:
        extra_body["cache_control_injection_points"] = ANTHROPIC_CACHE_INJECTION_POINTS

    if enable_thinking:
        if openai_reasoning:
            extra_body["reasoning"] = {"effort": "medium", "summary": "auto"}
        else:
            extra_body["thinking"] = {
                "type": "enabled",
                "budget_tokens": thinking_budget,
            }

    return ReasoningOptions(
        extra_body=extra_body,
        force_temperature_one=enable_thinking and not openai_reasoning,
    )


def extract_reasoning_text(value: Any) -> str | None:
    """Extract provider reasoning text/summary from known response shapes."""

    pieces: list[str] = []
    _collect_reasoning(value, pieces)
    text = "\n".join(piece.strip() for piece in pieces if piece.strip())
    return text or None


def prepend_reasoning_block(existing: Any, reasoning: str) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [{"type": "reasoning", "reasoning": reasoning}]
    if isinstance(existing, str) and existing:
        content.append({"type": "text", "text": existing})
    elif isinstance(existing, list):
        content.extend(existing)
    return content


def _collect_reasoning(value: Any, pieces: list[str]) -> None:
    if isinstance(value, list):
        for item in value:
            _collect_reasoning(item, pieces)
        return

    if not isinstance(value, dict):
        return

    reasoning_content = value.get("reasoning_content")
    if isinstance(reasoning_content, str):
        pieces.append(reasoning_content)

    reasoning_summary = value.get("reasoning_summary")
    if isinstance(reasoning_summary, str):
        pieces.append(reasoning_summary)
    elif isinstance(reasoning_summary, list):
        _collect_text_items(reasoning_summary, pieces, {"summary_text"})

    reasoning = value.get("reasoning")
    if isinstance(reasoning, dict | list):
        _collect_reasoning(reasoning, pieces)

    if value.get("type") == "reasoning":
        _collect_reasoning_item(value, pieces)

    output = value.get("output")
    if isinstance(output, list):
        for item in output:
            if isinstance(item, dict) and item.get("type") == "reasoning":
                _collect_reasoning_item(item, pieces)

    choices = value.get("choices")
    if isinstance(choices, list):
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            _collect_reasoning(choice.get("delta"), pieces)
            _collect_reasoning(choice.get("message"), pieces)


def _collect_reasoning_item(item: dict[str, Any], pieces: list[str]) -> None:
    summary = item.get("summary")
    if isinstance(summary, list):
        _collect_text_items(summary, pieces, {"summary_text"})

    content = item.get("content")
    if isinstance(content, list):
        _collect_text_items(content, pieces, {"reasoning_text"})


def _collect_text_items(
    items: list[Any],
    pieces: list[str],
    allowed_types: set[str],
) -> None:
    for item in items:
        if isinstance(item, str):
            pieces.append(item)
        elif isinstance(item, dict) and item.get("type") in allowed_types:
            text = item.get("text")
            if isinstance(text, str):
                pieces.append(text)
