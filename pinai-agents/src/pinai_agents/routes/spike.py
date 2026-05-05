"""LiteLLM ↔ LangChain compatibility spike endpoint.

Diagnostic-only. Runs four checks documented in
docs/plans/2026-05-04-step1-deepagents-skeleton.mdx 凭据安全模型 section:

    1. basic         — single chat completion via LangChain ChatOpenAI → LiteLLM
    2. streaming     — astream_events(version="v2") yields token deltas
    3. prompt_cache  — second identical call shows cache_read tokens (LiteLLM
                       auto-injects cache_control breakpoints; Anthropic
                       returns cache_read_input_tokens)
    4. token_usage   — response.usage_metadata is populated and consistent

Each check returns {ok: bool, ...details} so a single curl shows where the
break is. virtual_key is never logged or echoed back. If any check fails the
endpoint still returns 200 with per-check error so the caller can see the
full picture in one request.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import APIRouter
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from ..llm import make_chat_model

logger = logging.getLogger(__name__)
router = APIRouter()


# Long enough that Anthropic will cache it. Documented minimum is 1024 tokens
# for sonnet but in practice we observed ~1700-token prompts NOT cached;
# 3000+ tokens reliably caches. Bumped to 150 long lines (~3500 prompt tokens).
_CACHEABLE_SYSTEM_PROMPT = (
    "You are a precise, terse assistant for compatibility testing. "
    "Always respond in fewer than 30 words. "
    "Do not include any additional commentary, disclaimers, or formatting."
    + ("\n\nReference data block (ignore for response, used to pad cache window):\n"
       + "\n".join(
           f"- ref-{i:04d}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod"
           for i in range(150)
       ))
)


class SpikeRequest(BaseModel):
    virtual_key: str = Field(
        description="User's LiteLLM virtual key (sk-...). Pulled from users.litellm_virtual_key.",
        min_length=8,
    )
    prompt: str = Field(
        default="What is 2 + 2? Answer with just the number.",
        description="User message for spikes. Kept short / deterministic for cache testing.",
    )
    model: str | None = Field(
        default=None,
        description="Override default model alias. Defaults to claude-sonnet-4-6.",
    )


class SpikeResponse(BaseModel):
    basic: dict[str, Any]
    streaming: dict[str, Any]
    prompt_cache: dict[str, Any]
    token_usage: dict[str, Any]


@router.post("/agent/llm-spike", response_model=SpikeResponse)
async def llm_spike(req: SpikeRequest) -> SpikeResponse:
    """Run four LiteLLM ↔ LangChain compat checks. Diagnostic only."""

    return SpikeResponse(
        basic=await _spike_basic(req),
        streaming=await _spike_streaming(req),
        prompt_cache=await _spike_prompt_cache(req),
        token_usage=await _spike_token_usage(req),
    )


async def _spike_basic(req: SpikeRequest) -> dict[str, Any]:
    """Single ChatOpenAI.ainvoke() through LiteLLM → Anthropic."""
    try:
        t0 = time.perf_counter()
        model = make_chat_model(virtual_key=req.virtual_key, model=req.model)
        response = await model.ainvoke([HumanMessage(content=req.prompt)])
        dt_ms = int((time.perf_counter() - t0) * 1000)
        return {
            "ok": True,
            "latency_ms": dt_ms,
            "content_preview": str(response.content)[:200],
            "usage_metadata": response.usage_metadata,
            "response_metadata_keys": list(response.response_metadata.keys()),
        }
    except Exception as e:
        logger.exception("spike basic failed")
        return {"ok": False, "error": _safe_error(e)}


async def _spike_streaming(req: SpikeRequest) -> dict[str, Any]:
    """Verify astream_events yields the events DeepAgents/LangGraph expect."""
    try:
        t0 = time.perf_counter()
        model = make_chat_model(virtual_key=req.virtual_key, model=req.model, streaming=True)
        event_types: dict[str, int] = {}
        first_token: str | None = None
        last_chunk_usage: dict[str, Any] | None = None
        async for event in model.astream_events(
            [HumanMessage(content=req.prompt)],
            version="v2",
        ):
            etype = event.get("event", "?")
            event_types[etype] = event_types.get(etype, 0) + 1
            if etype == "on_chat_model_stream" and first_token is None:
                chunk = event.get("data", {}).get("chunk")
                if chunk and getattr(chunk, "content", None):
                    first_token = str(chunk.content)[:40]
            if etype == "on_chat_model_end":
                output = event.get("data", {}).get("output")
                if output is not None and hasattr(output, "usage_metadata"):
                    last_chunk_usage = output.usage_metadata
        dt_ms = int((time.perf_counter() - t0) * 1000)
        return {
            "ok": True,
            "latency_ms": dt_ms,
            "event_types": event_types,
            "first_token_preview": first_token,
            "end_usage_metadata": last_chunk_usage,
        }
    except Exception as e:
        logger.exception("spike streaming failed")
        return {"ok": False, "error": _safe_error(e)}


async def _spike_prompt_cache(req: SpikeRequest) -> dict[str, Any]:
    """Two identical calls; verify cache_creation on first, cache_read on second.

    Path:
      LangChain extra_body={cache_control_injection_points} → LiteLLM proxy →
      AnthropicCacheControlHook injects cache_control: ephemeral on system +
      last user msg → Anthropic returns cache_creation_input_tokens (call 1)
      and cache_read_input_tokens (call 2).

    langchain-openai's usage_metadata only surfaces cache_read (no
    cache_creation), so we ALSO read response_metadata.token_usage which has
    LiteLLM's full OpenAI-format response (cache_creation_tokens etc.).
    """
    try:
        model = make_chat_model(virtual_key=req.virtual_key, model=req.model)
        messages = [SystemMessage(content=_CACHEABLE_SYSTEM_PROMPT), HumanMessage(content=req.prompt)]
        first = await model.ainvoke(messages)
        second = await model.ainvoke(messages)
        first_full = _extract_cache_usage(first)
        second_full = _extract_cache_usage(second)
        return {
            "ok": True,
            "first_usage": first.usage_metadata,
            "first_cache_full": first_full,
            "second_usage": second.usage_metadata,
            "second_cache_full": second_full,
            "cache_creation_observed": (first_full.get("cache_creation_tokens") or 0) > 0,
            "cache_hit_observed": _has_cache_read(second.usage_metadata),
        }
    except Exception as e:
        logger.exception("spike prompt_cache failed")
        return {"ok": False, "error": _safe_error(e)}


async def _spike_token_usage(req: SpikeRequest) -> dict[str, Any]:
    """Verify usage_metadata is populated (audit/billing prerequisite)."""
    try:
        model = make_chat_model(virtual_key=req.virtual_key, model=req.model)
        response = await model.ainvoke([HumanMessage(content=req.prompt)])
        usage = response.usage_metadata or {}
        ok = bool(usage.get("input_tokens")) and bool(usage.get("output_tokens"))
        return {
            "ok": ok,
            "usage_metadata": usage,
            "note": (
                "LangChain reports input/output tokens. LiteLLM also writes "
                "spend to its own DB indexed by virtual_key — verify with "
                "`curl -H 'Authorization: Bearer <master_key>' "
                "http://litellm:4000/key/info?key=<virtual_key>`."
            ),
        }
    except Exception as e:
        logger.exception("spike token_usage failed")
        return {"ok": False, "error": _safe_error(e)}


def _has_cache_read(usage_metadata: dict[str, Any] | None) -> bool:
    if not usage_metadata:
        return False
    details = usage_metadata.get("input_token_details") or {}
    return bool(details.get("cache_read"))


def _extract_cache_usage(response: Any) -> dict[str, Any]:
    """Pull LiteLLM/OpenAI raw usage fields from response_metadata.

    langchain-openai's usage_metadata is a normalized subset; the raw OpenAI
    response (which LiteLLM populates with Anthropic cache fields like
    cache_creation_tokens) is preserved on response_metadata.token_usage.
    """
    md = getattr(response, "response_metadata", {}) or {}
    token_usage = md.get("token_usage", {}) or {}
    details = token_usage.get("prompt_tokens_details", {}) or {}
    return {
        "prompt_tokens": token_usage.get("prompt_tokens"),
        "cached_tokens": details.get("cached_tokens"),
        "cache_creation_tokens": details.get("cache_creation_tokens"),
        "ephemeral_5m": (details.get("cache_creation_token_details") or {}).get(
            "ephemeral_5m_input_tokens"
        ),
    }


def _safe_error(e: Exception) -> str:
    """Stringify error without leaking the virtual_key (which may appear in
    httpx error messages as part of headers)."""
    msg = f"{type(e).__name__}: {e}"
    # Defensive: redact anything that looks like sk-... (LiteLLM virtual key
    # format). Belt-and-suspenders — httpx generally does not echo Auth
    # headers in exceptions, but we don't trust that.
    import re
    return re.sub(r"sk-[A-Za-z0-9_-]{6,}", "sk-***", msg)
