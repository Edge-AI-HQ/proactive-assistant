from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest
from pinai_api.control import chat_proxy


@pytest.mark.asyncio
async def test_call_generate_forwards_generation_request(monkeypatch):
    captured: dict[str, Any] = {}

    class FakeResponse:
        status_code = 200
        text = ""

        def json(self):
            return {"ok": True}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, *, json, headers):
            captured["url"] = url
            captured["json"] = json
            captured["headers"] = headers
            return FakeResponse()

    monkeypatch.setattr(chat_proxy.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(
        chat_proxy,
        "sign_agent_run_jwt",
        lambda **kwargs: ("run-jwt", kwargs.get("run_id") or "jwt-run"),
    )

    generation_request = {
        "source_kind": "scheduled",
        "source_label": "AI 新闻卡片",
        "scheduled_task_id": "sched.gen.abc",
        "confirmed_brief": {"topic": "AI 新闻"},
        "parsed_intent": {"frequency": "daily"},
    }

    result = await chat_proxy.call_generate(
        user_id=1,
        cards_to_generate=8,
        output_language="zh-Hans",
        virtual_key="sk-test",
        run_id="run_sched",
        anchor=datetime(2026, 6, 8, 0, 0, tzinfo=UTC),
        generation_request=generation_request,
    )

    assert result == {"ok": True}
    assert captured["json"]["generation_request"] == generation_request
    assert captured["json"]["run_id"] == "run_sched"
    assert captured["json"]["anchor"] == "2026-06-08T00:00:00+00:00"
    # Pattern matching retired — the body must not carry matched_patterns.
    assert "matched_patterns" not in captured["json"]
