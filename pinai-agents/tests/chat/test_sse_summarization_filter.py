"""SummarizationMiddleware's internal LLM call must not leak into the SSE wire.

langchain stamps that call with metadata `lc_source=summarization`
(langchain/agents/middleware/summarization.py). Under astream_events it runs
as an implicit stream in the SAME checkpoint_ns as the real model call, so
sse.py filters on the metadata stamp. Regression guard for the prod
"## SESSION INTENT" leak (pai_chat_messages id=114) — and for the langchain
private convention itself: if an upgrade drops `lc_source`, these tests fail.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest

from pinai_agents.chat.transport.sse import langgraph_to_sse


def _decode_sse_event(raw: bytes) -> dict[str, Any]:
    text = raw.decode()
    assert text.startswith("data: ")
    return json.loads(text.removeprefix("data: ").strip())


def _summary_chunk(text: str) -> SimpleNamespace:
    return SimpleNamespace(content=[{"type": "text", "text": text}])


@pytest.mark.asyncio
async def test_summarization_stream_and_end_are_dropped() -> None:
    summary_md = {"lc_source": "summarization", "checkpoint_ns": "model:abc"}

    async def events():
        yield {
            "event": "on_chat_model_stream",
            "run_id": "summary-run",
            "metadata": summary_md,
            "data": {"chunk": _summary_chunk("## SESSION INTENT\n...")},
        }
        yield {
            "event": "on_chat_model_end",
            "run_id": "summary-run",
            "metadata": summary_md,
            "data": {"output": _summary_chunk("## SESSION INTENT\nfull summary")},
        }
        yield {
            "event": "on_chat_model_stream",
            "run_id": "real-run",
            "metadata": {"checkpoint_ns": "model:abc"},
            "data": {"chunk": _summary_chunk("real reply")},
        }

    payloads = [_decode_sse_event(raw) async for raw in langgraph_to_sse(events(), trace_id="t")]

    assert [p["type"] for p in payloads] == ["chat:thinking", "chat:delta", "chat:done"]
    assert payloads[1]["data"]["delta"] == "real reply"


@pytest.mark.asyncio
async def test_summarization_reasoning_is_dropped_too() -> None:
    async def events():
        yield {
            "event": "on_chat_model_stream",
            "run_id": "summary-run",
            "metadata": {"lc_source": "summarization"},
            "data": {
                "chunk": SimpleNamespace(
                    content=[{"type": "reasoning", "reasoning": "summarizer thinking"}]
                )
            },
        }

    payloads = [_decode_sse_event(raw) async for raw in langgraph_to_sse(events(), trace_id="t")]

    assert [p["type"] for p in payloads] == ["chat:thinking", "chat:done"]


def test_langchain_still_stamps_summarization_calls() -> None:
    """The filter keys on a PRIVATE langchain convention. The other tests in
    this file feed synthetic events, so they'd stay green even if an upgrade
    dropped the stamp — this one fails the moment langchain stops attaching
    `lc_source=summarization` to the summary call (re-opening the leak)."""
    import inspect

    from langchain.agents.middleware import summarization

    source = inspect.getsource(summarization)
    assert '"lc_source": "summarization"' in source


@pytest.mark.asyncio
async def test_other_lc_source_values_still_stream() -> None:
    async def events():
        yield {
            "event": "on_chat_model_stream",
            "run_id": "real-run",
            "metadata": {"lc_source": "something_else"},
            "data": {"chunk": _summary_chunk("visible")},
        }

    payloads = [_decode_sse_event(raw) async for raw in langgraph_to_sse(events(), trace_id="t")]

    assert [p["type"] for p in payloads] == ["chat:thinking", "chat:delta", "chat:done"]
    assert payloads[1]["data"]["delta"] == "visible"
