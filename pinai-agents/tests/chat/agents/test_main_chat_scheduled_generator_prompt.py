from __future__ import annotations

from pinai_agents.chat.agents.main_chat import _INSTRUCTIONS
from pinai_agents.chat.tools.direct import ALL_TOOLS, SIDE_EFFECT_TOOL_NAMES

_SCHEDULED_TOOLS = {
    "scheduled_generator_preview",
    "scheduled_generator_create",
    "scheduled_generator_create_once",
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
    assert "end your turn" in lower  # 展示预览后必须结束本轮
    assert "rejected by the server" in lower  # 同轮 create 有服务端硬闸
    assert "确认创建" in prompt
    # The 409 re-confirmation path is taught.
    assert "requiresconfirmation" in lower


def test_main_chat_prompt_routes_one_off_and_recurring():
    prompt = _INSTRUCTIONS
    lower = prompt.lower()
    assert "scheduled_generator_create_once" in lower
    assert "in_minutes" in lower  # 相对时间纪律
    assert 'mode="reminder"' in lower or 'mode="reminder"' in prompt
    assert "do not refuse" in lower  # 不再出现截图式拒绝
    # 既有断言继续成立:
    assert "end your turn" in lower  # 展示预览后必须结束本轮
    assert "rejected by the server" in lower  # 同轮 create 有服务端硬闸
    assert "确认创建" in prompt
    assert "requiresconfirmation" in lower


def test_create_once_tool_registered_and_not_hitl():
    tool_names = {tool.name for tool in ALL_TOOLS}
    assert "scheduled_generator_create_once" in tool_names
    assert "scheduled_generator_create_once" not in SIDE_EFFECT_TOOL_NAMES
