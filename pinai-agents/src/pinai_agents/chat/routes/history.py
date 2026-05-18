"""GET /agent/chat/history?session_key=... — main + card chat history.

Reads LangGraph thread state from the Postgres checkpointer and reshapes it
into the wire format the proactive-ai-frontend already expects (see
`proactive-ai-frontend/src/components/chat/useProactiveChatRuntime.ts`
HistoryMessage / HistoryPart).

Why: the frontend's `fetchHistory()` calls `/api/proxy/chat-stream/history`
when the user opens MainChat. Without this endpoint the request fell
through to OpenClaw's catch-all proxy, which has no record of LangGraph
threads, so MainChat appeared empty even though all turns are stored in
`langgraph.checkpoints` (Step 1.4 checkpointer).

Message merge logic mirrors `pinai-openclaw/.../chat-history-merge.ts`:
each chain of (AIMessage … ToolMessage … AIMessage …) between two
HumanMessages collapses into a single assistant turn whose parts[]
preserve order — text blocks and tool-call blocks interleaved, with each
tool-call's status/meta filled in by matching ToolMessage.tool_call_id.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from pydantic import BaseModel

from ..runtime.checkpoint import get_checkpointer

logger = logging.getLogger(__name__)
router = APIRouter()


_TOOL_META_MAX = 300
_ARGS_PREVIEW_MAX = 240
# Cap on the full structured `args` field. Mirrors streaming.py's
# `_ARGS_FULL_LIMIT` so SSE live events and history replay deliver the
# same tool-call shape to the frontend — UI components that render
# specialized panels (TodoPanel for write_todos, ProposeActionCard for
# propose_action) get the same dict in both code paths.
_ARGS_FULL_MAX = 8192


class HistoryResponse(BaseModel):
    ok: bool
    messages: list[dict[str, Any]]


class ExistsResponse(BaseModel):
    ok: bool
    existing: bool


async def _get_thread_snapshot(session_key: str):
    """Shared helper: fetch the thread checkpoint or surface a clean HTTP
    error. Returns the snapshot (which may be None for never-touched
    threads — caller distinguishes)."""
    try:
        checkpointer = get_checkpointer()
    except RuntimeError as e:
        # Checkpointer not initialized — DATABASE_URL missing or lifespan
        # didn't run. Surface as 503 so the proxy knows to retry / report.
        raise HTTPException(status_code=503, detail=str(e)) from e
    try:
        return await checkpointer.aget_tuple(
            {"configurable": {"thread_id": session_key}}
        )
    except Exception as e:
        logger.exception("checkpoint fetch failed session_key=%s", session_key)
        raise HTTPException(
            status_code=500, detail=f"{type(e).__name__}: {e}"
        ) from e


@router.get("/agent/chat/exists", response_model=ExistsResponse)
async def chat_exists(
    session_key: str = Query(..., min_length=1, max_length=200),
) -> ExistsResponse:
    """Does `session_key` already have any persisted turn?

    Used by `/api/proxy/chat-stream/init` (frontend `useProactiveChatRuntime`
    bootstrap path). Replaces APIs's direct `langgraph.checkpoints` SQL
    query so APIs never reaches into the chat process's data store.
    """
    snapshot = await _get_thread_snapshot(session_key)
    return ExistsResponse(ok=True, existing=snapshot is not None)


@router.get("/agent/chat/history", response_model=HistoryResponse)
async def chat_history(
    session_key: str = Query(..., min_length=1, max_length=200),
) -> HistoryResponse:
    """Return all turns for `session_key` in frontend HistoryMessage shape.

    Empty thread (never sent a message) → ok=true, messages=[].
    """
    snapshot = await _get_thread_snapshot(session_key)
    if snapshot is None:
        return HistoryResponse(ok=True, messages=[])
    raw_messages = (
        (snapshot.checkpoint.get("channel_values") or {}).get("messages") or []
    )
    return HistoryResponse(ok=True, messages=_build_history(raw_messages))


def _extract_text(msg: Any) -> str:
    """Pull plain text out of a LangChain message. Handles both string content
    (OpenAI / LiteLLM-default) and list-of-blocks content (v1 protocol)."""
    content = getattr(msg, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        pieces: list[str] = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                t = b.get("text")
                if isinstance(t, str):
                    pieces.append(t)
        return "\n".join(pieces)
    return ""


def _extract_reasoning(msg: Any) -> str:
    """Pull extended-thinking text out of a v1-content AIMessage.

    Reads `{"type":"reasoning","reasoning":"…"}` blocks first (the
    `output_version="v1"` shape produced by ChatLiteLLMReasoning); falls
    back to the legacy `additional_kwargs.reasoning_content` field for
    older checkpoints written before the v1 migration.
    """
    content = getattr(msg, "content", None)
    if isinstance(content, list):
        pieces: list[str] = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "reasoning":
                r = b.get("reasoning")
                if isinstance(r, str):
                    pieces.append(r)
        if pieces:
            return "\n".join(pieces)
    legacy = (getattr(msg, "additional_kwargs", None) or {}).get("reasoning_content")
    return legacy if isinstance(legacy, str) else ""


def _safe_args_preview(args: Any) -> str:
    """Best-effort short JSON preview for tool args. Never raises."""
    try:
        text = json.dumps(args, ensure_ascii=False) if args else ""
    except Exception:
        text = str(args)
    if len(text) > _ARGS_PREVIEW_MAX:
        return text[: _ARGS_PREVIEW_MAX - 1] + "…"
    return text


def _safe_args_full(args: Any) -> Any | None:
    """Return the raw structured args when JSON-serializable and under
    the size cap; None otherwise.

    Mirrors streaming.py's `_safe_args` so live SSE chat:tool:start
    events and history replay both carry the same payload shape. The
    frontend reads this for tools that have specialized renderers
    (TodoPanel for write_todos, ProposeActionCard for propose_action).
    Large inputs (e.g. python_exec carrying tens of KB of code) exceed
    the cap and drop to argsPreview-only — same degradation as SSE.
    """
    if args is None:
        return None
    try:
        encoded = json.dumps(args, ensure_ascii=False)
    except (TypeError, ValueError):
        return None
    if len(encoded.encode("utf-8")) > _ARGS_FULL_MAX:
        return None
    return args


def _truncate_meta(s: str) -> str:
    if len(s) > _TOOL_META_MAX:
        return s[: _TOOL_META_MAX - 1] + "…"
    return s


def _build_history(messages: list[Any]) -> list[dict[str, Any]]:
    """Walk LangGraph messages → frontend HistoryMessage list.

    Algorithm:
      - HumanMessage  → emit one user turn (text part), close any open
                        assistant turn first.
      - AIMessage     → open or extend the current assistant turn.
                        Emit reasoning part if additional_kwargs has
                        reasoning_content; append text part if content has
                        text; append a tool-call part (status=running) per
                        tool_call.
      - ToolMessage   → match to the running tool-call part by tool_call_id;
                        flip status to ok/error and attach meta from content.
      - SystemMessage / unknown types → ignored.

    Out-of-order or orphaned ToolMessages (no matching tool_call) are
    silently skipped — frontend would show "running forever" otherwise.
    """
    out: list[dict[str, Any]] = []
    current_assistant: dict[str, Any] | None = None
    tool_index: dict[str, dict[str, Any]] = {}

    def close_assistant() -> None:
        nonlocal current_assistant
        if current_assistant is not None and current_assistant["parts"]:
            out.append(current_assistant)
        current_assistant = None
        tool_index.clear()

    for i, msg in enumerate(messages):
        msg_id = getattr(msg, "id", None) or f"msg_{i}"

        if isinstance(msg, HumanMessage):
            close_assistant()
            text = _extract_text(msg)
            if text:
                out.append({
                    "id": msg_id,
                    "role": "user",
                    "parts": [{"type": "text", "text": text}],
                })
            continue

        if isinstance(msg, AIMessage):
            if current_assistant is None:
                current_assistant = {
                    "id": msg_id,
                    "role": "assistant",
                    "parts": [],
                }
            # Extended thinking is a v1 reasoning block in this AIMessage's
            # content list (see ChatLiteLLMReasoning in chat/runtime/llm.py).
            # Emit it before the text part so the UI keeps producer order.
            reasoning = _extract_reasoning(msg)
            if reasoning:
                current_assistant["parts"].append(
                    {"type": "reasoning", "text": reasoning}
                )
            text = _extract_text(msg)
            if text:
                current_assistant["parts"].append({"type": "text", "text": text})
            for tc in (getattr(msg, "tool_calls", None) or []):
                tc_id = tc.get("id") if isinstance(tc, dict) else None
                if not tc_id:
                    continue
                tc_name = (tc.get("name") if isinstance(tc, dict) else None) or "tool"
                tc_args = tc.get("args") if isinstance(tc, dict) else None
                part: dict[str, Any] = {
                    "type": "tool-call",
                    "toolCallId": tc_id,
                    "toolName": tc_name,
                    "status": "running",
                    "argsPreview": _safe_args_preview(tc_args),
                }
                # Full structured args alongside the preview — keeps
                # the FE in sync with how SSE streaming.py emits the
                # same field, so specialized tool renderers
                # (ProposeActionCard, TodoPanel) work identically on
                # history replay and live stream.
                full = _safe_args_full(tc_args)
                if full is not None:
                    part["args"] = full
                current_assistant["parts"].append(part)
                tool_index[tc_id] = part
            continue

        if isinstance(msg, ToolMessage):
            tc_id = getattr(msg, "tool_call_id", None)
            if not tc_id:
                continue
            part = tool_index.get(tc_id)
            if part is None:
                # Orphaned tool result — likely from an earlier (closed)
                # assistant turn; ignore silently to avoid status=running ghosts.
                continue
            status_str = (getattr(msg, "status", None) or "success").lower()
            part["status"] = "error" if status_str == "error" else "ok"
            content_text = _extract_text(msg)
            if content_text:
                part["meta"] = _truncate_meta(content_text)
            continue
        # SystemMessage / FunctionMessage / unknown types — skip.

    close_assistant()
    return out
