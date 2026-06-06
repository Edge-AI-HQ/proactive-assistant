"""Proactive agent: prompt composition + notify_user tool wiring.

compose_proactive_prompt is the correctness-critical pure logic (a wrong
injection = the agent ignores the user's preferences/goals). notify_user is
the only user-facing channel — verify it posts to the emit endpoint.
"""

from __future__ import annotations

import pytest

from pinai_agents.chat.agents.proactive import compose_proactive_prompt
from pinai_agents.chat.harness.ctx import run_context
from pinai_agents.chat.tools import http_client
from pinai_agents.chat.tools.direct.proactive import notify_user


def test_prompt_injects_profile_and_goals():
    prompt = compose_proactive_prompt(
        profile={
            "display_name": "Bo",
            "timezone": "Asia/Shanghai",
            "summary": "engineer building proactive AI",
            "preferences": {"verbosity": "low"},
            "constraints": {"no_email_after": "22:00"},
        },
        goals=[{"key": "ship", "title": "Ship proactive agent", "summary": "by June"}],
    )
    assert "<user_profile>" in prompt
    assert "name: Bo" in prompt
    assert "timezone: Asia/Shanghai" in prompt
    assert "verbosity: low" in prompt
    assert "no_email_after: 22:00" in prompt
    assert "<user_goals>" in prompt
    assert "Ship proactive agent" in prompt


def test_prompt_omits_empty_sections():
    prompt = compose_proactive_prompt(profile=None, goals=[])
    assert "<user_profile>" not in prompt
    assert "<user_goals>" not in prompt
    # Base behavioral contract is always present.
    assert "<default_to_silence_on_heartbeats>" in prompt
    assert "notify_user" in prompt


def test_prompt_input_kind_splits_reply_vs_outreach():
    """The per-turn <this_turn> directive is what makes a user message get an
    inline reply (no notification) while a heartbeat beat stays silent unless
    notify_user is warranted. A wrong directive = either silent replies or
    notification spam on every chat turn."""
    user_turn = compose_proactive_prompt(profile=None, goals=None, input_kind="user")
    tick_turn = compose_proactive_prompt(profile=None, goals=None, input_kind="tick")

    assert "<this_turn>" in user_turn
    assert "DIRECT MESSAGE" in user_turn
    assert "Do NOT call notify_user to reply" in user_turn

    assert "<this_turn>" in tick_turn
    assert "HEARTBEAT beat" in tick_turn
    assert "Default to silence" in tick_turn

    # The mode directive is the ONLY part that differs between the two turns,
    # so the cached prefix (base + profile/goals) stays stable turn-to-turn.
    assert user_turn.rsplit("<this_turn>", 1)[0] == tick_turn.rsplit("<this_turn>", 1)[0]


def test_prompt_omits_blank_profile_buckets():
    prompt = compose_proactive_prompt(
        profile={"display_name": "Bo", "preferences": {}, "constraints": {}},
        goals=None,
    )
    assert "name: Bo" in prompt
    assert "preferences:" not in prompt
    assert "constraints:" not in prompt
    assert "<user_goals>" not in prompt


@pytest.mark.asyncio
async def test_notify_user_posts_to_emit(monkeypatch):
    calls: list[dict] = []

    async def fake_post(path, body):
        calls.append({"path": path, "body": body})
        return {"ok": True, "eventId": 1}

    monkeypatch.setattr(http_client, "post", fake_post)
    with run_context(user_id=42, run_id="run_test", run_jwt="jwt", virtual_key="vk"):
        await notify_user.ainvoke({"message": "你的会议 15 分钟后开始"})
    assert len(calls) == 1
    assert calls[0]["path"] == "/api/agent/proactive/emit"
    assert calls[0]["body"] == {"message": "你的会议 15 分钟后开始"}
