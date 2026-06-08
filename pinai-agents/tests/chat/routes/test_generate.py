from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from pinai_agents.chat.transport.routes import generate as generate_route


@pytest.mark.asyncio
async def test_generate_route_passes_generation_request_to_generator(monkeypatch):
    captured: dict[str, Any] = {}

    async def fake_run_generator(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(reasoning=None, batch_feedback=None)

    monkeypatch.setattr(generate_route, "_extract_bearer", lambda authorization: "raw-jwt")
    monkeypatch.setattr(
        generate_route,
        "_verify_principal",
        lambda token: SimpleNamespace(user_id=1, virtual_key="sk-test"),
    )
    monkeypatch.setattr(generate_route, "run_generator", fake_run_generator)
    monkeypatch.setattr(
        generate_route,
        "_serialize_passing_cards",
        lambda parsed, *, run_id, max_cards: ([{"id": "card_1"}], []),
    )

    generation_request = {
        "source_kind": "scheduled",
        "source_label": "AI 新闻卡片",
        "scheduled_task_id": "sched.gen.abc",
        "confirmed_brief": {"topic": "AI 新闻"},
        "parsed_intent": {"frequency": "daily"},
    }
    req = generate_route.GenerateRequest(
        cards_to_generate=4,
        output_language="zh-Hans",
        run_id="run_sched",
        generation_request=generation_request,
    )

    await generate_route.generate(req, authorization="Bearer token")

    assert captured["generation_request"] == generation_request
    assert captured["run_id"] == "run_sched"
