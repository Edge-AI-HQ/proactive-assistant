from __future__ import annotations

from agent_engine.transport.routes.history import _build_history
from langchain_core.messages import AIMessage, HumanMessage


def test_history_preserves_openai_responses_reasoning_summary() -> None:
    history = _build_history(
        [
            HumanMessage(content="What should I do next?", id="user-1"),
            AIMessage(
                id="assistant-1",
                content=[
                    {
                        "type": "reasoning",
                        "summary": [
                            {
                                "type": "summary_text",
                                "text": "Checked the card context before answering.",
                            }
                        ],
                    },
                    {"type": "text", "text": "Draft the agenda first."},
                ],
            ),
        ]
    )

    assert history == [
        {
            "id": "user-1",
            "role": "user",
            "parts": [{"type": "text", "text": "What should I do next?"}],
        },
        {
            "id": "assistant-1",
            "role": "assistant",
            "parts": [
                {
                    "type": "reasoning",
                    "text": "Checked the card context before answering.",
                },
                {"type": "text", "text": "Draft the agenda first."},
            ],
            # `_build_history` tags each assistant turn with how it was
            # triggered (user vs heartbeat tick) so the UI can hide tick turns
            # under Debug. A plain HumanMessage → "user".
            "trigger": "user",
        },
    ]
