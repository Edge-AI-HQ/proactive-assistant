"""LangGraph events → unified SSE envelope.

Envelope shape (defined in shared/sse_envelope.py):

    data: {"type":"chat:delta","ts":<ms>,"traceId":"<run_id>","data":{"delta":"hi"}}

Per-event-type `data` payloads:
  * chat:thinking          — empty
  * chat:delta             — {delta: str}
  * chat:reasoning:delta   — {delta: str}     (Claude extended thinking)
  * chat:tool:start        — {toolCallId, name, argsPreview}
  * chat:tool:result       — {toolCallId, isError, meta}
  * chat:error             — {error: str}
  * chat:done              — empty

Note on extended thinking: agents run with `enable_thinking=True` and
`ChatLiteLLMReasoning` (see runtime/llm.py) re-attaches LiteLLM's
`reasoning_content` onto AIMessageChunk.additional_kwargs. We forward
it as `chat:reasoning:delta` so the frontend can render it in a
collapsible block; the same field also rides along through the Postgres
checkpointer, which is what makes refresh-replay work.

All emit through `emit()` so:
  * The wire is camelCase and stable.
  * Tests can validate envelopes without pulling chat-runtime imports.
  * New event types adopt the envelope by default (browser:* / task:*).

Stream-end semantics: langgraph_to_sse() always emits chat:done in its
finally block, even on errors — the frontend listens for chat:done to
release the "thinking" UI; never landing one would leak the spinner.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

from ..shared.sse_envelope import (
    EV_CHAT_DELTA,
    EV_CHAT_DONE,
    EV_CHAT_ERROR,
    EV_CHAT_REASONING_DELTA,
    EV_CHAT_THINKING,
    EV_CHAT_TOOL_RESULT,
    EV_CHAT_TOOL_START,
    emit,
)

logger = logging.getLogger(__name__)

_ARGS_PREVIEW_LIMIT = 240
_META_LIMIT = 300


def chat_thinking(*, trace_id: str | None = None) -> bytes:
    return emit(EV_CHAT_THINKING, trace_id=trace_id)


def chat_delta(text: str, *, trace_id: str | None = None) -> bytes:
    return emit(EV_CHAT_DELTA, {"delta": text}, trace_id=trace_id)


def chat_reasoning_delta(text: str, *, trace_id: str | None = None) -> bytes:
    return emit(EV_CHAT_REASONING_DELTA, {"delta": text}, trace_id=trace_id)


def chat_tool_start(
    *, tool_call_id: str, name: str, args_preview: str,
    trace_id: str | None = None,
) -> bytes:
    return emit(EV_CHAT_TOOL_START, {
        "toolCallId": tool_call_id,
        "name": name,
        "argsPreview": args_preview[:_ARGS_PREVIEW_LIMIT],
    }, trace_id=trace_id)


def chat_tool_result(
    *, tool_call_id: str, is_error: bool, meta: str,
    trace_id: str | None = None,
) -> bytes:
    return emit(EV_CHAT_TOOL_RESULT, {
        "toolCallId": tool_call_id,
        "isError": is_error,
        "meta": meta[:_META_LIMIT],
    }, trace_id=trace_id)


def chat_error(message: str, *, trace_id: str | None = None) -> bytes:
    return emit(EV_CHAT_ERROR, {"error": message}, trace_id=trace_id)


def chat_done(*, trace_id: str | None = None) -> bytes:
    return emit(EV_CHAT_DONE, trace_id=trace_id)


def _extract_chunk_text(chunk: Any) -> str:
    """Pull user-visible text out of an AIMessageChunk.

    With `output_version="v1"` (see runtime/llm.py) chunks always carry
    list-of-blocks content; we only forward blocks of `type == "text"` —
    reasoning is handled separately, tool_call blocks fan out via
    on_tool_start/end events. Bare-string content is tolerated for any
    legacy / non-v1 producers.
    """
    content = getattr(chunk, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                t = b.get("text")
                if isinstance(t, str):
                    parts.append(t)
        return "".join(parts)
    return ""


def _extract_chunk_reasoning(chunk: Any) -> str:
    """Pull reasoning text out of an AIMessageChunk's v1 content blocks.

    With `output_version="v1"`, extended-thinking deltas appear as
    `{"type":"reasoning","reasoning":"…"}` blocks alongside text. Older
    chunks may still carry the field on `additional_kwargs.reasoning_content`
    (langchain-core compat path); we read both for safety.
    """
    content = getattr(chunk, "content", None)
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "reasoning":
                r = b.get("reasoning")
                if isinstance(r, str):
                    parts.append(r)
        if parts:
            return "".join(parts)
    additional = getattr(chunk, "additional_kwargs", None) or {}
    legacy = additional.get("reasoning_content")
    return legacy if isinstance(legacy, str) else ""


def _safe_preview(value: Any, limit: int = 240) -> str:
    """Best-effort short preview for tool input/output. JSON-encode if dict;
    truncate; never raise."""
    try:
        if isinstance(value, str):
            text = value
        elif isinstance(value, dict | list):
            text = json.dumps(value, ensure_ascii=False)
        else:
            text = str(value)
    except Exception:
        text = "<unrepr>"
    if len(text) > limit:
        return text[: limit - 1] + "…"
    return text


async def langgraph_to_sse(
    events: AsyncIterator[dict[str, Any]],
    *,
    trace_id: str | None = None,
) -> AsyncIterator[bytes]:
    """Translate `agent.astream_events(version='v2')` to chat:* SSE bytes.

    LangGraph fires many event types; we only forward the ones the frontend
    chat runtime knows. Everything else is dropped to keep the wire clean.
    """
    yield chat_thinking(trace_id=trace_id)
    try:
        async for event in events:
            etype = event.get("event", "")
            data = event.get("data", {}) or {}

            if etype == "on_chat_model_stream":
                chunk = data.get("chunk")
                if chunk is None:
                    continue
                # Reasoning arrives ahead of visible text in Anthropic's
                # block ordering; emit it first so the UI keeps the same
                # order and the collapsible reasoning block sits above the
                # answer text.
                reasoning = _extract_chunk_reasoning(chunk)
                if reasoning:
                    yield chat_reasoning_delta(reasoning, trace_id=trace_id)
                text = _extract_chunk_text(chunk)
                if text:
                    yield chat_delta(text, trace_id=trace_id)

            elif etype == "on_tool_start":
                tool_call_id = event.get("run_id") or ""
                name = event.get("name") or "tool"
                args_preview = _safe_preview(data.get("input"))
                yield chat_tool_start(
                    tool_call_id=tool_call_id, name=name,
                    args_preview=args_preview, trace_id=trace_id,
                )

            elif etype == "on_tool_end":
                tool_call_id = event.get("run_id") or ""
                output = data.get("output")
                is_error = bool(getattr(output, "status", None) == "error")
                if hasattr(output, "content"):
                    meta = _safe_preview(output.content, _META_LIMIT)
                else:
                    meta = _safe_preview(output, _META_LIMIT)
                yield chat_tool_result(
                    tool_call_id=tool_call_id, is_error=is_error,
                    meta=meta, trace_id=trace_id,
                )
            # Everything else (on_chain_*, on_chat_model_start/end,
            # on_prompt_*, etc.) is intentionally ignored — they're either
            # redundant with chat:delta / chat:tool:* or not user-visible.
    except Exception as e:
        logger.exception("langgraph_to_sse failed mid-stream")
        yield chat_error(f"{type(e).__name__}: {e}", trace_id=trace_id)
    finally:
        yield chat_done(trace_id=trace_id)
