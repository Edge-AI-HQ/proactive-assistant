"""LangGraph events → proactive-ai SSE protocol.

Emits the wire format that `proactive-ai-frontend/.../useProactiveChatRuntime.ts`
already consumes — APIs is a pure pass-through (Step 1.7), no event remapping
on the Node side. Format:

    data: {"type":"chat:thinking"}                             # stream open signal
    data: {"type":"chat:reasoning:delta","delta":"thought..."} # extended thinking
    data: {"type":"chat:delta","delta":"hello"}                # final text
    data: {"type":"chat:tool:start","toolCallId":"<id>","name":"write_todos","argsPreview":"..."}
    data: {"type":"chat:tool:result","toolCallId":"<id>","isError":false,"meta":"..."}
    data: {"type":"chat:done"}

`chat:reasoning:delta` carries Claude's extended-thinking content (Anthropic
thinking blocks streamed as `reasoning_content` deltas). The frontend
renders these inline as a separate "reasoning" content part (collapsible /
italic / muted), so the user can see the model's reasoning trace.

Each event lives on its own `data: <json>` line + blank line terminator.
SSE event-type field is left as default ("message") because the frontend
parses by `type` inside the JSON, not by SSE event-type header.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

logger = logging.getLogger(__name__)


def format_sse(payload: dict[str, Any]) -> bytes:
    """Encode one event for the wire. ensure_ascii=False keeps CJK content
    short (no \\uXXXX escapes); UTF-8 is what the frontend will decode."""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()


def chat_thinking() -> bytes:
    return format_sse({"type": "chat:thinking"})


def chat_delta(text: str) -> bytes:
    return format_sse({"type": "chat:delta", "delta": text})


def chat_reasoning_delta(text: str) -> bytes:
    """Extended thinking / reasoning content (Claude / o1-style)."""
    return format_sse({"type": "chat:reasoning:delta", "delta": text})


def chat_tool_start(*, tool_call_id: str, name: str, args_preview: str) -> bytes:
    return format_sse({
        "type": "chat:tool:start",
        "toolCallId": tool_call_id,
        "name": name,
        "argsPreview": args_preview[:240],
    })


def chat_tool_result(*, tool_call_id: str, is_error: bool, meta: str) -> bytes:
    return format_sse({
        "type": "chat:tool:result",
        "toolCallId": tool_call_id,
        "isError": is_error,
        "meta": meta[:300],
    })


def chat_error(message: str) -> bytes:
    return format_sse({"type": "chat:error", "error": message})


def chat_done() -> bytes:
    return format_sse({"type": "chat:done"})


def _extract_chunk_text(chunk: Any) -> str:
    """Pull user-visible text out of an AIMessageChunk.

    Anthropic streams structured content blocks; tool_call-only chunks have
    no text part and return empty string here (which is a no-op delta).
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


async def langgraph_to_sse(events: AsyncIterator[dict[str, Any]]) -> AsyncIterator[bytes]:
    """Translate `agent.astream_events(version='v2')` to chat:* SSE bytes.

    LangGraph fires many event types; we only forward the ones the frontend
    chat runtime knows. Everything else is dropped to keep the wire clean.
    """
    yield chat_thinking()
    try:
        async for event in events:
            etype = event.get("event", "")
            data = event.get("data", {}) or {}

            if etype == "on_chat_model_stream":
                chunk = data.get("chunk")
                if chunk is None:
                    continue
                # Extended thinking content arrives in additional_kwargs
                # (ReasoningChatOpenAI populates this from LiteLLM's
                # delta.reasoning_content). Emit BEFORE text so UI sees
                # reasoning render first.
                ak = getattr(chunk, "additional_kwargs", None) or {}
                reasoning = ak.get("reasoning_content")
                if isinstance(reasoning, str) and reasoning:
                    yield chat_reasoning_delta(reasoning)
                text = _extract_chunk_text(chunk)
                if text:
                    yield chat_delta(text)

            elif etype == "on_tool_start":
                # event["name"] is the tool name; event["run_id"] is unique
                # per tool call (LangGraph generates a UUID per invocation).
                tool_call_id = event.get("run_id") or ""
                name = event.get("name") or "tool"
                args_preview = _safe_preview(data.get("input"))
                yield chat_tool_start(
                    tool_call_id=tool_call_id,
                    name=name,
                    args_preview=args_preview,
                )

            elif etype == "on_tool_end":
                tool_call_id = event.get("run_id") or ""
                output = data.get("output")
                # ToolMessage has .status='error' when tool raised; bare output
                # treated as success.
                is_error = bool(getattr(output, "status", None) == "error")
                # Output may be a ToolMessage with .content, or raw string/dict
                if hasattr(output, "content"):
                    meta = _safe_preview(getattr(output, "content"), 300)
                else:
                    meta = _safe_preview(output, 300)
                yield chat_tool_result(
                    tool_call_id=tool_call_id,
                    is_error=is_error,
                    meta=meta,
                )
            # Everything else (on_chain_*, on_chat_model_start/end,
            # on_prompt_*, etc.) is intentionally ignored — they're either
            # redundant with chat:delta / chat:tool:* or not user-visible.
    except Exception as e:
        logger.exception("langgraph_to_sse failed mid-stream")
        yield chat_error(f"{type(e).__name__}: {e}")
    finally:
        yield chat_done()
