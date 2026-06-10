"""LangGraph events → unified SSE envelope.

Envelope shape (defined in shared/sse_envelope.py):

    data: {"type":"chat:delta","ts":<ms>,"traceId":"<run_id>","data":{"delta":"hi"}}

Per-event-type `data` payloads:
  * chat:thinking          — empty
  * chat:delta             — {delta: str}
  * chat:reasoning:delta   — {delta: str}     (provider reasoning summary/text)
  * chat:tool:start        — {toolCallId, name, argsPreview, args?,
                              parentTaskId?, agentName?}
  * chat:tool:result       — {toolCallId, isError, meta, links?}
  * chat:group:title       — {anchorToolCallId, title}  (async annotation)
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

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import urlparse

from ...shared.sse_envelope import (
    EV_CHAT_DELTA,
    EV_CHAT_DONE,
    EV_CHAT_ERROR,
    EV_CHAT_GROUP_TITLE,
    EV_CHAT_REASONING_DELTA,
    EV_CHAT_REQUIRES_ACTION,
    EV_CHAT_THINKING,
    EV_CHAT_TOOL_RESULT,
    EV_CHAT_TOOL_START,
    emit,
)
from ..harness.group_title import GroupTitleFn
from ..harness.reasoning import extract_reasoning_text
from ..harness.session import command_tool_message

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
    *,
    tool_call_id: str,
    name: str,
    args_preview: str,
    args: Any = None,
    parent_task_id: str | None = None,
    agent_name: str | None = None,
    trace_id: str | None = None,
) -> bytes:
    """`parentTaskId`/`agentName` attribute a subagent's internal tool call to
    the `task` call that spawned it (frontend nests it under that TaskCard).
    Both are best-effort: omitted frames render in the flat stream as before.
    """
    payload: dict[str, Any] = {
        "toolCallId": tool_call_id,
        "name": name,
        "argsPreview": args_preview[:_ARGS_PREVIEW_LIMIT],
    }
    if args is not None:
        payload["args"] = args
    if parent_task_id is not None:
        payload["parentTaskId"] = parent_task_id
        if agent_name:
            payload["agentName"] = agent_name
    return emit(EV_CHAT_TOOL_START, payload, trace_id=trace_id)


def chat_tool_result(
    *,
    tool_call_id: str,
    is_error: bool,
    meta: str,
    links: list[dict[str, str]] | None = None,
    trace_id: str | None = None,
) -> bytes:
    """`links` carries structured [{title, url}] results for web-search-ish
    tools so the frontend can render a clickable source list instead of the
    truncated meta string. Best-effort: omitted when extraction fails."""
    payload: dict[str, Any] = {
        "toolCallId": tool_call_id,
        "isError": is_error,
        "meta": meta[:_META_LIMIT],
    }
    if links:
        payload["links"] = links
    return emit(EV_CHAT_TOOL_RESULT, payload, trace_id=trace_id)


def chat_requires_action(
    *,
    interrupt_id: str,
    tool_name: str,
    args: Any,
    args_preview: str,
    allowed_decisions: list[str],
    trace_id: str | None = None,
) -> bytes:
    """HITL pause frame: one interrupt_on tool call awaiting a human decision.
    `interruptId` is the resume anchor; the web worker stores it on the run's
    pending_action and a later decision resumes via Command(resume=)."""
    return emit(
        EV_CHAT_REQUIRES_ACTION,
        {
            "interruptId": interrupt_id,
            "toolName": tool_name,
            "args": args,
            "argsPreview": args_preview,
            "allowedDecisions": allowed_decisions,
        },
        trace_id=trace_id,
    )


def chat_group_title(
    *,
    anchor_tool_call_id: str,
    title: str,
    trace_id: str | None = None,
) -> bytes:
    """Async annotation for a closed work group; the frontend (and the
    recorder) backfill `groupTitle` onto the anchor tool-call part rather
    than inserting a new part — inserting would split a streaming text part."""
    return emit(
        EV_CHAT_GROUP_TITLE,
        {"anchorToolCallId": anchor_tool_call_id, "title": title},
        trace_id=trace_id,
    )


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


def _tool_output_meta(output: Any) -> tuple[bool, str]:
    """(is_error, meta preview) for an on_tool_end output.

    Tools that return a langgraph `Command` (task, write_todos) would
    otherwise surface as a useless `Command(update={...})` repr on the wire —
    for `task` that buried the subagent's final answer. Read the embedded
    ToolMessage instead; everything else keeps the plain content preview.
    """
    embedded = command_tool_message(output)
    if embedded is not None:
        return embedded.status == "error", _safe_preview(embedded.content, _META_LIMIT)
    is_error = bool(getattr(output, "status", None) == "error")
    content = getattr(output, "content", None)
    if content is not None:
        return is_error, _safe_preview(content, _META_LIMIT)
    return is_error, _safe_preview(output, _META_LIMIT)


# Tools whose results carry a list of web sources worth rendering as
# clickable links. Their dict output is stringified to JSON by langchain's
# ToolMessage packing, so we parse it back here.
_LINK_TOOLS = frozenset({"tavily_search", "tavily_extract"})
_LINKS_LIMIT = 10


def _extract_result_links(name: str, output: Any) -> list[dict[str, str]] | None:
    """[{title, url}] from a web-search tool's result, None on any mismatch."""
    if name not in _LINK_TOOLS:
        return None
    content = getattr(output, "content", None)
    if not isinstance(content, str):
        return None
    try:
        parsed = json.loads(content)
    except ValueError:
        return None
    results = parsed.get("results") if isinstance(parsed, dict) else None
    if not isinstance(results, list):
        return None
    links: list[dict[str, str]] = []
    for item in results[:_LINKS_LIMIT]:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        if not isinstance(url, str) or not url:
            continue
        title = item.get("title")
        if not (isinstance(title, str) and title):
            # tavily_extract results carry no title — the domain reads far
            # better in a source row than the full URL.
            title = urlparse(url).netloc or url
        links.append({"title": title, "url": url})
    return links or None


def _event_ns_segments(event: dict[str, Any]) -> list[str]:
    """Pipe-separated segments of the event's full checkpoint_ns path
    (`langgraph_checkpoint_ns`, e.g. "tools:<task_id>|model:<id>")."""
    ns = (event.get("metadata") or {}).get("langgraph_checkpoint_ns", "") or ""
    return [seg for seg in ns.split("|") if seg]


def _is_nested_event(event: dict[str, Any]) -> bool:
    """True when the event comes from inside a `task` subagent's subgraph.

    Nested-graph events carry 2+ ns segments — subagent tools are
    `tools:<task_id>|tools:<call_id>`, subagent model calls are
    `tools:<task_id>|model:<id>`; the orchestrator's own events are
    single-segment (`tools:<id>` / `model:<id>`). Segment count is the one
    test that works for BOTH kinds — a `"tools:" in ns` substring check
    would misfire on the orchestrator's own tool events.

    Dropping a subagent's model tokens matters because the orchestrator
    folds each subagent's returned result into its own visible reply —
    forwarding the internal tokens would duplicate/interleave them; the
    delegation stays visible through the `task` tool's own chat:tool:*
    frames.
    """
    return len(_event_ns_segments(event)) >= 2


def _is_summarization_model_event(event: dict[str, Any]) -> bool:
    """True for a summarization middleware's internal LLM call.

    langchain stamps the call with `config={"metadata": {"lc_source":
    "summarization"}}` (langchain/agents/middleware/summarization.py). Under
    astream_events that ainvoke runs as an implicit stream in the SAME
    checkpoint_ns as the real model call, so namespace filtering can't catch
    it — without this filter the summary text streams out as chat:delta (the
    prod "## SESSION INTENT" leak). Covers the built-in deepagents 170k
    backstop in both the orchestrator and task subagents, and a future
    `compact_conversation` tool call (same tag).
    """
    return (event.get("metadata") or {}).get("lc_source") == "summarization"


def _extract_interrupts(chunk: Any) -> list[Any]:
    """Pull langgraph Interrupt objects out of an on_chain_stream chunk.
    HumanInTheLoopMiddleware's interrupt() surfaces as
    `chunk={"__interrupt__": (Interrupt(...), ...)}` — verified 2026-06-05
    as the only astream_events(v2) surface it appears on (plan §五)."""
    if isinstance(chunk, dict):
        intr = chunk.get("__interrupt__")
        if intr:
            return list(intr)
    return []


# Don't spend an LLM call titling a trivial group — the frontend's
# deterministic fallback label covers it.
_TITLE_MIN_TOOLS = 3
# Pending titles get this long after the last agent event; a turn's final
# group races chat:done (SSE closes right after), so a slow title is dropped
# and that group keeps its fallback label everywhere, history included.
_TITLE_FLUSH_TIMEOUT_S = 3.0
_GROUP_REASONING_CAP = 600


async def langgraph_to_sse(
    events: AsyncIterator[dict[str, Any]],
    *,
    trace_id: str | None = None,
    group_title_fn: GroupTitleFn | None = None,
) -> AsyncIterator[bytes]:
    """Translate `agent.astream_events(version='v2')` to chat:* SSE bytes.

    LangGraph fires many event types; we only forward the ones the frontend
    chat runtime knows. Everything else is dropped to keep the wire clean.

    When `group_title_fn` is provided, contiguous runs of reasoning + tool
    events between visible text segments ("work groups") get an async LLM
    title, emitted as chat:group:title anchored to the group's first
    tool-call id. Titles never block the stream: they're scheduled on group
    close, drained between events, and flushed (bounded) before chat:done.
    """
    yield chat_thinking(trace_id=trace_id)
    streamed_text_run_ids: set[str] = set()
    streamed_reasoning_run_ids: set[str] = set()
    # Subgraph root ns ("tools:<pregel_task_id>") → the toolCallId of the
    # `task` frame that opened it (the on_tool_start run_id — the SAME id the
    # frontend nests by; see the on_tool_start branch). Per-run state — a
    # HITL resume starts a fresh stream, so attribution silently degrades to
    # the flat form for subgraphs whose task start preceded the pause.
    task_by_ns: dict[str, str] = {}

    # ── work-group title state ──
    group_anchor: str | None = None
    group_items: list[str] = []
    group_reasoning = ""
    group_tool_count = 0
    group_has_task = False
    saw_interrupt = False
    pending_titles: list[asyncio.Task[tuple[str, str | None]]] = []

    async def _titled(anchor: str, items: list[str]) -> tuple[str, str | None]:
        assert group_title_fn is not None
        return anchor, await group_title_fn(items)

    def _close_group() -> None:
        """Schedule a title for the group that just ended (size-gated);
        reset group state either way. Pure-reasoning groups have no anchor
        part to backfill, so they keep the fallback label by design."""
        nonlocal group_anchor, group_items, group_reasoning
        nonlocal group_tool_count, group_has_task
        anchor = group_anchor
        if (
            group_title_fn is not None
            and anchor is not None
            and (group_tool_count >= _TITLE_MIN_TOOLS or group_has_task)
        ):
            items = list(group_items)
            if group_reasoning:
                items.insert(0, f"reasoning: {group_reasoning[:300]}")
            pending_titles.append(asyncio.create_task(_titled(anchor, items)))
        group_anchor = None
        group_items = []
        group_reasoning = ""
        group_tool_count = 0
        group_has_task = False

    def _drain_titles() -> list[bytes]:
        frames: list[bytes] = []
        for task in [t for t in pending_titles if t.done()]:
            pending_titles.remove(task)
            # An annotation must never take the stream down: the title fn
            # contract is "return None on failure", but skip a raising task
            # outright rather than letting result() re-raise into the relay.
            if task.cancelled() or task.exception() is not None:
                continue
            anchor, title = task.result()
            if title:
                frames.append(
                    chat_group_title(
                        anchor_tool_call_id=anchor,
                        title=title,
                        trace_id=trace_id,
                    )
                )
        return frames

    try:
        async for event in events:
            for frame in _drain_titles():
                yield frame
            etype = event.get("event", "")
            data = event.get("data", {}) or {}

            if etype == "on_chat_model_stream":
                if _is_summarization_model_event(event) or _is_nested_event(event):
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
                    if len(group_reasoning) < _GROUP_REASONING_CAP:
                        group_reasoning += reasoning
                    yield chat_reasoning_delta(reasoning, trace_id=trace_id)
                text = _extract_chunk_text(chunk)
                if text:
                    # Visible text ends the current work group (Claude.ai's
                    # segment rule: text is the narrative spine, the group
                    # collapses behind it).
                    _close_group()
                    if isinstance(run_id, str):
                        streamed_text_run_ids.add(run_id)
                    yield chat_delta(text, trace_id=trace_id)

            elif etype == "on_chat_model_end":
                if _is_summarization_model_event(event) or _is_nested_event(event):
                    continue
                run_id = event.get("run_id")
                output = data.get("output")
                if output is None:
                    continue
                reasoning = _extract_chunk_reasoning(output)
                if reasoning and not (
                    isinstance(run_id, str) and run_id in streamed_reasoning_run_ids
                ):
                    if len(group_reasoning) < _GROUP_REASONING_CAP:
                        group_reasoning += reasoning
                    yield chat_reasoning_delta(reasoning, trace_id=trace_id)
                text = _extract_chunk_text(output)
                if text and not (isinstance(run_id, str) and run_id in streamed_text_run_ids):
                    _close_group()
                    yield chat_delta(text, trace_id=trace_id)

            elif etype == "on_tool_start":
                name = event.get("name") or "tool"
                # A subagent's internal plan is not user-facing granularity —
                # unfiltered it overwrote the main TodoPanel on every parallel
                # task's write_todos (the "plan flicker"). Other nested tool
                # events still flow, attributed to their task below.
                if name == "write_todos" and _is_nested_event(event):
                    continue
                segs = _event_ns_segments(event)
                # A task's own start opens its subgraph: its (single-segment)
                # ns is the first segment of every nested event that follows,
                # and it precedes them all. Map it to THIS frame's toolCallId
                # — the exact id the frontend nests by. (The Send payload's
                # LLM call id is a DIFFERENT id namespace; keying on it broke
                # nesting end-to-end: parentTaskId never matched any frame.)
                if name == "task" and len(segs) == 1 and segs[0]:
                    started_id = event.get("run_id")
                    if started_id:
                        task_by_ns[segs[0]] = str(started_id)
                parent_task_id = task_by_ns.get(segs[0]) if len(segs) >= 2 else None
                agent_name: str | None = None
                if parent_task_id is not None:
                    raw_agent = (event.get("metadata") or {}).get("lc_agent_name")
                    agent_name = raw_agent if isinstance(raw_agent, str) else None
                tool_call_id = event.get("run_id") or ""
                raw_input = data.get("input")
                args_preview = _safe_preview(raw_input)
                # Group digest: only the orchestrator's own layer counts —
                # a task's nested calls are summarized by the task line.
                if parent_task_id is None and not _is_nested_event(event):
                    if group_anchor is None:
                        group_anchor = tool_call_id
                    if name == "task":
                        group_has_task = True
                        desc = ""
                        if isinstance(raw_input, dict):
                            desc = str(raw_input.get("description") or "")[:120]
                        group_items.append(f"task: {desc}")
                    else:
                        group_tool_count += 1
                        group_items.append(f"tool {name}: {args_preview[:80]}")
                yield chat_tool_start(
                    tool_call_id=tool_call_id,
                    name=name,
                    args_preview=args_preview,
                    args=_safe_args(raw_input),
                    parent_task_id=parent_task_id,
                    agent_name=agent_name,
                    trace_id=trace_id,
                )

            elif etype == "on_tool_end":
                tool_name = event.get("name") or ""
                if tool_name == "write_todos" and _is_nested_event(event):
                    continue
                tool_call_id = event.get("run_id") or ""
                output = data.get("output")
                is_error, meta = _tool_output_meta(output)
                if tool_name == "task" and not _is_nested_event(event):
                    group_items.append(f"task result: {meta[:160]}")
                yield chat_tool_result(
                    tool_call_id=tool_call_id,
                    is_error=is_error,
                    meta=meta,
                    links=None if is_error else _extract_result_links(tool_name, output),
                    trace_id=trace_id,
                )

            elif etype == "on_chain_stream":
                # HITL: a langgraph interrupt() (HumanInTheLoopMiddleware on an
                # interrupt_on tool) surfaces here as a chunk carrying
                # `__interrupt__`. Translate each into a requires_action frame
                # so web can pause the run + collect a decision.
                for intr in _extract_interrupts(data.get("chunk")):
                    # The turn pauses mid-group; the resume stream re-opens
                    # it, so don't close (and title) a half-finished group.
                    saw_interrupt = True
                    val = getattr(intr, "value", None) or {}
                    reqs = val.get("action_requests") or []
                    if len(reqs) > 1:
                        # CC3: one interrupt with several tool calls. We surface
                        # only the first; resume sends one decision but the
                        # middleware expects one per request. Rare (agents emit
                        # one side-effect call) — log it; multi-action approval
                        # is a later step.
                        logger.warning(
                            "multi-action interrupt (%d requests) — surfacing first only",
                            len(reqs),
                        )
                    configs = val.get("review_configs") or []
                    raw_allowed = (
                        configs[0].get("allowed_decisions")
                        if configs and isinstance(configs[0], dict)
                        else None
                    )
                    allowed = (
                        [str(d) for d in raw_allowed]
                        if isinstance(raw_allowed, list)
                        else ["approve", "reject"]
                    )
                    intr_id = str(getattr(intr, "id", "") or "")
                    # CORE-4 surfaces one action per interrupt (the common
                    # single side-effect-tool call); multi-action interrupts
                    # stay [:1] until the frontend renders an approval list.
                    for req in reqs[:1]:
                        if not isinstance(req, dict):
                            continue
                        yield chat_requires_action(
                            interrupt_id=intr_id,
                            tool_name=str(req.get("name") or "tool"),
                            args=req.get("args") or {},
                            args_preview=_safe_preview(req.get("args")),
                            allowed_decisions=allowed,
                            trace_id=trace_id,
                        )
            # Everything else (other on_chain_*, on_chat_model_start,
            # on_prompt_*, etc.) is intentionally ignored — they're either
            # redundant with chat:delta / chat:tool:* or not user-visible.
    except Exception as e:
        logger.exception("langgraph_to_sse failed mid-stream")
        yield chat_error(f"{type(e).__name__}: {e}", trace_id=trace_id)
    finally:
        # Flush pending group titles before chat:done — SSE closes right
        # after, so anything slower than the bounded wait keeps its
        # deterministic fallback label (history included, by construction).
        try:
            if not saw_interrupt:
                _close_group()
            if pending_titles:
                done_tasks, late = await asyncio.wait(
                    pending_titles, timeout=_TITLE_FLUSH_TIMEOUT_S
                )
                for task in late:
                    task.cancel()
                pending_titles.clear()
                for task in done_tasks:
                    if task.cancelled() or task.exception() is not None:
                        continue
                    anchor, title = task.result()
                    if title:
                        yield chat_group_title(
                            anchor_tool_call_id=anchor,
                            title=title,
                            trace_id=trace_id,
                        )
        except Exception:
            logger.exception("group title flush failed")
            for task in pending_titles:
                task.cancel()
        yield chat_done(trace_id=trace_id)
