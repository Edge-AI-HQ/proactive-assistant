from __future__ import annotations

import inspect
from types import SimpleNamespace
from typing import Any

import pytest
from agent_engine.config import ChatSettings
from agent_engine.transport.routes import generate as generate_route
from pinai_contracts.api_models import GeneratorOutput


def _empty_output() -> GeneratorOutput:
    return GeneratorOutput(reasoning="r", cards=[], evaluations=[], batch_feedback="")


def _patch_auth(monkeypatch) -> None:
    monkeypatch.setattr(generate_route, "_extract_bearer", lambda authorization: "raw-jwt")
    monkeypatch.setattr(
        generate_route,
        "_verify_principal",
        lambda token: SimpleNamespace(user_id=1, virtual_key="sk-test"),
    )


@pytest.mark.asyncio
async def test_generate_route_passes_generation_request_to_generator(monkeypatch):
    captured: dict[str, Any] = {}

    async def fake_run_generator(**kwargs):
        captured.update(kwargs)
        return _empty_output()

    _patch_auth(monkeypatch)
    monkeypatch.setattr(generate_route, "run_generator", fake_run_generator)

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
    # The agentic generator no longer consumes patterns — the legacy request
    # field must not be forwarded.
    assert "matched_patterns" not in captured


@pytest.mark.asyncio
async def test_generate_route_returns_zero_cards_as_completed(monkeypatch):
    """0 张是正常结果(宁缺毋滥)——status=completed,不是 502。"""

    async def fake_run_generator(**kwargs):
        return _empty_output()

    _patch_auth(monkeypatch)
    monkeypatch.setattr(generate_route, "run_generator", fake_run_generator)

    req = generate_route.GenerateRequest(run_id="run_silent")
    resp = await generate_route.generate(req, authorization="Bearer token")

    assert resp.status == "completed"
    assert resp.cards == []
    assert resp.evaluations == []


@pytest.mark.asyncio
async def test_generate_route_stamps_scheduled_provenance_onto_cards(monkeypatch):
    async def fake_run_generator(**kwargs):
        return _empty_output()

    _patch_auth(monkeypatch)
    monkeypatch.setattr(generate_route, "run_generator", fake_run_generator)
    monkeypatch.setattr(
        generate_route,
        "_serialize_cards",
        lambda parsed, *, run_id, max_cards: [{"id": "card_1"}, {"id": "card_2"}],
    )

    req = generate_route.GenerateRequest(
        cards_to_generate=4,
        output_language="zh-Hans",
        run_id="run_sched",
        generation_request={"source_kind": "scheduled", "source_label": "AI 新闻卡片"},
    )

    resp = await generate_route.generate(req, authorization="Bearer token")

    assert [card["sourceKind"] for card in resp.cards] == ["scheduled", "scheduled"]
    assert all(card["sourceLabel"] == "AI 新闻卡片" for card in resp.cards)


@pytest.mark.asyncio
async def test_generate_route_leaves_cards_unstamped_for_non_scheduled_runs(monkeypatch):
    async def fake_run_generator(**kwargs):
        return _empty_output()

    _patch_auth(monkeypatch)
    monkeypatch.setattr(generate_route, "run_generator", fake_run_generator)
    monkeypatch.setattr(
        generate_route,
        "_serialize_cards",
        lambda parsed, *, run_id, max_cards: [{"id": "card_1"}],
    )

    req = generate_route.GenerateRequest(
        cards_to_generate=4,
        output_language="en",
        run_id="run_manual",
    )

    resp = await generate_route.generate(req, authorization="Bearer token")

    assert "sourceKind" not in resp.cards[0]
    assert "sourceLabel" not in resp.cards[0]


def test_local_date_computes_today_in_user_timezone():
    """ "Today is …" must be the USER-local date: with bare UTC an
    Asia/Shanghai user generating between local 00:00-07:59 gets
    yesterday's date and date-sensitive cards ("today's meetings") drift."""
    from datetime import UTC, datetime

    # 2026-06-11 22:30 UTC = 2026-06-12 06:30 in Asia/Shanghai.
    moment = datetime(2026, 6, 11, 22, 30, tzinfo=UTC)
    assert generate_route._local_date(moment, "Asia/Shanghai") == "2026-06-12"

    # Absent / invalid timezone falls back to the old UTC behavior.
    assert generate_route._local_date(moment, None) == "2026-06-11"
    assert generate_route._local_date(moment, "Not/AZone") == "2026-06-11"


@pytest.mark.asyncio
async def test_generate_route_forwards_anchor(monkeypatch):
    """The api-managed context anchor rides the request into run_generator
    (design §4.2) — the engine rebuilds the cache-stable log from it."""
    from datetime import UTC, datetime

    captured: dict[str, Any] = {}

    async def fake_run_generator(**kwargs):
        captured.update(kwargs)
        return _empty_output()

    _patch_auth(monkeypatch)
    monkeypatch.setattr(generate_route, "run_generator", fake_run_generator)

    anchor = datetime(2026, 7, 3, 8, 0, tzinfo=UTC)
    req = generate_route.GenerateRequest(run_id="run_a", anchor=anchor)
    await generate_route.generate(req, authorization="Bearer token")
    assert captured["anchor"] == anchor


def test_generate_route_caps_agent_runtime_to_configured_budget() -> None:
    source = inspect.getsource(generate_route.generate)

    # 默认预算仍是十分钟;本地可经 env GENERATE_TIMEOUT_SECONDS 放宽
    # (config.generate_timeout_seconds,见 _BaseAppSettings 注释)。
    assert ChatSettings().generate_timeout_seconds == 600.0
    assert "asyncio.timeout(timeout_seconds)" in source
    assert "get_chat_settings().generate_timeout_seconds" in source
