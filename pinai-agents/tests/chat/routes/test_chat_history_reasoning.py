from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage

from pinai_agents.chat.transport.routes.history import _build_history


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
        },
    ]
