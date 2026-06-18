"""CurrentDatetimeMiddleware: transient day-granular <current_datetime> anchor.

Locks the two properties that keep us off Anthropic's cache_control limit
and keep the prompt cache stable:
  * DAY granularity (no HH:MM) — a minute-granular block would change every
    call and, since LiteLLM hoists system messages ahead of the conversation,
    bust the prompt cache each turn.
  * FRONT placement (never last) — the LiteLLM `index:-1` breakpoint must land
    on the final user turn, not on this anchor.
  * Gated on the per-run `current_timezone` ContextVar — empty → no-op (so the
    anchor never gets persisted/accumulated, the original 400's root cause).
"""

from __future__ import annotations

import re

from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import HumanMessage, SystemMessage

from pinai_agents.chat.harness.ctx import current_timezone
from pinai_agents.chat.harness.middleware import (
    CurrentDatetimeMiddleware,
    _current_datetime_message,
    _inject_datetime,
)

_WEEKDAYS = {
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
}


def _make_request(messages: list) -> ModelRequest:
    return ModelRequest(
        model=None,
        messages=messages,
        system_message=None,
        tool_choice=None,
        tools=[],
        response_format=None,
        state={},
        runtime=None,
    )


def test_anchor_is_day_granular_no_time():
    content = _current_datetime_message("Asia/Shanghai").content
    assert "<current_datetime>" in content
    assert "</current_datetime>" in content
    assert "(Asia/Shanghai)" in content
    assert any(day in content for day in _WEEKDAYS)
    # YYYY-MM-DD present...
    assert re.search(r"\d{4}-\d{2}-\d{2}", content)
    # ...but NO time-of-day component (day granularity is the cache contract).
    assert not re.search(r"\d{1,2}:\d{2}", content)


def test_anchor_invalid_timezone_falls_back_to_utc():
    content = _current_datetime_message("Not/AZone").content
    assert "(UTC)" in content


def test_inject_empty_timezone_is_identity():
    messages = [HumanMessage("hi")]
    assert _inject_datetime(messages, "") is messages


def test_inject_prepends_single_anchor_at_front():
    messages = [SystemMessage("<card_context>…"), HumanMessage("first"), HumanMessage("last")]
    out = _inject_datetime(messages, "America/Los_Angeles")
    assert len(out) == len(messages) + 1
    # anchor first, never last
    assert isinstance(out[0], SystemMessage)
    assert "<current_datetime>" in out[0].content
    assert out[-1] is messages[-1]
    # exactly one current_datetime anchor added
    assert sum("<current_datetime>" in m.content for m in out if isinstance(m, SystemMessage)) == 1


def test_middleware_injects_when_timezone_set():
    mw = CurrentDatetimeMiddleware()
    req = _make_request([HumanMessage("hi"), HumanMessage("there")])
    token = current_timezone.set("Asia/Shanghai")
    try:
        out = mw._with_datetime(req)
    finally:
        current_timezone.reset(token)
    assert out is not req
    assert isinstance(out.messages[0], SystemMessage)
    assert "(Asia/Shanghai)" in out.messages[0].content
    assert out.messages[-1] is req.messages[-1]
    assert len(out.messages) == len(req.messages) + 1
    # immutable override — original request untouched
    assert len(req.messages) == 2


def test_middleware_noop_without_timezone():
    mw = CurrentDatetimeMiddleware()
    req = _make_request([HumanMessage("hi")])
    token = current_timezone.set("")
    try:
        out = mw._with_datetime(req)
    finally:
        current_timezone.reset(token)
    assert out is req
