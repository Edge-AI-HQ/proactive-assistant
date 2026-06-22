"""ChatTurnRecorder: SSE byte stream → assistant-turn parts.

SSE is generated via shared.sse_envelope.emit with the exact field names
chat/streaming.py sends (toolCallId / name / argsPreview / args / isError /
meta / delta) — so this also pins the web↔chat wire contract. We do NOT
import chat.transport.sse here (trust-boundary banned-api).
"""

from __future__ import annotations

from pinai_api.control.chat_turn_recorder import ChatTurnRecorder
from pinai_contracts.sse_envelope import (
    EV_CHAT_DELTA,
    EV_CHAT_DONE,
    EV_CHAT_REASONING_DELTA,
    EV_CHAT_THINKING,
    EV_CHAT_TOOL_RESULT,
    EV_CHAT_TOOL_START,
    emit,
)


def _delta(text: str) -> bytes:
    return emit(EV_CHAT_DELTA, {"delta": text})


def _reasoning(text: str) -> bytes:
    return emit(EV_CHAT_REASONING_DELTA, {"delta": text})


def _tool_start(tcid: str, name: str, preview: str, args=None) -> bytes:
    data = {"toolCallId": tcid, "name": name, "argsPreview": preview}
    if args is not None:
        data["args"] = args
    return emit(EV_CHAT_TOOL_START, data)


def _tool_result(tcid: str, is_error: bool, meta: str) -> bytes:
    return emit(EV_CHAT_TOOL_RESULT, {"toolCallId": tcid, "isError": is_error, "meta": meta})


def _event(etype: str, data: dict[str, object] | None = None) -> dict[str, object]:
    """A parsed SSE event dict — the shape proactive_loop feeds via
    consume_event() (it json.loads each SSE line to relay to the bus, then hands
    the decoded dict straight to the recorder, vs main chat's feed(raw bytes))."""
    return {"type": etype, "data": data or {}}


def test_text_deltas_coalesce_into_one_part() -> None:
    r = ChatTurnRecorder()
    r.feed(emit(EV_CHAT_THINKING))
    r.feed(_delta("Hello "))
    r.feed(_delta("world"))
    r.feed(emit(EV_CHAT_DONE))
    assert r.parts() == [{"type": "text", "text": "Hello world"}]


def test_reasoning_precedes_text() -> None:
    r = ChatTurnRecorder()
    r.feed(_reasoning("let me think"))
    r.feed(_delta("the answer"))
    assert r.parts() == [
        {"type": "reasoning", "text": "let me think"},
        {"type": "text", "text": "the answer"},
    ]


def test_tool_call_pairing_and_fields() -> None:
    r = ChatTurnRecorder()
    r.feed(_delta("checking"))
    r.feed(_tool_start("tc1", "memory_list", "{}", args={"limit": 20}))
    r.feed(_tool_result("tc1", is_error=False, meta="found 3"))
    parts = r.parts()
    assert parts[0] == {"type": "text", "text": "checking"}
    assert parts[1]["type"] == "tool-call"
    assert parts[1]["toolCallId"] == "tc1"
    assert parts[1]["toolName"] == "memory_list"
    assert parts[1]["status"] == "ok"
    assert parts[1]["meta"] == "found 3"
    assert parts[1]["args"] == {"limit": 20}


def test_consume_event_dict_accumulates_like_feed() -> None:
    """proactive_loop feeds already-parsed event dicts via consume_event();
    same accumulation as feed(bytes), just one layer of parsing earlier."""
    r = ChatTurnRecorder()
    r.consume_event(_event(EV_CHAT_DELTA, {"delta": "one "}))
    r.consume_event(_event(EV_CHAT_DELTA, {"delta": "two"}))
    assert r.parts() == [{"type": "text", "text": "one two"}]


def test_consume_event_notify_user_becomes_tool_call_part() -> None:
    """The proactive say-tick contract end to end: a notify_user event the loop
    relays becomes a tool-call part — what _persist_proactive_turn writes
    (trigger=tick) and the FE renders as the user-visible outreach."""
    r = ChatTurnRecorder()
    r.consume_event(_event(EV_CHAT_DELTA, {"delta": "drafting"}))
    r.consume_event(
        _event(
            EV_CHAT_TOOL_START,
            {"toolCallId": "n1", "name": "notify_user", "args": {"text": "你明天 10 点有个会"}},
        )
    )
    r.consume_event(_event(EV_CHAT_TOOL_RESULT, {"toolCallId": "n1", "isError": False}))
    parts = r.parts()
    assert parts[0] == {"type": "text", "text": "drafting"}
    assert parts[1]["type"] == "tool-call"
    assert parts[1]["toolName"] == "notify_user"
    assert parts[1]["status"] == "ok"
    assert parts[1]["args"] == {"text": "你明天 10 点有个会"}


def test_tool_error_status() -> None:
    r = ChatTurnRecorder()
    r.feed(_tool_start("tc1", "foo", "{}"))
    r.feed(_tool_result("tc1", is_error=True, meta="boom"))
    assert r.parts()[0]["status"] == "error"


def test_interleaved_order_preserved() -> None:
    # reasoning → text → tool → more text (a tool-using turn that keeps talking)
    r = ChatTurnRecorder()
    r.feed(_reasoning("r1"))
    r.feed(_delta("t1"))
    r.feed(_tool_start("tc1", "foo", "{}"))
    r.feed(_tool_result("tc1", is_error=False, meta="m"))
    r.feed(_delta("t2"))
    assert [p["type"] for p in r.parts()] == ["reasoning", "text", "tool-call", "text"]
    assert r.parts()[-1] == {"type": "text", "text": "t2"}


def test_event_split_across_chunks() -> None:
    # An SSE event arriving in two TCP chunks must still parse.
    r = ChatTurnRecorder()
    full = _delta("hello")
    mid = len(full) // 2
    r.feed(full[:mid])
    r.feed(full[mid:])
    assert r.parts() == [{"type": "text", "text": "hello"}]


def test_empty_turn_not_recorded() -> None:
    r = ChatTurnRecorder()
    r.feed(emit(EV_CHAT_THINKING))
    r.feed(emit(EV_CHAT_DONE))
    assert r.is_empty()
    assert r.parts() == []


def test_result_before_start_is_ignored() -> None:
    # Defensive: a tool:result with no matching start must not crash.
    r = ChatTurnRecorder()
    r.feed(_tool_result("ghost", is_error=False, meta="x"))
    assert r.parts() == []


def test_tool_start_attribution_fields_persisted() -> None:
    rec = ChatTurnRecorder()
    rec.feed(
        emit(
            EV_CHAT_TOOL_START,
            {
                "toolCallId": "t1",
                "name": "tavily_search",
                "argsPreview": "{}",
                "parentTaskId": "call-task-A",
                "agentName": "general-purpose",
            },
        )
    )
    rec.feed(_tool_start("t2", "memory_search", "{}"))

    nested, plain = rec.parts()
    assert nested["parentTaskId"] == "call-task-A"
    assert nested["agentName"] == "general-purpose"
    assert "parentTaskId" not in plain
    assert "agentName" not in plain


def test_tool_result_links_persisted() -> None:
    rec = ChatTurnRecorder()
    rec.feed(_tool_start("t1", "tavily_search", "{}"))
    rec.feed(
        emit(
            EV_CHAT_TOOL_RESULT,
            {
                "toolCallId": "t1",
                "isError": False,
                "meta": "...",
                "links": [{"title": "Lindy AI", "url": "https://lindy.ai"}],
            },
        )
    )

    (part,) = rec.parts()
    assert part["links"] == [{"title": "Lindy AI", "url": "https://lindy.ai"}]


def test_group_title_backfills_anchor_part_without_new_part() -> None:
    from pinai_contracts.sse_envelope import EV_CHAT_GROUP_TITLE

    rec = ChatTurnRecorder()
    rec.feed(_tool_start("t1", "task", "{}"))
    rec.feed(_delta("progress "))
    rec.feed(emit(EV_CHAT_GROUP_TITLE, {"anchorToolCallId": "t1", "title": "调研了定价"}))
    rec.feed(_delta("update"))

    tool_part, text_part = rec.parts()
    assert tool_part["groupTitle"] == "调研了定价"
    # The annotation must not split the coalescing text part.
    assert text_part == {"type": "text", "text": "progress update"}


def test_group_title_with_unknown_anchor_is_ignored() -> None:
    from pinai_contracts.sse_envelope import EV_CHAT_GROUP_TITLE

    rec = ChatTurnRecorder()
    rec.feed(emit(EV_CHAT_GROUP_TITLE, {"anchorToolCallId": "missing", "title": "x"}))
    assert rec.parts() == []
