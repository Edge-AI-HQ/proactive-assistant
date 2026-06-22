"""Work-group title scheduling in langgraph_to_sse.

A "work group" = the contiguous reasoning/tool run between visible text
segments. On close (first text delta, or stream end) the translator
schedules an async title via the injected group_title_fn and emits
chat:group:title anchored to the group's first tool-call id. Contract under
test: size gate, anchor choice, non-blocking drain, pre-done flush,
interrupt suppression, and graceful no-op when titling fails.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest
from agent_engine.transport.sse import langgraph_to_sse


def _decode(raw: bytes) -> dict[str, Any]:
    text = raw.decode()
    assert text.startswith("data: ")
    return json.loads(text.removeprefix("data: ").strip())


def _reasoning_event(text: str) -> dict[str, Any]:
    return {
        "event": "on_chat_model_stream",
        "run_id": "model-1",
        "data": {"chunk": SimpleNamespace(content=[{"type": "reasoning", "reasoning": text}])},
    }


def _text_event(text: str) -> dict[str, Any]:
    return {
        "event": "on_chat_model_stream",
        "run_id": "model-1",
        "data": {"chunk": SimpleNamespace(content=[{"type": "text", "text": text}])},
    }


def _tool_pair(name: str, call_id: str, args: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    md = {"langgraph_checkpoint_ns": f"tools:{call_id}"}
    return [
        {
            "event": "on_tool_start",
            "run_id": call_id,
            "name": name,
            "metadata": md,
            "data": {"input": args or {"q": "x"}},
        },
        {
            "event": "on_tool_end",
            "run_id": call_id,
            "name": name,
            "metadata": md,
            "data": {"output": SimpleNamespace(content="ok", status="success")},
        },
    ]


class _RecordingTitleFn:
    def __init__(self, title: str | None = "调研了三个主题") -> None:
        self.calls: list[list[str]] = []
        self._title = title

    async def __call__(self, items: list[str]) -> str | None:
        self.calls.append(items)
        return self._title


async def _run(events_list: list[dict[str, Any]], title_fn) -> list[dict[str, Any]]:
    async def events():
        for e in events_list:
            yield e

    return [
        _decode(raw)
        async for raw in langgraph_to_sse(events(), trace_id="t", group_title_fn=title_fn)
    ]


@pytest.mark.asyncio
async def test_group_of_three_tools_gets_title_anchored_to_first() -> None:
    title_fn = _RecordingTitleFn()
    events = [
        _reasoning_event("planning the research"),
        *_tool_pair("tavily_search", "c1"),
        *_tool_pair("tavily_search", "c2"),
        *_tool_pair("world_search", "c3"),
        _text_event("Here is what I found."),
    ]

    payloads = await _run(events, title_fn)

    titles = [p for p in payloads if p["type"] == "chat:group:title"]
    assert len(titles) == 1
    assert titles[0]["data"] == {"anchorToolCallId": "c1", "title": "调研了三个主题"}
    # done is always last; the title frame must precede it.
    assert payloads[-1]["type"] == "chat:done"
    # The digest led with the reasoning line and described the tools.
    (items,) = title_fn.calls
    assert items[0].startswith("reasoning: planning")
    assert any(item.startswith("tool tavily_search") for item in items)


@pytest.mark.asyncio
async def test_small_group_without_task_is_not_titled() -> None:
    title_fn = _RecordingTitleFn()
    events = [
        *_tool_pair("memory_search", "c1"),
        *_tool_pair("memory_get", "c2"),
        _text_event("done"),
    ]

    payloads = await _run(events, title_fn)

    assert title_fn.calls == []
    assert all(p["type"] != "chat:group:title" for p in payloads)


@pytest.mark.asyncio
async def test_single_task_group_is_titled() -> None:
    title_fn = _RecordingTitleFn()
    events = [
        *_tool_pair(
            "task", "c1", {"description": "research pricing", "subagent_type": "general-purpose"}
        ),
        _text_event("done"),
    ]

    payloads = await _run(events, title_fn)

    (items,) = title_fn.calls
    assert any(item.startswith("task: research pricing") for item in items)
    assert any(item.startswith("task result: ok") for item in items)
    assert any(p["type"] == "chat:group:title" for p in payloads)


@pytest.mark.asyncio
async def test_trailing_group_flushes_before_done() -> None:
    """A turn ending on tools (no trailing text) still titles its group."""
    title_fn = _RecordingTitleFn()
    events = [
        *_tool_pair("task", "c1", {"description": "x"}),
    ]

    payloads = await _run(events, title_fn)

    title_idx = next(i for i, p in enumerate(payloads) if p["type"] == "chat:group:title")
    done_idx = next(i for i, p in enumerate(payloads) if p["type"] == "chat:done")
    assert title_idx < done_idx


@pytest.mark.asyncio
async def test_interrupted_turn_does_not_title_the_open_group() -> None:
    interrupt = SimpleNamespace(
        value={"action_requests": [{"name": "propose_action", "args": {}}], "review_configs": []},
        id="intr-1",
    )
    title_fn = _RecordingTitleFn()
    events = [
        *_tool_pair("task", "c1", {"description": "x"}),
        {
            "event": "on_chain_stream",
            "run_id": "chain-1",
            "data": {"chunk": {"__interrupt__": (interrupt,)}},
        },
    ]

    payloads = await _run(events, title_fn)

    assert title_fn.calls == []
    assert all(p["type"] != "chat:group:title" for p in payloads)


@pytest.mark.asyncio
async def test_failed_title_emits_nothing() -> None:
    title_fn = _RecordingTitleFn(title=None)
    events = [
        *_tool_pair("task", "c1", {"description": "x"}),
        _text_event("done"),
    ]

    payloads = await _run(events, title_fn)

    assert len(title_fn.calls) == 1
    assert all(p["type"] != "chat:group:title" for p in payloads)


@pytest.mark.asyncio
async def test_two_groups_title_independently() -> None:
    title_fn = _RecordingTitleFn()
    events = [
        *_tool_pair("task", "c1", {"description": "first"}),
        _text_event("progress update one"),
        *_tool_pair("task", "c2", {"description": "second"}),
        _text_event("final answer"),
    ]

    payloads = await _run(events, title_fn)

    anchors = [p["data"]["anchorToolCallId"] for p in payloads if p["type"] == "chat:group:title"]
    # Frame order is unspecified (titles resolve asynchronously; the frontend
    # backfills by anchor) — both groups must get exactly one title each.
    assert sorted(anchors) == ["c1", "c2"]
    assert len(title_fn.calls) == 2


@pytest.mark.asyncio
async def test_no_title_fn_keeps_stream_shape() -> None:
    events = [
        *_tool_pair("task", "c1", {"description": "x"}),
        _text_event("done"),
    ]

    payloads = await _run(events, None)

    assert all(p["type"] != "chat:group:title" for p in payloads)
    assert payloads[-1]["type"] == "chat:done"
