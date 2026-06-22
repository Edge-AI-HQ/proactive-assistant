from __future__ import annotations

from agent_engine.agents.main_chat import _INSTRUCTIONS
from agent_engine.tools.direct import ALL_TOOLS


def test_development_feedback_tool_is_registered():
    tool_names = {tool.name for tool in ALL_TOOLS}

    assert "development_feedback_log" in tool_names


def test_main_chat_prompt_routes_product_requests_to_development_feedback():
    prompt = _INSTRUCTIONS.lower()

    assert "development_feedback_log" in prompt
    assert "preference_add" in prompt
    assert "button" in prompt
    assert "ui" in prompt
    assert "feature" in prompt
    assert "do not use `preference_add`" in prompt
    assert "already implemented" in prompt
