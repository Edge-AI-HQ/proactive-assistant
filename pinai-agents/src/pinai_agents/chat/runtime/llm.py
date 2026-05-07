"""LangChain model factory.

Always goes through LiteLLM (OpenAI-compatible URL). The master Anthropic key
never lands here — only LiteLLM holds it. Per-user virtual keys are passed
in by the caller (request body in Step 1.2 spike, request JWT in Step 2+).

Why ChatOpenAI and not ChatAnthropic:
  LiteLLM is OpenAI-API-shaped. Pointing langchain-anthropic at LiteLLM would
  require Anthropic-format requests (LiteLLM's /v1/messages path), which is
  not what `init_chat_model` does by default. langchain-openai → LiteLLM →
  Anthropic-format is the documented LiteLLM integration path.

Cache control:
  LiteLLM v1.82 has a known proxy bug: `cache_control_injection_points`
  declared in model_list[].litellm_params (litellm_config.yaml) is NOT
  propagated into the per-request `non_default_params`, so the
  AnthropicCacheControlHook never fires. We side-step it by passing the
  injection points as `extra_body` per request, which LiteLLM does
  propagate. Verified Step 1.2 spike: cache_creation 2049 first call,
  cache_read 2049 second.

Extended thinking:
  Default ON for chat / generator. Anthropic's thinking parameter forwards
  through LiteLLM unchanged so the model can reason internally for higher-
  quality answers. To surface thinking text downstream we use the
  `ChatLiteLLMReasoning` subclass below — stock langchain-openai 1.2.1
  drops `delta.reasoning_content` because its `_convert_delta_to_message_chunk`
  only handles function_call / tool_calls. Our subclass converts each
  chunk's content into v1 protocol blocks
  (`[{"type":"reasoning","reasoning":"…"}, {"type":"text","text":"…"}]`)
  and we set `output_version="v1"` on the model so langchain-openai keeps
  it that way through aggregation. This is the same shape ChatAnthropic
  produces natively and the only shape LangSmith UI renders as a
  thinking block (per its `log-llm-trace` schema). The aggregated final
  AIMessage carries the full reasoning + text in `content` as a typed
  list, which flows through the Postgres checkpointer and the
  `/agent/chat/history` reader unchanged.
  Anthropic constraint: when thinking is enabled, temperature MUST be 1.0
  (the API rejects other values). We force it.
"""

from typing import Any

from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatResult
from langchain_openai import ChatOpenAI

from ...config import get_chat_settings

settings = get_chat_settings()


# LiteLLM AnthropicCacheControlHook injection points. Mirrors what was
# (intended to be) in litellm_config.yaml. Two breakpoints:
# - system message: stable per-agent system prompt
# - last user message: tail of conversation, includes the new turn's context
# Anthropic cache TTL is 5min ephemeral; this matches typical agent loop
# turnaround (subagent dispatch + LLM call < 5min).
_DEFAULT_CACHE_INJECTION_POINTS = [
    {"location": "message", "role": "system"},
    {"location": "message", "role": "user", "index": -1},
]

# Default budget for extended thinking. 5000 tokens covers most chat /
# card-chat reasoning without huge latency hit. Generator agent overrides
# to a higher budget (it does multi-phase plan + generate + self-review).
_DEFAULT_THINKING_BUDGET = 5000


class ChatLiteLLMReasoning(ChatOpenAI):
    """ChatOpenAI variant that surfaces LiteLLM's `delta.reasoning_content`
    as a v1-protocol reasoning content block.

    Stock `langchain-openai`'s chunk converter only handles `function_call`
    and `tool_calls`; reasoning text is silently dropped. LiteLLM's
    OpenAI-compatible adapter exposes Anthropic extended thinking via
    `delta.reasoning_content` (streaming) and `message.reasoning_content`
    (non-streaming).

    We attach it as a `{"type":"reasoning","reasoning":"…"}` block in the
    chunk's `content` list (alongside any text block from the same delta).
    Combined with `output_version="v1"` on the model, langchain-openai
    keeps the list shape through chunk aggregation and the openai
    Responses-API translator passes reasoning blocks through as-is. The
    aggregated final AIMessage's `content` is the v1 protocol shape that
    LangSmith renders as a thinking block, the Postgres checkpointer
    persists, and the chat history endpoint replays.
    """

    def _convert_chunk_to_generation_chunk(
        self,
        chunk: dict,
        default_chunk_class: type,
        base_generation_info: dict | None,
    ):
        gen = super()._convert_chunk_to_generation_chunk(
            chunk, default_chunk_class, base_generation_info
        )
        if gen is None:
            return gen
        choices = chunk.get("choices") or chunk.get("chunk", {}).get("choices") or []
        if not choices:
            return gen
        delta = choices[0].get("delta") or {}
        reasoning = delta.get("reasoning_content")
        if not (reasoning and isinstance(gen.message, AIMessageChunk)):
            return gen

        # Build a v1-protocol content list: reasoning first, text after
        # (matches Anthropic's actual block ordering). Whatever the base
        # converter produced for this chunk's text — be it a non-empty
        # string or an existing block list — gets carried over.
        existing = gen.message.content
        new_content: list[dict[str, Any]] = [
            {"type": "reasoning", "reasoning": reasoning},
        ]
        if isinstance(existing, str) and existing:
            new_content.append({"type": "text", "text": existing})
        elif isinstance(existing, list):
            new_content.extend(existing)
        gen.message.content = new_content
        return gen

    def _create_chat_result(
        self,
        response: Any,
        generation_info: dict | None = None,
    ) -> ChatResult:
        """Non-streaming counterpart of `_convert_chunk_to_generation_chunk`.

        Hit when the model is invoked with `response_format=` (structured
        output) — langchain-openai routes that through OpenAI's `parse()`
        endpoint, which is non-streaming and bypasses the chunk converter.
        We pull `reasoning_content` from the raw response and prepend a
        v1 reasoning block to each generation's content so traces and
        downstream consumers see the same shape as the streaming path.
        """
        result = super()._create_chat_result(response, generation_info)
        response_dict = (
            response if isinstance(response, dict) else response.model_dump()
        )
        for gen, choice in zip(
            result.generations, response_dict.get("choices") or [], strict=False
        ):
            reasoning = (choice.get("message") or {}).get("reasoning_content")
            if not (reasoning and isinstance(gen.message, AIMessage)):
                continue
            existing = gen.message.content
            new_content: list[dict[str, Any]] = [
                {"type": "reasoning", "reasoning": reasoning},
            ]
            if isinstance(existing, str) and existing:
                new_content.append({"type": "text", "text": existing})
            elif isinstance(existing, list):
                new_content.extend(existing)
            gen.message.content = new_content
        return result


def make_chat_model(
    *,
    virtual_key: str,
    model: str | None = None,
    temperature: float = 0.7,
    streaming: bool = False,
    enable_prompt_cache: bool = True,
    enable_thinking: bool = True,
    thinking_budget: int = _DEFAULT_THINKING_BUDGET,
) -> ChatOpenAI:
    """Build a ChatOpenAI bound to LiteLLM with a per-user virtual key.

    Args:
        virtual_key: User's LiteLLM virtual key (sk-...). Comes from
            users.litellm_virtual_key. NOT the master key.
        model: LiteLLM model alias. Defaults to claude-sonnet-4-6.
        temperature: 0.0–1.0. Forced to 1.0 if enable_thinking
            (Anthropic constraint).
        streaming: Whether to enable token-level streaming.
        enable_prompt_cache: Inject cache_control on system + last user
            message via LiteLLM's AnthropicCacheControlHook.
        enable_thinking: Enable Claude extended thinking (reasoning). On
            by default for answer quality. Internal scratchpad only —
            content does not reach the UI.
        thinking_budget: Max thinking tokens. 5000 = chat default;
            generator overrides higher.
    """
    extra_body: dict[str, Any] = {}
    if enable_prompt_cache:
        extra_body["cache_control_injection_points"] = _DEFAULT_CACHE_INJECTION_POINTS
    if enable_thinking:
        extra_body["thinking"] = {"type": "enabled", "budget_tokens": thinking_budget}
        # Anthropic rejects non-1.0 temperature with thinking enabled.
        temperature = 1.0

    return ChatLiteLLMReasoning(
        model=model or settings.default_model,
        api_key=virtual_key,  # pyright: ignore[reportArgumentType]
        base_url=settings.litellm_base_url,
        temperature=temperature,
        streaming=streaming,
        stream_usage=True,
        # Opt into langchain-core 1.x v1 content-block protocol — required
        # for reasoning blocks (see ChatLiteLLMReasoning above) to flow
        # through aggregation, persistence, and LangSmith trace UI as a
        # typed list rather than collapsing back to bare-string content.
        output_version="v1",
        extra_body=extra_body or None,
    )
