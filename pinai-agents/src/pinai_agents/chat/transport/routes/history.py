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

from fastapi import APIRouter, Header, HTTPException, Query
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from pydantic import BaseModel

from ...harness.checkpoint import get_checkpointer
from ...harness.reasoning import extract_reasoning_text
from ._session_auth import assert_session_key_principal, principal_from_header

logger = logging.getLogger(__name__)
router = APIRouter()

_CARD_THREAD_PREFIX = "card-thread-"


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


# Read-only agents cached per kind (main / card). aget_state() only reads
# checkpoint state — it never invokes the model or touches the backend /
# sandbox — so one throwaway agent per kind (dummy virtual_key + local backend)
# can read state for ANY thread_id of that kind. The topology must match the
# live send-path factory (make_*_agent) so the assembled state schema lines up;
# only model/backend differ and neither is exercised by a read. Caching avoids
# rebuilding the full middleware graph on every (frequently-polled) history /
# exists call. Safe to cache process-wide: the checkpointer is a lifespan
# singleton, and graph construction is synchronous (no await → no interleave).
_READONLY_AGENTS: dict[str, Any] = {}


def _readonly_agent(*, is_card: bool) -> Any:
    # Deferred imports: pulling the agent factories (and through them the full
    # native-tool stack — e.g. tavily's module-level client) at module load
    # would saddle this route module with the entire agent/tool dependency
    # chain plus its import-time side effects, and break lightweight test
    # imports of the pure helpers below (_build_history). We only need them
    # when actually reading state, where the full runtime env is present.
    from ..agents.card_execution import make_card_execution_agent
    from ..agents.main_chat import make_main_chat_agent
    from ..tools.code_mode.local_sandbox import (
        create_local_sandbox_backend,
        local_chat_root_dir,
    )

    kind = "card" if is_card else "main"
    agent = _READONLY_AGENTS.get(kind)
    if agent is None:
        backend = create_local_sandbox_backend(
            run_jwt="state-read",
            root_dir=local_chat_root_dir(f"__readonly_{kind}__"),
        )
        agent = (
            make_card_execution_agent(virtual_key="state-read", backend=backend)
            if is_card
            else make_main_chat_agent(virtual_key="state-read", backend=backend)
        )
        _READONLY_AGENTS[kind] = agent
    return agent


async def _get_thread_messages(session_key: str) -> list[Any]:
    """Read the messages list from a thread's LangGraph state.

    Under deepagents / langgraph 1.x `messages` is a reducer-managed channel
    whose current value is only assembled by the compiled graph's aget_state();
    raw checkpointer.aget_tuple() exposes control-flow channels
    (__pregel_tasks, branch:to:*) in channel_values but NOT the user-visible
    messages list. So we read through a cached per-kind agent (_readonly_agent).
    Returns [] when the thread has no persisted state yet.
    """
    try:
        get_checkpointer()
    except RuntimeError as e:
        # Checkpointer not initialized — DATABASE_URL missing or lifespan
        # didn't run. Surface as 503 so the proxy knows to retry / report.
        raise HTTPException(status_code=503, detail=str(e)) from e

    is_card = session_key.startswith(_CARD_THREAD_PREFIX)
    try:
        agent = _readonly_agent(is_card=is_card)
        snapshot = await agent.aget_state(
            {"configurable": {"thread_id": session_key}},
        )
    except Exception as e:
        logger.exception("state read failed session_key=%s", session_key)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}") from e
    if snapshot is None:
        return []
    return (snapshot.values or {}).get("messages", []) or []


@router.get("/agent/chat/exists", response_model=ExistsResponse)
async def chat_exists(
    session_key: str = Query(..., min_length=1, max_length=200),
    authorization: str | None = Header(default=None),
) -> ExistsResponse:
    """Does `session_key` already have any persisted turn?

    Used by `/api/proxy/chat-stream/init` (frontend `useProactiveChatRuntime`
    bootstrap path). "Has persisted turn" = at least one message in the
    assembled state, not just "checkpoint row exists" — early-graph
    checkpoints (control-flow only) can be written before the first
    user-visible message lands.
    """
    principal = principal_from_header(authorization)
    assert_session_key_principal(session_key, principal)
    msgs = await _get_thread_messages(session_key)
    return ExistsResponse(ok=True, existing=len(msgs) > 0)


@router.get("/agent/chat/history", response_model=HistoryResponse)
async def chat_history(
    session_key: str = Query(..., min_length=1, max_length=200),
    authorization: str | None = Header(default=None),
) -> HistoryResponse:
    """Return all turns for `session_key` in frontend HistoryMessage shape.

    Empty thread (never sent a message) → ok=true, messages=[].
    """
    principal = principal_from_header(authorization)
    assert_session_key_principal(session_key, principal)
    raw_messages = await _get_thread_messages(session_key)
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
            if isinstance(b, dict) and b.get("type") in {"text", "output_text"}:
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
        reasoning = extract_reasoning_text(content)
        if reasoning:
            return reasoning
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
                out.append(
                    {
                        "id": msg_id,
                        "role": "user",
                        "parts": [{"type": "text", "text": text}],
                    }
                )
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
                current_assistant["parts"].append({"type": "reasoning", "text": reasoning})
            text = _extract_text(msg)
            if text:
                current_assistant["parts"].append({"type": "text", "text": text})
            for tc in getattr(msg, "tool_calls", None) or []:
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
            tool_part = tool_index.get(tc_id)
            if tool_part is None:
                # Orphaned tool result — likely from an earlier (closed)
                # assistant turn; ignore silently to avoid status=running ghosts.
                continue
            status_str = (getattr(msg, "status", None) or "success").lower()
            tool_part["status"] = "error" if status_str == "error" else "ok"
            content_text = _extract_text(msg)
            if content_text:
                tool_part["meta"] = _truncate_meta(content_text)
            continue
        # SystemMessage / FunctionMessage / unknown types — skip.

    close_assistant()
    return out
