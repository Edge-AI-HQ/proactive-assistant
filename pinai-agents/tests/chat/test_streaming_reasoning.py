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


@pytest.mark.asyncio
async def test_turn_stats_collects_last_orchestrator_call_and_skips_subagents() -> None:
    from pinai_agents.chat.transport.sse import TurnStats

    def _model_call(
        run_id: str,
        *,
        n_msgs: int,
        tokens: int,
        ns: str = "model:x",
        extra_meta: dict | None = None,
    ) -> list:
        # `langgraph_checkpoint_ns` is the key _event_ns_segments reads.
        meta = {"langgraph_checkpoint_ns": ns, **(extra_meta or {})}
        return [
            {
                "event": "on_chat_model_start",
                "run_id": run_id,
                "metadata": meta,
                "data": {"input": {"messages": [[SimpleNamespace()] * n_msgs]}},
            },
            {
                "event": "on_chat_model_end",
                "run_id": run_id,
                "metadata": meta,
                "data": {
                    "output": SimpleNamespace(
                        content="ok",
                        usage_metadata={"input_tokens": tokens, "output_tokens": 10},
                    )
                },
            },
        ]

    async def events():
        # Filtered calls come AFTER the last orchestrator call with bigger
        # numbers, so a broken filter overwrites the expectation and fails
        # the assertions (last-write-wins would otherwise mask it).
        for ev in [
            *_model_call("m1", n_msgs=5, tokens=100),
            *_model_call("m2", n_msgs=9, tokens=300),
            *_model_call("sub", n_msgs=400, tokens=999_999, ns="tools:task|model:y"),
            *_model_call(
                "summ",
                n_msgs=500,
                tokens=888_888,
                extra_meta={"lc_source": "summarization"},
            ),
        ]:
            yield ev

    stats = TurnStats()
    async for _ in langgraph_to_sse(events(), trace_id="trace-1", stats=stats):
        pass

    assert stats.last_msg_count == 9
    assert stats.last_input_tokens == 310  # input+output of the LAST orchestrator call
    assert stats.interrupted is False
    assert stats.saw_empty_ai_message is False


@pytest.mark.asyncio
async def test_turn_stats_flags_empty_final_reply() -> None:
    from langchain_core.messages import AIMessageChunk

    from pinai_agents.chat.transport.sse import TurnStats

    async def events():
        # The poisoned-thread shape: a streamed turn whose aggregated final
        # output is AIMessageChunk(content=[]) — what scrub removes.
        yield {
            "event": "on_chat_model_end",
            "run_id": "m1",
            "data": {"output": AIMessageChunk(content=[])},
        }

    stats = TurnStats()
    async for _ in langgraph_to_sse(events(), trace_id="trace-1", stats=stats):
        pass

    assert stats.saw_empty_ai_message is True


@pytest.mark.asyncio
async def test_turn_stats_no_usage_leaves_tokens_none() -> None:
    from pinai_agents.chat.transport.sse import TurnStats

    async def events():
        yield {
            "event": "on_chat_model_end",
            "run_id": "m1",
            "data": {"output": SimpleNamespace(content="ok", usage_metadata=None)},
        }

    stats = TurnStats()
    async for _ in langgraph_to_sse(events(), trace_id="trace-1", stats=stats):
        pass

    assert stats.last_input_tokens is None


@pytest.mark.asyncio
async def test_turn_stats_marks_interrupt() -> None:
    from pinai_agents.chat.transport.sse import TurnStats

    async def events():
        yield {
            "event": "on_chain_stream",
            "run_id": "c1",
            "data": {
                "chunk": {
                    "__interrupt__": (
                        SimpleNamespace(
                            id="intr-1",
                            value={
                                "action_requests": [{"name": "send_email", "args": {}}],
                                "review_configs": [],
                            },
                        ),
                    )
                }
            },
        }

    stats = TurnStats()
    payloads = [
        _decode_sse_event(raw)
        async for raw in langgraph_to_sse(events(), trace_id="trace-1", stats=stats)
    ]

    assert stats.interrupted is True
    assert "chat:requires_action" in [p["type"] for p in payloads]
