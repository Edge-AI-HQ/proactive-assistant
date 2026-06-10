"""Request-payload guard against history shapes strict providers reject.

Both fixtures reproduce real dev failures observed 2026-06-10 after the
kimi-k2.6 switch (#63): a persisted 0-token assistant reply made Moonshot 400
every later turn of the thread ("the message at position N with role
'assistant' must not be empty"), and a summarization window that opened
mid-turn left an orphan tool result ("tool_call_id is not found"). The guard
lives in `ChatLiteLLMReasoning._get_request_payload` so every chat-completions
request — old poisoned threads included — is sanitized on replay.

The tests run the real payload builder (including langchain-openai's
v1 → chat-completions conversion, which strips reasoning blocks) and assert on
the final wire shape; nothing is mocked.
"""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from pydantic import SecretStr

from pinai_agents.chat.harness.llm import ChatLiteLLMReasoning


def _model() -> ChatLiteLLMReasoning:
    return ChatLiteLLMReasoning(
        model="kimi-k2.6",
        api_key=SecretStr("sk-test"),
        base_url="http://localhost:4000",
        output_version="v1",
    )


def _payload_messages(messages: list) -> list[dict]:
    return _model()._get_request_payload(messages)["messages"]


def test_empty_assistant_message_dropped() -> None:
    # The poisoned-thread shape: finish_reason=stop, content=[], no tool calls.
    out = _payload_messages(
        [
            SystemMessage(content="sys"),
            HumanMessage(content="确认继续推进并起草回复邮件"),
            AIMessage(content=[], id="lc_run--empty"),
            HumanMessage(content="语气再礼貌一点"),
        ]
    )
    assert [m["role"] for m in out] == ["system", "user", "user"]


def test_blank_string_assistant_message_dropped() -> None:
    out = _payload_messages(
        [
            HumanMessage(content="hi"),
            AIMessage(content="  \n", id="a1"),
            HumanMessage(content="hello?"),
        ]
    )
    assert [m["role"] for m in out] == ["user", "user"]


def test_reasoning_only_assistant_message_dropped() -> None:
    # The v1 converter strips reasoning blocks for chat completions, leaving
    # content=[] — same wire shape as a 0-token reply.
    out = _payload_messages(
        [
            HumanMessage(content="hi"),
            AIMessage(content=[{"type": "reasoning", "reasoning": "thinking..."}], id="a1"),
            HumanMessage(content="hello?"),
        ]
    )
    assert [m["role"] for m in out] == ["user", "user"]


def test_assistant_with_tool_calls_and_its_results_kept() -> None:
    # Reasoning-only content + tool_calls is a normal kimi tool step — the
    # message and its paired tool result must both survive.
    out = _payload_messages(
        [
            HumanMessage(content="给我自己发一封测试email"),
            AIMessage(
                content=[{"type": "reasoning", "reasoning": "plan"}],
                id="a1",
                tool_calls=[{"id": "tc1", "name": "composio_execute", "args": {}}],
            ),
            ToolMessage(content="ok", tool_call_id="tc1"),
            AIMessage(content="done", id="a2"),
        ]
    )
    assert [m["role"] for m in out] == ["user", "assistant", "tool", "assistant"]
    assert out[1]["tool_calls"][0]["id"] == "tc1"
    assert out[2]["tool_call_id"] == "tc1"


def test_orphan_tool_result_dropped() -> None:
    # The summarized-thread shape: the window opens on a tool result whose
    # calling assistant message was folded away.
    out = _payload_messages(
        [
            SystemMessage(content="sys"),
            HumanMessage(content="(conversation summary)"),
            ToolMessage(content="Error: file_not_found", tool_call_id="toolu_gone"),
            HumanMessage(content="你好"),
        ]
    )
    assert [m["role"] for m in out] == ["system", "user", "user"]


def test_normal_conversation_untouched() -> None:
    out = _payload_messages(
        [
            SystemMessage(content="sys"),
            HumanMessage(content="hi"),
            AIMessage(
                content=[
                    {"type": "reasoning", "reasoning": "think"},
                    {"type": "text", "text": "hello!"},
                ],
                id="a1",
            ),
            HumanMessage(content="thanks"),
        ]
    )
    assert [m["role"] for m in out] == ["system", "user", "assistant", "user"]
    assert out[2]["content"] == [{"type": "text", "text": "hello!"}]
