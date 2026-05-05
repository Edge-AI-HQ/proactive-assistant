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

Extended thinking (reasoning):
  Default ON for chat / generator. Anthropic's thinking parameter forwards
  through LiteLLM unchanged. LiteLLM streams thinking deltas as
  `delta.reasoning_content` chunks; stock langchain-openai *drops* them
  silently (its docstring explicitly says "reasoning_content is not
  extracted; use a provider-specific subclass"). We subclass ChatOpenAI
  below to surface reasoning into chunk.additional_kwargs so the SSE
  bridge in streaming.py can emit chat:reasoning:delta to the frontend.

  Anthropic constraint: when thinking is enabled, temperature MUST be 1.0
  (the API rejects other values). We force it.
"""

import logging
from typing import Any, ClassVar

from langchain_core.messages import AIMessageChunk
from langchain_core.outputs import ChatGenerationChunk
from langchain_openai import ChatOpenAI

from .config import settings

logger = logging.getLogger(__name__)

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


class ReasoningChatOpenAI(ChatOpenAI):
    """ChatOpenAI subclass that surfaces LiteLLM/Anthropic reasoning_content.

    Stock langchain-openai docs (chat_models/base.py): "reasoning_content,
    reasoning_details are not extracted. Use a provider-specific subclass
    for ...". LiteLLM forwards Anthropic's thinking output as
    `delta.reasoning_content` in streaming chunks. We post-process each
    chunk to merge reasoning_content into the message's additional_kwargs
    so streaming.py can emit chat:reasoning:delta to the frontend.

    Override scope is intentionally narrow — only `_convert_chunk_to_generation_chunk`,
    which the parent class calls per stream chunk. All other behavior
    (tools, retries, structured output, etc.) is unchanged.

    Defensive degradation:
      The override touches a langchain-openai internal method (the
      underscore prefix). If a future langchain-openai release renames /
      refactors AIMessageChunk fields or changes return types, our
      reconstruction can fail. We catch ALL exceptions in the inject
      branch, set a process-wide disable flag (so we don't keep failing on
      every chunk), log a warning ONCE, and fall back to the parent
      class's behavior.

      End user impact when degraded:
        - Chat keeps working (final text streams normally)
        - Thinking display falls back to status-only (`chat:thinking` open
          signal, no `chat:reasoning:delta` events)
        - Frontend Reasoning component receives no parts → renders nothing
        - User sees the assistant reply without the thinking trace

      This matches the deepagents-cli upstream UX exactly (their CLI shows
      a thinking spinner with no content), so degraded mode is acceptable
      production behavior.
    """

    # Process-wide flag set on first reconstruction failure. Skipping the
    # injection branch on subsequent chunks (a) avoids log spam, (b) zeros
    # the per-chunk overhead once we know it's broken.
    #
    # ClassVar is required: ChatOpenAI is a Pydantic v2 BaseModel, and any
    # bare class annotation becomes a model field. Without ClassVar the
    # attribute would resolve to a FieldInfo proxy (always truthy!), which
    # silently disables reasoning extraction every time. Use ClassVar so
    # Pydantic leaves it as a real class variable.
    _reasoning_extract_disabled: ClassVar[bool] = False

    def _convert_chunk_to_generation_chunk(
        self,
        chunk: dict,
        default_chunk_class: type,
        base_generation_info: dict | None,
    ) -> ChatGenerationChunk | None:
        # Always call super first. If super itself raises (LangChain
        # internal break), let it propagate — that's their bug, masking
        # it would just hide a wider chat failure.
        result = super()._convert_chunk_to_generation_chunk(
            chunk, default_chunk_class, base_generation_info,
        )
        if result is None or type(self)._reasoning_extract_disabled:
            return result

        # The injection branch: extract reasoning_content + reconstruct
        # AIMessageChunk. Wrapped in try/except so any unforeseen LangChain
        # internal change (chunk shape, AIMessageChunk fields) gracefully
        # degrades to status-only thinking display.
        try:
            return self._inject_reasoning(chunk, result)
        except Exception as e:
            type(self)._reasoning_extract_disabled = True
            logger.warning(
                "ReasoningChatOpenAI: reasoning_content injection failed "
                "(%s: %s). Disabling for this process; thinking display "
                "degrades to status-only. Chat continues normally.",
                type(e).__name__, e,
            )
            return result

    def _inject_reasoning(
        self,
        chunk: dict,
        result: ChatGenerationChunk,
    ) -> ChatGenerationChunk:
        """Inject LiteLLM `delta.reasoning_content` into the chunk's
        additional_kwargs. Raises on any internal-shape mismatch — caller
        catches and disables for the rest of the process."""
        reasoning_pieces: list[str] = []
        for choice in chunk.get("choices") or []:
            delta = choice.get("delta") or {}
            r = delta.get("reasoning_content")
            if isinstance(r, str) and r:
                reasoning_pieces.append(r)
        if not reasoning_pieces:
            return result

        msg = result.message
        new_kwargs = dict(getattr(msg, "additional_kwargs", None) or {})
        new_kwargs["reasoning_content"] = "".join(reasoning_pieces)

        if isinstance(msg, AIMessageChunk):
            new_msg: AIMessageChunk = msg.__class__(
                content=msg.content,
                additional_kwargs=new_kwargs,
                response_metadata=getattr(msg, "response_metadata", {}) or {},
                tool_call_chunks=list(getattr(msg, "tool_call_chunks", []) or []),
                usage_metadata=getattr(msg, "usage_metadata", None),
                id=getattr(msg, "id", None),
            )
        else:
            new_msg = msg.__class__(  # type: ignore[call-arg]
                content=msg.content,
                additional_kwargs=new_kwargs,
                id=getattr(msg, "id", None),
            )

        return ChatGenerationChunk(
            message=new_msg,
            generation_info=result.generation_info,
        )


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
            by default — matches Claude Code / Manus / etc. defaults.
            Set False for ultra-low-latency simple replies.
        thinking_budget: Max thinking tokens. 5000 = chat default;
            generator overrides higher.

    Returns:
        ReasoningChatOpenAI configured to talk to LiteLLM.
    """
    extra_body: dict[str, Any] = {}
    if enable_prompt_cache:
        extra_body["cache_control_injection_points"] = _DEFAULT_CACHE_INJECTION_POINTS
    if enable_thinking:
        extra_body["thinking"] = {"type": "enabled", "budget_tokens": thinking_budget}
        # Anthropic rejects non-1.0 temperature with thinking enabled.
        temperature = 1.0

    return ReasoningChatOpenAI(
        model=model or settings.default_model,
        api_key=virtual_key,  # pyright: ignore[reportArgumentType]
        base_url=settings.litellm_base_url,
        temperature=temperature,
        streaming=streaming,
        stream_usage=True,
        extra_body=extra_body or None,
    )
