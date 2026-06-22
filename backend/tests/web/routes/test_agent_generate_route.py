"""Chat-triggered card generation endpoint (/api/agent/generate).

Mirrors test_generate_route.py: drive the route function directly against
a real RLS pool and assert what lands in pai_scheduled_tasks.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from pinai_api.domains.generation import generate_agent as agent_generate_route
from pinai_api.platform.auth.deps import AgentRun
from pinai_db.rls import service_tx


def _run(user_id: int) -> AgentRun:
    return AgentRun(user_id=user_id, run_id="chat-test-run", scope="agent")


def _payload(row: dict[str, Any]) -> dict[str, Any]:
    raw = row["payload"]
    return raw if isinstance(raw, dict) else json.loads(raw)


@pytest.mark.asyncio
async def test_chat_generate_enqueues_generator_chat_with_stripped_focus(pool, user_ids):
    user_a, _ = user_ids
    body = agent_generate_route.AgentGenerateRequest(
        focus="  quantum computing news  ",
        cards_to_generate=2,
        output_language="en",
    )

    result = await agent_generate_route.agent_generate(body=body, run=_run(user_a), pool=pool)

    assert result["ok"] is True
    assert result["status"] == "queued"
    assert result["focus"] == "quantum computing news"  # boundary-stripped

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT kind, payload FROM pai_scheduled_tasks WHERE user_id = %s AND id = %s",
            (user_a, result["taskId"]),
        )
        row = await cur.fetchone()

    assert row is not None
    assert row["kind"] == "generator.chat"
    payload = _payload(row)
    assert payload["focus"] == "quantum computing news"
    assert payload["trigger"] == "chat"
    assert payload["cards_to_generate"] == 2


@pytest.mark.asyncio
async def test_chat_generate_omits_focus_when_blank(pool, user_ids):
    user_a, _ = user_ids
    body = agent_generate_route.AgentGenerateRequest(focus="   ", output_language="en")

    result = await agent_generate_route.agent_generate(body=body, run=_run(user_a), pool=pool)

    assert result["ok"] is True
    assert result["focus"] is None

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT payload FROM pai_scheduled_tasks WHERE user_id = %s AND id = %s",
            (user_a, result["taskId"]),
        )
        row = await cur.fetchone()

    # focus is only written when set — a blank topic is a normal batch.
    assert "focus" not in _payload(row)


@pytest.mark.asyncio
async def test_chat_generate_returns_busy_at_cap_and_enqueues_nothing(pool, user_ids, monkeypatch):
    user_a, _ = user_ids

    async def fake_count(conn, user_id):
        return agent_generate_route._MAX_INFLIGHT_CHAT_GENERATIONS

    monkeypatch.setattr(agent_generate_route, "_count_active_chat_generations", fake_count)

    result = await agent_generate_route.agent_generate(
        body=agent_generate_route.AgentGenerateRequest(output_language="en"),
        run=_run(user_a),
        pool=pool,
    )

    assert result["ok"] is False
    assert result["status"] == "busy"

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT count(*) AS n FROM pai_scheduled_tasks "
            "WHERE user_id = %s AND kind = 'generator.chat'",
            (user_a,),
        )
        row = await cur.fetchone()

    assert row["n"] == 0  # the cap short-circuits before enqueue
