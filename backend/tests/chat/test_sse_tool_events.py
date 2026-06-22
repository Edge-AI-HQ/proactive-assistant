"""on_tool_end meta extraction — Command outputs surface their ToolMessage.

`task` (subagent delegation) and `write_todos` return a langgraph Command;
the old `getattr(output, "content")` fallback rendered them as a
`Command(update={...})` repr, burying the subagent's final answer
(prod msg id=114: every task result was an unreadable repr).
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest
from agent_engine.transport.sse import langgraph_to_sse
from langchain_core.messages import ToolMessage
from langgraph.types import Command


def _decode_sse_event(raw: bytes) -> dict[str, Any]:
    text = raw.decode()
    assert text.startswith("data: ")
    return json.loads(text.removeprefix("data: ").strip())


async def _tool_result_payload(output: Any) -> dict[str, Any]:
    async def events():
        yield {
            "event": "on_tool_end",
            "run_id": "tool-run-1",
            "data": {"output": output},
        }

    payloads = [_decode_sse_event(raw) async for raw in langgraph_to_sse(events(), trace_id="t")]
    results = [p for p in payloads if p["type"] == "chat:tool:result"]
    assert len(results) == 1
    return results[0]["data"]


@pytest.mark.asyncio
async def test_task_command_output_surfaces_subagent_answer() -> None:
    output = Command(
        update={
            "files": {},
            "messages": [
                ToolMessage(
                    content="# Research Summary\n\nGoogle one-tap connector findings...",
                    tool_call_id="call-task-1",
                )
            ],
        }
    )

    data = await _tool_result_payload(output)

    assert data["isError"] is False
    assert data["meta"].startswith("# Research Summary")
    assert "Command(update=" not in data["meta"]


@pytest.mark.asyncio
async def test_command_with_error_tool_message_marks_error() -> None:
    output = Command(
        update={
            "messages": [
                ToolMessage(
                    content="subagent failed",
                    tool_call_id="call-task-1",
                    status="error",
                )
            ]
        }
    )

    data = await _tool_result_payload(output)

    assert data["isError"] is True
    assert data["meta"] == "subagent failed"


@pytest.mark.asyncio
async def test_command_without_messages_falls_back_to_repr() -> None:
    output = Command(update={"todos": [{"content": "x", "status": "pending"}]})

    data = await _tool_result_payload(output)

    assert data["isError"] is False
    assert "Command" in data["meta"]  # repr fallback, but must not raise


@pytest.mark.asyncio
async def test_plain_tool_message_output_unchanged() -> None:
    output = SimpleNamespace(content="plain result", status="success")

    data = await _tool_result_payload(output)

    assert data["isError"] is False
    assert data["meta"] == "plain result"


# --- nested write_todos suppression (subagent plan must not reach the UI) ---


def _tool_events(name: str, ns: str):
    md = {"langgraph_checkpoint_ns": ns}

    async def events():
        yield {
            "event": "on_tool_start",
            "run_id": "tool-run-1",
            "name": name,
            "metadata": md,
            "data": {"input": {"todos": []}},
        }
        yield {
            "event": "on_tool_end",
            "run_id": "tool-run-1",
            "name": name,
            "metadata": md,
            "data": {"output": SimpleNamespace(content="ok", status="success")},
        }

    return events()


async def _frame_types(events) -> list[str]:
    return [_decode_sse_event(raw)["type"] async for raw in langgraph_to_sse(events, trace_id="t")]


@pytest.mark.asyncio
async def test_nested_write_todos_emits_no_frames() -> None:
    types = await _frame_types(_tool_events("write_todos", "tools:outer-task|tools:inner-call"))
    assert types == ["chat:thinking", "chat:done"]


@pytest.mark.asyncio
async def test_main_graph_write_todos_still_emits() -> None:
    # The orchestrator's own tool events are single-segment (`tools:<id>`) —
    # they must NOT be mistaken for nested ones.
    types = await _frame_types(_tool_events("write_todos", "tools:main-call"))
    assert types == ["chat:thinking", "chat:tool:start", "chat:tool:result", "chat:done"]


@pytest.mark.asyncio
async def test_nested_non_todo_tools_still_emit() -> None:
    types = await _frame_types(_tool_events("tavily_search", "tools:outer-task|tools:inner-call"))
    assert types == ["chat:thinking", "chat:tool:start", "chat:tool:result", "chat:done"]


# --- structured links on web-search tool results ---


async def _result_payload_for(name: str, output: Any) -> dict[str, Any]:
    async def events():
        yield {
            "event": "on_tool_end",
            "run_id": "tool-run-1",
            "name": name,
            "data": {"output": output},
        }

    payloads = [_decode_sse_event(raw) async for raw in langgraph_to_sse(events(), trace_id="t")]
    return next(p["data"] for p in payloads if p["type"] == "chat:tool:result")


@pytest.mark.asyncio
async def test_tavily_search_results_become_links() -> None:
    content = json.dumps(
        {
            "results": [
                {"title": "Lindy AI", "url": "https://lindy.ai", "content": "snippet"},
                {"title": "", "url": "https://gmelius.com/post"},
                {"url": "https://no-title.example"},
            ]
        }
    )
    output = SimpleNamespace(content=content, status="success")

    data = await _result_payload_for("tavily_search", output)

    # Missing titles fall back to the domain (an extract result has none) —
    # far more readable in a source row than the full URL.
    assert data["links"] == [
        {"title": "Lindy AI", "url": "https://lindy.ai"},
        {"title": "gmelius.com", "url": "https://gmelius.com/post"},
        {"title": "no-title.example", "url": "https://no-title.example"},
    ]


@pytest.mark.asyncio
async def test_links_capped_at_ten() -> None:
    content = json.dumps(
        {"results": [{"title": f"r{i}", "url": f"https://x.example/{i}"} for i in range(15)]}
    )
    output = SimpleNamespace(content=content, status="success")

    data = await _result_payload_for("tavily_search", output)

    assert len(data["links"]) == 10


@pytest.mark.asyncio
async def test_non_json_or_non_link_tools_omit_links() -> None:
    not_json = SimpleNamespace(content="plain text result", status="success")
    data = await _result_payload_for("tavily_extract", not_json)
    assert "links" not in data

    other_tool = SimpleNamespace(
        content=json.dumps({"results": [{"url": "https://x.example"}]}),
        status="success",
    )
    data = await _result_payload_for("memory_search", other_tool)
    assert "links" not in data


# --- task attribution (parentTaskId / agentName on nested tool starts) ---


def _task_start(run_id: str, ns: str) -> dict[str, Any]:
    """The `task` tool's own on_tool_start: single-segment ns = the subgraph
    root every nested event's first segment equals (probe-verified)."""
    return {
        "event": "on_tool_start",
        "run_id": run_id,
        "name": "task",
        "metadata": {"langgraph_checkpoint_ns": ns},
        "data": {"input": {"description": "research X", "subagent_type": "general-purpose"}},
    }


def _nested_tool_start(name: str, ns: str, agent: str | None = "general-purpose"):
    md: dict[str, Any] = {"langgraph_checkpoint_ns": ns}
    if agent is not None:
        md["lc_agent_name"] = agent
    return {
        "event": "on_tool_start",
        "run_id": f"run-{name}-{ns}",
        "name": name,
        "metadata": md,
        "data": {"input": {"query": "x"}},
    }


async def _tool_start_payloads(events) -> list[dict[str, Any]]:
    return [
        _decode_sse_event(raw)["data"]
        async for raw in langgraph_to_sse(events, trace_id="t")
        if _decode_sse_event(raw)["type"] == "chat:tool:start"
    ]


@pytest.mark.asyncio
async def test_nested_tools_nest_under_the_task_frames_own_id() -> None:
    """THE attribution invariant: parentTaskId must equal the toolCallId of an
    already-emitted task frame — that's the only id the frontend can nest by.
    (The original implementation keyed on the Send payload's LLM call id, a
    different id namespace, and nesting silently never matched in prod.)"""

    async def events():
        yield _task_start("task-run-A", "tools:TA")
        yield _task_start("task-run-B", "tools:TB")
        yield _nested_tool_start("tavily_search", "tools:TA|tools:x1")
        yield _nested_tool_start("browser_tool", "tools:TB|tools:x2")

    starts = await _tool_start_payloads(events())

    task_frame_ids = [s["toolCallId"] for s in starts if s["name"] == "task"]
    nested = [s for s in starts if "parentTaskId" in s]
    assert [s["parentTaskId"] for s in nested] == task_frame_ids
    assert nested[0]["parentTaskId"] == "task-run-A"
    assert nested[1]["parentTaskId"] == "task-run-B"
    assert nested[0]["agentName"] == "general-purpose"


@pytest.mark.asyncio
async def test_orchestrator_tools_carry_no_attribution() -> None:
    async def events():
        yield _task_start("task-run-A", "tools:TA")
        # The orchestrator's own non-task tool — single-segment ns.
        yield _nested_tool_start("memory_search", "tools:main-1", agent=None)

    starts = await _tool_start_payloads(events())

    for start in starts:
        assert "parentTaskId" not in start
        assert "agentName" not in start


@pytest.mark.asyncio
async def test_unmapped_nested_event_degrades_to_flat_frame() -> None:
    """HITL resume starts a fresh stream — nested events whose task start
    happened before the pause must keep the exact pre-attribution shape."""

    async def events():
        yield _nested_tool_start("tavily_search", "tools:unknown|tools:x1")

    starts = await _tool_start_payloads(events())

    assert "parentTaskId" not in starts[0]
    assert "agentName" not in starts[0]
    assert starts[0]["name"] == "tavily_search"
