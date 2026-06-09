from __future__ import annotations

from pinai_agents.chat.agents.main_chat import _INSTRUCTIONS
from pinai_agents.chat.tools.direct import ALL_TOOLS, SIDE_EFFECT_TOOL_NAMES

_SCHEDULED_TOOLS = {
    "scheduled_generator_preview",
    "scheduled_generator_create",
    "scheduled_generator_list",
    "scheduled_generator_pause",
    "scheduled_generator_resume",
    "scheduled_generator_delete",
}


def test_scheduled_generator_tools_registered():
    tool_names = {tool.name for tool in ALL_TOOLS}
    assert tool_names >= _SCHEDULED_TOOLS


def test_scheduled_generator_tools_are_reply_gated_not_hitl():
    # v1 confirmation is an explicit user reply, so create/delete must NOT
    # sit in the HITL side-effect gate — that would add an approval popup
    # on top of the reply confirmation.
    assert "scheduled_generator_create" not in SIDE_EFFECT_TOOL_NAMES
    assert "scheduled_generator_delete" not in SIDE_EFFECT_TOOL_NAMES


def test_main_chat_prompt_routes_scheduled_requests():
    prompt = _INSTRUCTIONS
    lower = prompt.lower()
    # The two-step flow is spelled out.
    assert "scheduled_generator_preview" in lower
    assert "scheduled_generator_create" in lower
    # Confirmation is reply-gated and explicitly held back until the user replies.
    assert "do not call `scheduled_generator_create`" in lower
    assert "确认创建" in prompt
    # The 409 re-confirmation path is taught.
    assert "requiresconfirmation" in lower
