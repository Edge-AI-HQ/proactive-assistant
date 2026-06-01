"""Unified SSE envelope shape + helpers — pure-logic tests."""

from __future__ import annotations

import json
import re

import pytest

from pinai_agents.shared.sse_envelope import (
    EV_BROWSER_OPENED,
    EV_CHAT_DELTA,
    EV_CHAT_DONE,
    EV_CHAT_THINKING,
    EV_CHAT_TOOL_RESULT,
    EV_CHAT_TOOL_START,
    EV_TASK_PROGRESS,
    SSEEvent,
    emit,
    validate_event,
)


def _parse_emit_bytes(b: bytes) -> dict:
    text = b.decode()
    assert text.startswith("data: ")
    assert text.endswith("\n\n")
    return json.loads(text[len("data: ") : -2])


def test_emit_returns_sse_framed_bytes():
    out = emit(EV_CHAT_DELTA, {"delta": "hi"}, trace_id="run_x")
    assert isinstance(out, bytes)
    parsed = _parse_emit_bytes(out)
    assert parsed["type"] == "chat:delta"
    assert parsed["data"] == {"delta": "hi"}
    assert parsed["traceId"] == "run_x"
    assert isinstance(parsed["ts"], int) and parsed["ts"] > 0


def test_emit_omits_trace_id_when_none():
    out = emit(EV_CHAT_THINKING)
    parsed = _parse_emit_bytes(out)
    assert "traceId" not in parsed
    assert parsed["data"] == {}


def test_emit_uses_provided_ts_ms():
    out = emit(EV_CHAT_DONE, ts_ms=1700000000000)
    assert _parse_emit_bytes(out)["ts"] == 1700000000000


def test_emit_preserves_unicode():
    out = emit(EV_CHAT_DELTA, {"delta": "你好"})
    # ensure_ascii=False — bytes contain raw UTF-8.
    assert "你好".encode() in out


def test_validate_event_accepts_well_formed():
    payload = {"type": "chat:delta", "ts": 1, "data": {"delta": "x"}}
    ev = validate_event(payload)
    assert isinstance(ev, SSEEvent)
    assert ev.type == "chat:delta"


def test_validate_event_rejects_bad_type_pattern():
    bad_types = [
        "ChatDelta",  # no namespace separator
        "chat:Delta",  # uppercase
        "chat-delta",  # dash instead of colon
        "chat: delta",  # space
        "",
    ]
    for t in bad_types:
        with pytest.raises((ValueError,)):
            validate_event({"type": t, "ts": 1, "data": {}})


def test_validate_event_rejects_extra_top_level_keys():
    """Envelope is closed — flat-shape callers must move payload into `data`."""
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        validate_event(
            {
                "type": "chat:delta",
                "ts": 1,
                "delta": "leaked-flat",  # should be inside `data`
                "data": {},
            }
        )


def test_known_event_types_match_pattern():
    """Living inventory — every constant must validate as a real event type."""
    from pinai_agents.shared import sse_envelope as mod

    type_pattern = re.compile(r"^[a-z]+(:[a-z][a-z_]*)+$")
    for name in dir(mod):
        if not name.startswith("EV_"):
            continue
        value = getattr(mod, name)
        assert type_pattern.match(value), f"{name}={value!r} doesn't match"


def test_to_wire_camel_cases_trace_id():
    ev = SSEEvent(type="chat:delta", ts=1, trace_id="r1", data={"delta": "x"})
    wire = ev.to_wire()
    assert "traceId" in wire
    assert "trace_id" not in wire


def test_namespaces_cover_three_domains():
    """Sanity: the inventory mentions each of chat/browser/task at least once."""
    assert EV_CHAT_DELTA.startswith("chat:")
    assert EV_BROWSER_OPENED.startswith("browser:")
    assert EV_TASK_PROGRESS.startswith("task:")


def test_safe_args_returns_value_when_under_cap():
    from pinai_agents.chat.streaming import _safe_args

    payload = {"todos": [{"content": "step", "status": "pending"}]}
    assert _safe_args(payload) == payload


def test_safe_args_returns_none_for_oversized_payload():
    from pinai_agents.chat.streaming import _ARGS_FULL_LIMIT, _safe_args

    big = {"code": "x" * (_ARGS_FULL_LIMIT + 1)}
    assert _safe_args(big) is None


def test_safe_args_returns_none_for_non_serializable():
    from pinai_agents.chat.streaming import _safe_args

    class Unserializable:
        pass

    assert _safe_args({"obj": Unserializable()}) is None


def test_safe_args_returns_none_for_none_input():
    from pinai_agents.chat.streaming import _safe_args

    assert _safe_args(None) is None


def test_chat_tool_start_includes_args_when_provided():
    from pinai_agents.chat.streaming import chat_tool_start

    out = chat_tool_start(
        tool_call_id="t1",
        name="write_todos",
        args_preview="{...}",
        args={"todos": [{"content": "a", "status": "pending"}]},
    )
    parsed = _parse_emit_bytes(out)
    assert parsed["data"]["args"] == {"todos": [{"content": "a", "status": "pending"}]}


def test_chat_tool_start_omits_args_when_none():
    from pinai_agents.chat.streaming import chat_tool_start

    out = chat_tool_start(
        tool_call_id="t1",
        name="memory_list",
        args_preview="{}",
    )
    parsed = _parse_emit_bytes(out)
    assert "args" not in parsed["data"]


def test_chat_helpers_emit_envelope_shape():
    """Smoke check that chat/streaming.py helpers produce envelopes
    matching what validate_event accepts."""
    from pinai_agents.chat.streaming import (
        chat_delta,
        chat_done,
        chat_error,
        chat_thinking,
        chat_tool_result,
        chat_tool_start,
    )

    samples = [
        chat_thinking(trace_id="r"),
        chat_delta("hi", trace_id="r"),
        chat_tool_start(tool_call_id="t1", name="memory_list", args_preview="{}"),
        chat_tool_result(tool_call_id="t1", is_error=False, meta="ok"),
        chat_error("oops"),
        chat_done(),
    ]
    expected_types = {
        EV_CHAT_THINKING,
        EV_CHAT_DELTA,
        EV_CHAT_TOOL_START,
        EV_CHAT_TOOL_RESULT,
        "chat:error",
        EV_CHAT_DONE,
    }
    seen_types: set[str] = set()
    for sample in samples:
        parsed = _parse_emit_bytes(sample)
        ev = validate_event(parsed)
        seen_types.add(ev.type)
    assert seen_types == expected_types
