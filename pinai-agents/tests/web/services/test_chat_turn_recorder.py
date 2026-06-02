"""ChatTurnRecorder: SSE byte stream → assistant-turn parts.

SSE is generated via shared.sse_envelope.emit with the exact field names
chat/streaming.py sends (toolCallId / name / argsPreview / args / isError /
meta / delta) — so this also pins the web↔chat wire contract. We do NOT
import chat.transport.sse here (trust-boundary banned-api).
"""

from __future__ import annotations

from pinai_agents.shared.sse_envelope import (
    EV_CHAT_DELTA,
    EV_CHAT_DONE,
    EV_CHAT_REASONING_DELTA,
    EV_CHAT_THINKING,
    EV_CHAT_TOOL_RESULT,
    EV_CHAT_TOOL_START,
    emit,
)
from pinai_agents.web.services.chat_turn_recorder import ChatTurnRecorder


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
