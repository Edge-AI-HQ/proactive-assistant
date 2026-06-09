"""GET /agent/chat/history?session_key=... — main + card chat history.

Reads LangGraph thread state from the Postgres checkpointer and reshapes it
into the wire format the proactive-ai-frontend already expects (see
`proactive-ai-frontend/src/components/chat/useProactiveChatRuntime.ts`
HistoryMessage / HistoryPart).

Why: web cannot read LangGraph's checkpoint tables itself, so its
`call_chat_history` proxy (conversation /history backfill for threads that
predate pai_chat_messages, and the proactive page's cursor reads) forwards
here.

Message merge logic mirrors `pinai-openclaw/.../chat-history-merge.ts`:
each chain of (AIMessage … ToolMessage … AIMessage …) between two
HumanMessages collapses into a single assistant turn whose parts[]
preserve order — text blocks and tool-call blocks interleaved, with each
tool-call's status/meta filled in by matching ToolMessage.tool_call_id.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from pydantic import BaseModel

from ...harness.checkpoint import get_checkpointer
from ...harness.reasoning import extract_reasoning_text
from ...harness.session import read_state_messages
from ._session_auth import assert_session_key_principal, principal_from_header

logger = logging.getLogger(__name__)
router = APIRouter()

_CARD_THREAD_PREFIX = "card-thread-"
_PROACTIVE_PREFIX = "proactive-"


_TOOL_META_MAX = 300
_ARGS_PREVIEW_MAX = 240
# Cap on the full structured `args` field. Mirrors streaming.py's
# `_ARGS_FULL_LIMIT` so SSE live events and history replay deliver the
# same tool-call shape to the frontend — UI components that render
# specialized panels (TodoPanel for write_todos, ProposeActionCard for
# propose_action) get the same dict in both code paths.
_ARGS_FULL_MAX = 8192

# Cursor-pagination cap, applied post-filter. `_MAX_LIMIT` bounds a single
# page when `limit` IS supplied (malicious / buggy client). Omitting `limit`
# means "no pagination — return the whole filtered history": the main-chat
# backfill (`call_chat_history`) relies on that to seed pai_chat_messages with
# the FULL thread, while the proactive page passes an explicit `limit` to page.
_MAX_LIMIT = 500

# `_build_history` falls back to `f"msg_{i}"` when a LangChain message
# has no native UUID (rare; happens on very old checkpoints). Indices are
# unstable across reloads (they shift when the thread grows), so these
# ids must NOT be used as a `before` cursor — `_oldest_cursor` skips them.
_FALLBACK_ID = re.compile(r"^msg_\d+$")


class HistoryResponse(BaseModel):
    ok: bool
    messages: list[dict[str, Any]]
    # Cursor-pagination fields. Names are camelCase to stay consistent with
    # the per-entry shape (`toolCallId`, `argsPreview`, …) that the FE
    # already consumes. Defaults keep the response shape backward-compatible
    # for any pre-cursor consumer (they can ignore the new fields).
    hasMore: bool = False
    oldestCursor: str | None = None


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


def _readonly_agent(*, kind: str) -> Any:
    # Deferred imports: pulling the agent factories (and through them the full
    # native-tool stack — e.g. tavily's module-level client) at module load
    # would saddle this route module with the entire agent/tool dependency
    # chain plus its import-time side effects, and break lightweight test
    # imports of the pure helpers below (_build_history). We only need them
    # when actually reading state, where the full runtime env is present.
    from ...agents.card_execution import make_card_execution_agent
    from ...agents.main_chat import make_main_chat_agent
    from ...agents.proactive import make_proactive_agent
    from ...tools.code_mode.local_sandbox import (
        create_local_sandbox_backend,
        local_chat_root_dir,
    )

    agent = _READONLY_AGENTS.get(kind)
    if agent is None:
        backend = create_local_sandbox_backend(
            run_jwt="state-read",
            root_dir=local_chat_root_dir(f"__readonly_{kind}__"),
        )
        if kind == "card":
            agent = make_card_execution_agent(virtual_key="state-read", backend=backend)
        elif kind == "proactive":
            # proactive state reads MUST go through the proactive agent so they
            # use the isolated background checkpoint pool (build_agent
            # background=True) — reading a huge proactive thread through the main
            # agent would occupy the interactive pool and starve live chat.
            agent = make_proactive_agent(virtual_key="state-read", backend=backend)
        else:
            agent = make_main_chat_agent(virtual_key="state-read", backend=backend)
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

    if session_key.startswith(_CARD_THREAD_PREFIX):
        kind = "card"
    elif session_key.startswith(_PROACTIVE_PREFIX):
        kind = "proactive"
    else:
        kind = "main"
    try:
        agent = _readonly_agent(kind=kind)
        return await read_state_messages(agent, session_key)
    except Exception as e:
        logger.exception("state read failed session_key=%s", session_key)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}") from e


def _is_debug_only(entry: dict[str, Any]) -> bool:
    """An entry the user only sees in Debug mode.

    Mirrors `ProactiveAgentView.tsx`'s `debugHidden` rule so a response
    with `include_debug=0` contains exactly what the UI would render with
    the Debug toggle off — backend filters at the source, FE doesn't have
    to second-guess.

      - `role=heartbeat` → always debug-only (the ~30s tick input).
      - `role=assistant, trigger=tick` → debug-only UNLESS the turn made
        at least one `notify_user` tool call (the only thing in a tick
        turn that the user is meant to see).
      - everything else (user messages, user-triggered assistant) → kept.
    """
    if entry.get("role") == "heartbeat":
        return True
    if entry.get("role") == "assistant" and entry.get("trigger") == "tick":
        for p in entry.get("parts") or []:
            if (
                isinstance(p, dict)
                and p.get("type") == "tool-call"
                and p.get("toolName") == "notify_user"
            ):
                return False
        return True
    return False


def _oldest_cursor(page: list[dict[str, Any]]) -> str | None:
    """First stable id in `page`, usable as the next `before` cursor.

    Skips `_FALLBACK_ID` matches because those reflect a positional index
    that shifts when the thread grows — passing one back would point at a
    different message after the next reload.
    """
    for entry in page:
        eid = entry.get("id") or ""
        if eid and not _FALLBACK_ID.match(eid):
            return eid
    return None


@router.get("/agent/chat/history", response_model=HistoryResponse)
async def chat_history(
    session_key: str = Query(..., min_length=1, max_length=200),
    authorization: str | None = Header(default=None),
    include_debug: bool = Query(
        False,
        description=(
            "When false (default), drop entries the UI would hide with"
            " Debug off (heartbeats + tick-triggered turns w/o notify_user)."
            " Pass true to get the full debug-visible history."
        ),
    ),
    before: str | None = Query(
        None,
        max_length=200,
        description=(
            "Cursor: return up to `limit` entries strictly OLDER than the"
            " entry with this id. Use the previous response's"
            " `oldestCursor`. Omit for the newest page."
        ),
    ),
    limit: int | None = Query(
        None,
        ge=1,
        le=_MAX_LIMIT,
        description=(
            "Max entries to return (newest page). Omit for the ENTIRE"
            " filtered history in one page — main chat's one-shot backfill"
            " relies on this; the proactive page sends an explicit limit to"
            " paginate."
        ),
    ),
) -> HistoryResponse:
    """Return one page of turns for `session_key` in frontend HistoryMessage shape.

    Pagination is cursor-based + time-ascending: the returned `messages`
    list ends with the newest entry the client requested, and
    `oldestCursor` is the id to pass back as `before` for the next older
    page. `hasMore` says whether more older entries exist beyond the page.

    Implementation note: LangGraph checkpointer always reads the full
    thread state, so this endpoint serializes/sends a slice but doesn't
    save DB IO. Real benefit is bounding JSON / network / FE render cost.

    Omitting `limit` returns the ENTIRE filtered history in one page
    (hasMore=false): the main-chat backfill (`call_chat_history`) depends on
    this to seed pai_chat_messages with the full thread. The proactive page
    always sends an explicit `limit` to paginate.

    Empty thread → ok=true, messages=[], hasMore=false, oldestCursor=null.
    Stale `before` (id not in the filtered list) → 400.
    """
    principal = principal_from_header(authorization)
    assert_session_key_principal(session_key, principal)
    raw_messages = await _get_thread_messages(session_key)
    all_entries = _build_history(raw_messages)
    filtered = all_entries if include_debug else [e for e in all_entries if not _is_debug_only(e)]

    # Locate the cursor inside the filtered list (cursor was issued from a
    # previous page that ran under the same filter, so it has to exist
    # there). If it doesn't, the client is paging against a stale view —
    # surface as 400 so the FE knows to refetch the first page.
    if before is not None:
        try:
            cursor_idx = next(i for i, e in enumerate(filtered) if e.get("id") == before)
        except StopIteration as e:
            raise HTTPException(
                status_code=400,
                detail=f"stale cursor: {before}",
            ) from e
        end = cursor_idx
    else:
        end = len(filtered)

    # `limit is None` → no pagination: take the whole filtered range so the
    # main-chat backfill seeds pai_chat_messages with the full thread.
    start = max(0, end - limit) if limit is not None else 0
    page = filtered[start:end]
    has_more = start > 0
    oldest = _oldest_cursor(page)
    # If we couldn't extract a stable cursor from the page (every entry
    # used the `msg_{i}` fallback id), there's no way for the client to
    # ask for an older page even though one exists — collapse `hasMore`
    # so the UI doesn't dangle a useless "load older" affordance.
    if has_more and oldest is None:
        has_more = False
    return HistoryResponse(
        ok=True,
        messages=page,
        hasMore=has_more,
        oldestCursor=oldest,
    )


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
    # How the turn currently being built was triggered. A heartbeat input
    # (HumanMessage with additional_kwargs.proactive_kind == "tick") flips this
    # to "tick"; the assistant turn that follows inherits it so the frontend
    # can classify the whole turn as debug-only.
    current_trigger = "user"

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
            kind = (getattr(msg, "additional_kwargs", None) or {}).get("proactive_kind")
            current_trigger = "tick" if kind == "tick" else "user"
            text = _extract_text(msg)
            if text:
                out.append(
                    {
                        "id": msg_id,
                        # A heartbeat input renders as a heartbeat entry (debug-only)
                        # on the frontend, not a user bubble. Mirrors the live
                        # `proactive:tick` event so reload looks the same as live.
                        "role": "heartbeat" if current_trigger == "tick" else "user",
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
                    # Inherit the triggering input's kind so the UI can mark a
                    # heartbeat-triggered turn debug (hidden unless Debug is on),
                    # while a user-triggered turn always shows.
                    "trigger": current_trigger,
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
