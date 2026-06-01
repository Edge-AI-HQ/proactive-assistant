from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest

from pinai_agents.chat.streaming import langgraph_to_sse


def _decode_sse_event(raw: bytes) -> dict[str, Any]:
    text = raw.decode()
    assert text.startswith("data: ")
    return json.loads(text.removeprefix("data: ").strip())


@pytest.mark.asyncio
async def test_non_streaming_chat_model_end_emits_reasoning_and_text() -> None:
    async def events():
        yield {
            "event": "on_chat_model_end",
            "run_id": "model-run-1",
            "data": {
                "output": SimpleNamespace(
                    content=[
                        {
                            "type": "reasoning",
                            "summary": [
                                {
                                    "type": "summary_text",
                                    "text": "Compared the available options first.",
                                }
                            ],
                        },
                        {"type": "text", "text": "Use the smallest safe fix."},
                    ]
                )
            },
        }

    payloads = [
        _decode_sse_event(raw) async for raw in langgraph_to_sse(events(), trace_id="trace-1")
    ]

    assert [payload["type"] for payload in payloads] == [
        "chat:thinking",
        "chat:reasoning:delta",
        "chat:delta",
        "chat:done",
    ]
    assert payloads[1]["data"]["delta"] == "Compared the available options first."
    assert payloads[2]["data"]["delta"] == "Use the smallest safe fix."


@pytest.mark.asyncio
async def test_responses_streaming_chunk_emits_reasoning_and_text_deltas() -> None:
    async def events():
        yield {
            "event": "on_chat_model_stream",
            "run_id": "model-run-1",
            "data": {
                "chunk": SimpleNamespace(
                    content=[
                        {
                            "type": "reasoning",
                            "summary": [
                                {
                                    "type": "summary_text",
                                    "text": "Streaming summary from OpenAI Responses.",
                                }
                            ],
                        },
                        {"type": "text", "text": "Streaming visible answer."},
                    ]
                )
            },
        }

    payloads = [
        _decode_sse_event(raw) async for raw in langgraph_to_sse(events(), trace_id="trace-1")
    ]

    assert [payload["type"] for payload in payloads] == [
        "chat:thinking",
        "chat:reasoning:delta",
        "chat:delta",
        "chat:done",
    ]
    assert payloads[1]["data"]["delta"] == "Streaming summary from OpenAI Responses."
    assert payloads[2]["data"]["delta"] == "Streaming visible answer."


@pytest.mark.asyncio
async def test_responses_streaming_reasoning_preserves_token_spacing() -> None:
    async def events():
        for text in ["I", " need", " to", " keep", " spaces."]:
            yield {
                "event": "on_chat_model_stream",
                "run_id": "model-run-1",
                "data": {
                    "chunk": SimpleNamespace(
                        content=[
                            {
                                "type": "reasoning",
                                "summary": [{"type": "summary_text", "text": text}],
                            }
                        ]
                    )
                },
            }

    payloads = [
        _decode_sse_event(raw) async for raw in langgraph_to_sse(events(), trace_id="trace-1")
    ]

    reasoning_deltas = [
        payload["data"]["delta"]
        for payload in payloads
        if payload["type"] == "chat:reasoning:delta"
    ]
    assert "".join(reasoning_deltas) == "I need to keep spaces."


@pytest.mark.asyncio
async def test_streamed_chat_model_end_does_not_duplicate_text() -> None:
    async def events():
        yield {
            "event": "on_chat_model_stream",
            "run_id": "model-run-1",
            "data": {
                "chunk": SimpleNamespace(content=[{"type": "text", "text": "Already streamed."}])
            },
        }
        yield {
            "event": "on_chat_model_end",
            "run_id": "model-run-1",
            "data": {
                "output": SimpleNamespace(content=[{"type": "text", "text": "Already streamed."}])
            },
        }

    payloads = [
        _decode_sse_event(raw) async for raw in langgraph_to_sse(events(), trace_id="trace-1")
    ]

    assert [payload["type"] for payload in payloads] == [
        "chat:thinking",
        "chat:delta",
        "chat:done",
    ]
    assert payloads[1]["data"]["delta"] == "Already streamed."


@pytest.mark.asyncio
async def test_streamed_chat_model_end_keeps_final_only_reasoning() -> None:
    async def events():
        yield {
            "event": "on_chat_model_stream",
            "run_id": "model-run-1",
            "data": {
                "chunk": SimpleNamespace(content=[{"type": "text", "text": "Already streamed."}])
            },
        }
        yield {
            "event": "on_chat_model_end",
            "run_id": "model-run-1",
            "data": {
                "output": SimpleNamespace(
                    content=[
                        {
                            "type": "reasoning",
                            "summary": [
                                {
                                    "type": "summary_text",
                                    "text": "Final-only reasoning summary.",
                                }
                            ],
                        },
                        {"type": "text", "text": "Already streamed."},
                    ]
                )
            },
        }

    payloads = [
        _decode_sse_event(raw) async for raw in langgraph_to_sse(events(), trace_id="trace-1")
    ]

    assert [payload["type"] for payload in payloads] == [
        "chat:thinking",
        "chat:delta",
        "chat:reasoning:delta",
        "chat:done",
    ]
    assert payloads[1]["data"]["delta"] == "Already streamed."
    assert payloads[2]["data"]["delta"] == "Final-only reasoning summary."
