"""Provider-specific reasoning adapters for the chat model factory.

The frontend speaks one local protocol: reasoning text is a distinct content
block, not inline assistant prose. Providers expose that data differently:
Claude/LiteLLM uses ``reasoning_content`` while OpenAI reasoning models expose
reasoning summaries via Responses-style ``reasoning`` items.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ReasoningOptions:
    extra_body: dict[str, Any]
    force_temperature_one: bool
    output_version: str
    reasoning: dict[str, Any] | None
    include: list[str] | None
    use_responses_api: bool
    use_previous_response_id: bool
    allow_streaming: bool


def is_openai_reasoning_model(model: str | None) -> bool:
    """Return true for OpenAI models whose reasoning is configured via
    ``reasoning={...}``, not Anthropic's ``thinking={...}``.
    """

    if not model:
        return False
    normalized = model.lower().removeprefix("openai/")
    return normalized.startswith(("gpt-5", "o1", "o3", "o4"))


def is_claude_model(model: str | None) -> bool:
    """Return true for Anthropic Claude aliases across LiteLLM providers."""

    if not model:
        return False
    normalized = model.lower()
    return "claude" in normalized or "anthropic." in normalized


def build_reasoning_options(
    *,
    model: str | None,
    enable_prompt_cache: bool,
    enable_thinking: bool,
    thinking_budget: int,
) -> ReasoningOptions:
    extra_body: dict[str, Any] = {}
    openai_reasoning = is_openai_reasoning_model(model)
    claude_reasoning = is_claude_model(model)
    use_responses_api = False
    output_version = "v1"
    reasoning: dict[str, Any] | None = None
    include: list[str] | None = None
    use_previous_response_id = False
    allow_streaming = True

    # Anthropic prompt-cache injection is owned solely by LiteLLM's config-level
    # `cache_control_injection_points` (ops/litellm/litellm_config.yaml).
    #
    # The old per-request `extra_body` injection here was a workaround for LiteLLM
    # v1.82's "config not propagated" proxy bug. On v1.83.10 (current) the config
    # path works again, so running BOTH paths double-injected cache_control and, on
    # long multi-block requests, pushed the marked-block count past Anthropic's max
    # of 4 — the main-chat 400 "A maximum of 4 blocks with cache_control". Keeping a
    # single source (config) keeps it at system + last-user = 2 blocks.
    #
    # `enable_prompt_cache` is retained in the signature for callers; caching is now
    # config-driven and not toggled per request here.
    _ = enable_prompt_cache

    if enable_thinking:
        if openai_reasoning:
            use_responses_api = True
            use_previous_response_id = True
            output_version = "responses/v1"
            reasoning = {"effort": "high", "summary": "auto"}
            # `summary="auto"` lets OpenAI choose the most detailed summary
            # mode supported by the selected reasoning model.
            # We do not render encrypted_content, but Responses tool-calling
            # loops need it so OpenAI can carry reasoning items across turns.
            include = ["reasoning.encrypted_content"]
            # Let OpenAI keep the response-state pointer instead of replaying
            # large tool/reasoning histories through LiteLLM. This is the
            # recommended Responses pattern for reasoning + function calling.
            # Keep streaming on so visible assistant text still arrives
            # progressively; any real reasoning summaries that stream or land
            # at model end are forwarded by chat/streaming.py.
            allow_streaming = True
        elif claude_reasoning:
            extra_body["thinking"] = {
                "type": "enabled",
                "budget_tokens": thinking_budget,
            }

    return ReasoningOptions(
        extra_body=extra_body,
        force_temperature_one=enable_thinking and claude_reasoning,
        output_version=output_version,
        reasoning=reasoning,
        include=include,
        use_responses_api=use_responses_api,
        use_previous_response_id=use_previous_response_id,
        allow_streaming=allow_streaming,
    )


def extract_reasoning_text(
    value: Any,
    *,
    preserve_whitespace: bool = False,
) -> str | None:
    """Extract provider reasoning text/summary from known response shapes."""

    pieces: list[str] = []
    _collect_reasoning(value, pieces)
    if preserve_whitespace:
        text = "".join(pieces)
        return text if text else None
    text = "\n".join(piece.strip() for piece in pieces if piece.strip())
    return text or None


def prepend_reasoning_block(existing: Any, reasoning: str) -> list[str | dict[str, Any]]:
    content: list[str | dict[str, Any]] = [{"type": "reasoning", "reasoning": reasoning}]
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
    if isinstance(reasoning, str):
        pieces.append(reasoning)
    elif isinstance(reasoning, dict | list):
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
