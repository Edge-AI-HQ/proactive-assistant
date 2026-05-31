"""LangGraph events → unified SSE envelope.

Envelope shape (defined in shared/sse_envelope.py):

    data: {"type":"chat:delta","ts":<ms>,"traceId":"<run_id>","data":{"delta":"hi"}}

Per-event-type `data` payloads:
  * chat:thinking          — empty
  * chat:delta             — {delta: str}
  * chat:reasoning:delta   — {delta: str}     (provider reasoning summary/text)
  * chat:tool:start        — {toolCallId, name, argsPreview, args?}
  * chat:tool:result       — {toolCallId, isError, meta}
  * chat:error             — {error: str}
  * chat:done              — empty

`args` on chat:tool:start is the raw structured input (when JSON-serializable
and under `_ARGS_FULL_LIMIT` bytes). It lets the frontend render specialized
UI for selected tools (e.g. `write_todos` → TodoPanel) instead of parsing the
truncated `argsPreview` string. Omitted for oversized payloads (e.g.
`python_exec` carrying large code) — the frontend falls back to `argsPreview`.

Note on reasoning: agents run with `enable_thinking=True` and
`ChatLiteLLMReasoning` (see runtime/llm.py) normalizes provider reasoning
(`reasoning_content` for Claude/LiteLLM, `reasoning.summary` for OpenAI-style
payloads) into v1 reasoning content blocks. We forward those blocks as
`chat:reasoning:delta` so the frontend can render them in a collapsible block;
the same field also rides along through the Postgres checkpointer, which is
what makes refresh-replay work.

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
from .runtime.reasoning import extract_reasoning_text

logger = logging.getLogger(__name__)

_ARGS_PREVIEW_LIMIT = 240
_META_LIMIT = 300
# Cap for the structured `args` field on chat:tool:start. Keeps the SSE wire
# small while still fitting realistic structured inputs (e.g. write_todos
# plans with ~20 entries ~ 2 KB). Tools with large inputs (python_exec code,
# bulk uploads) exceed this and degrade to argsPreview-only.
_ARGS_FULL_LIMIT = 8192


def chat_thinking(*, trace_id: str | None = None) -> bytes:
    return emit(EV_CHAT_THINKING, trace_id=trace_id)


def chat_delta(text: str, *, trace_id: str | None = None) -> bytes:
    return emit(EV_CHAT_DELTA, {"delta": text}, trace_id=trace_id)


def chat_reasoning_delta(text: str, *, trace_id: str | None = None) -> bytes:
    return emit(EV_CHAT_REASONING_DELTA, {"delta": text}, trace_id=trace_id)


def chat_tool_start(
    *, tool_call_id: str, name: str, args_preview: str,
    args: Any = None,
    trace_id: str | None = None,
) -> bytes:
    payload: dict[str, Any] = {
        "toolCallId": tool_call_id,
        "name": name,
        "argsPreview": args_preview[:_ARGS_PREVIEW_LIMIT],
    }
    if args is not None:
        payload["args"] = args
    return emit(EV_CHAT_TOOL_START, payload, trace_id=trace_id)


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
            if isinstance(b, dict) and b.get("type") in {"text", "output_text"}:
                t = b.get("text")
                if isinstance(t, str):
                    parts.append(t)
        return "".join(parts)
    return ""


def _extract_chunk_reasoning(
    chunk: Any,
    *,
    preserve_whitespace: bool = False,
) -> str:
    """Pull reasoning text out of an AIMessageChunk's v1 content blocks.

    With `output_version="v1"`, reasoning deltas appear as
    `{"type":"reasoning","reasoning":"…"}` blocks alongside text. Older
    chunks may still carry the field on `additional_kwargs.reasoning_content`
    (langchain-core compat path); we read both for safety.
    """
    content = getattr(chunk, "content", None)
    if isinstance(content, list):
        reasoning = extract_reasoning_text(
            content,
            preserve_whitespace=preserve_whitespace,
        )
        if reasoning:
            return reasoning
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


def _safe_args(value: Any, max_bytes: int = _ARGS_FULL_LIMIT) -> Any | None:
    """Return raw structured input when JSON-serializable and under the size
    cap; None otherwise.

    The frontend uses this for tools that render specialized UI (write_todos
    → TodoPanel, future structured renderers). The size cap keeps the SSE
    wire small — large inputs (e.g. python_exec carrying 50KB of code) drop
    to None and the existing `argsPreview` string still describes the call.
    """
    if value is None:
        return None
    try:
        encoded = json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return None
    if len(encoded.encode("utf-8")) > max_bytes:
        return None
    return value


def _is_subagent_model_event(event: dict[str, Any]) -> bool:
    """True when a model stream/end event comes from a `task`-spawned subagent
    rather than the orchestrator itself.

    Subagents run as nested graphs under the `task` tool, so their model
    events carry a checkpoint_ns containing a `tools:` segment (verified:
    orchestrator tokens → ns `model:…`, subagent tokens → ns `tools:…`). The
    orchestrator folds each subagent's *returned result* into its own visible
    reply, so forwarding the subagent's internal tokens as chat:delta would
    duplicate / interleave them into the user-facing answer. We drop them; the
    delegation stays visible through the `task` tool's own chat:tool:* events.
    """
    ns = (event.get("metadata") or {}).get("checkpoint_ns", "") or ""
    return "tools:" in ns


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
    streamed_text_run_ids: set[str] = set()
    streamed_reasoning_run_ids: set[str] = set()
    try:
        async for event in events:
            etype = event.get("event", "")
            data = event.get("data", {}) or {}

            if etype == "on_chat_model_stream":
                if _is_subagent_model_event(event):
                    continue
                run_id = event.get("run_id")
                chunk = data.get("chunk")
                if chunk is None:
                    continue
                # Reasoning should precede visible text when the provider
                # gives us both in one chunk, so the collapsible block stays
                # above the answer text.
                reasoning = _extract_chunk_reasoning(
                    chunk,
                    preserve_whitespace=True,
                )
                if reasoning:
                    if isinstance(run_id, str):
                        streamed_reasoning_run_ids.add(run_id)
                    yield chat_reasoning_delta(reasoning, trace_id=trace_id)
                text = _extract_chunk_text(chunk)
                if text:
                    if isinstance(run_id, str):
                        streamed_text_run_ids.add(run_id)
                    yield chat_delta(text, trace_id=trace_id)

            elif etype == "on_chat_model_end":
                if _is_subagent_model_event(event):
                    continue
                run_id = event.get("run_id")
                output = data.get("output")
                if output is None:
                    continue
                reasoning = _extract_chunk_reasoning(output)
                if (
                    reasoning
                    and not (
                        isinstance(run_id, str)
                        and run_id in streamed_reasoning_run_ids
                    )
                ):
                    yield chat_reasoning_delta(reasoning, trace_id=trace_id)
                text = _extract_chunk_text(output)
                if (
                    text
                    and not (
                        isinstance(run_id, str)
                        and run_id in streamed_text_run_ids
                    )
                ):
                    yield chat_delta(text, trace_id=trace_id)

            elif etype == "on_tool_start":
                tool_call_id = event.get("run_id") or ""
                name = event.get("name") or "tool"
                raw_input = data.get("input")
                args_preview = _safe_preview(raw_input)
                yield chat_tool_start(
                    tool_call_id=tool_call_id, name=name,
                    args_preview=args_preview,
                    args=_safe_args(raw_input),
                    trace_id=trace_id,
                )

            elif etype == "on_tool_end":
                tool_call_id = event.get("run_id") or ""
                output = data.get("output")
                is_error = bool(getattr(output, "status", None) == "error")
                output_content = getattr(output, "content", None)
                if output_content is not None:
                    meta = _safe_preview(output_content, _META_LIMIT)
                else:
                    meta = _safe_preview(output, _META_LIMIT)
                yield chat_tool_result(
                    tool_call_id=tool_call_id, is_error=is_error,
                    meta=meta, trace_id=trace_id,
                )
            # Everything else (on_chain_*, on_chat_model_start,
            # on_prompt_*, etc.) is intentionally ignored — they're either
            # redundant with chat:delta / chat:tool:* or not user-visible.
    except Exception as e:
        logger.exception("langgraph_to_sse failed mid-stream")
        yield chat_error(f"{type(e).__name__}: {e}", trace_id=trace_id)
    finally:
        yield chat_done(trace_id=trace_id)
