"""build_tick_context — 两段式 log + token 预算 + 就地 reset(design §4.1–4.2)。

核心不变量:**确定性**——同 (anchor, 事件集) 两次构建字节一致(满块是 cache
命中的前提);历史段截断只依赖封闭集(anchor 前到达不再变);超预算就地 reset
单步收敛(reset 后 ≤ INITIAL < LOG budget)。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from agent_engine.agents.generation_context import (
    BLOCK_SIZE_EVENTS,
    INITIAL_LOG_TOKEN_BUDGET,
    build_tick_context,
    chunk_log,
    default_anchor,
    truncate_history,
)

NOW = datetime(2026, 7, 4, 14, 37, tzinfo=UTC)
ANCHOR = NOW - timedelta(days=1)


def _arrival(i: int, **overrides) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": f"evt_{i:04d}",
        "eventType": "communication",
        "source": "composio",
        "occurredAt": (ANCHOR + timedelta(minutes=i)).isoformat(),
        "title": f"event {i}",
        "body": "b" * 500,
        "structured": {"toolkit": "gmail", "payload_blob": "x" * 5000},
    }
    base.update(overrides)
    return base


def _fake_get(history: list[dict], growth: list[dict], upcoming: list[dict]):
    """三查询路由:历史段(recordedSince+newestFirst)/增量段(recordedSince)/
    未来视图(occurred_at 轴)。历史段模拟 repo 语义:最近 limit 条、到达序输出。"""
    calls: list[dict[str, Any]] = []

    async def fake(path: str, **params: Any) -> dict[str, Any]:
        calls.append({"path": path, "params": params})
        assert path == "/api/agent/events/search"
        if "recordedSince" in params and params.get("newestFirst"):
            limit = int(params.get("arrivalsLimit") or 2000)
            return {"items": history[-limit:]}
        if "recordedSince" in params:
            return {"items": growth}
        return {"items": upcoming}

    return fake, calls


@pytest.mark.asyncio
async def test_rebuild_is_byte_identical(monkeypatch):
    """同 (anchor, 事件集) 两次构建 → 满块文本逐字节一致(cache 命中前提)。"""
    from agent_engine.agents import generation_context

    history = [_arrival(i) for i in range(BLOCK_SIZE_EVENTS * 2)]
    growth = [_arrival(500 + i) for i in range(7)]
    fake, _ = _fake_get(history, growth, [])
    monkeypatch.setattr(generation_context.http_client, "get", fake)

    first = await build_tick_context(anchor=ANCHOR, now=NOW)
    second = await build_tick_context(anchor=ANCHOR, now=NOW)

    assert first["log_blocks"] == second["log_blocks"]
    assert first["tail_events"] == second["tail_events"]
    assert len(first["log_blocks"]) == 2
    assert len(first["tail_events"]) == 7
    assert first["effective_anchor"] == ANCHOR  # 预算内,不 reset


@pytest.mark.asyncio
async def test_growth_appends_without_touching_history_blocks(monkeypatch):
    """增量段只影响尾巴/新块——历史满块字节不变(append-only 语义)。"""
    from agent_engine.agents import generation_context

    history = [_arrival(i) for i in range(BLOCK_SIZE_EVENTS)]
    fake, _ = _fake_get(history, [_arrival(500)] * 3, [])
    monkeypatch.setattr(generation_context.http_client, "get", fake)
    before = await build_tick_context(anchor=ANCHOR, now=NOW)

    fake2, _ = _fake_get(history, [_arrival(500 + i) for i in range(8)], [])
    monkeypatch.setattr(generation_context.http_client, "get", fake2)
    after = await build_tick_context(anchor=ANCHOR, now=NOW)

    # 历史满块前缀完全一致;尾巴 3 → 8。
    assert after["log_blocks"][: len(before["log_blocks"])] == before["log_blocks"]
    assert len(after["tail_events"]) == 8


def test_truncate_history_keeps_newest_suffix_within_budget():
    """截断保留预算内的最新后缀;首个溢出者不含;确定性(两次同结果)。"""
    events = [_arrival(i) for i in range(400)]
    projected = [
        {k: v for k, v in e.items() if k != "structured"} | {"toolkit": "gmail"} for e in events
    ]
    kept = truncate_history(projected)
    kept_again = truncate_history(projected)

    assert kept == kept_again  # 确定性
    assert 0 < len(kept) < len(projected)  # 真截了
    assert kept[-1]["id"] == projected[-1]["id"]  # 最新的保留
    assert kept[0]["id"] != projected[0]["id"]  # 最老的被截
    # 预算内小集合:原样保留
    small = projected[:3]
    assert truncate_history(small) == small
    assert truncate_history([]) == []


@pytest.mark.asyncio
async def test_low_density_history_kept_whole(monkeypatch):
    """低密度用户:3 天窗口内事件少于预算 → 全保留(时间界先命中)。"""
    from agent_engine.agents import generation_context

    history = [_arrival(i) for i in range(10)]
    fake, calls = _fake_get(history, [], [])
    monkeypatch.setattr(generation_context.http_client, "get", fake)

    ctx = await build_tick_context(anchor=ANCHOR, now=NOW)
    assert ctx["stats"]["history"] == 10
    # 历史段查询用 newestFirst + anchor 为右界(时间窗只到 anchor)
    hist_call = next(c for c in calls if c["params"].get("newestFirst"))
    assert hist_call["params"]["recordedUntil"] == ANCHOR.isoformat()


@pytest.mark.asyncio
async def test_over_budget_triggers_in_place_reset(monkeypatch):
    """log 超 LOG_TOKEN_BUDGET → 就地 reset:effective_anchor=now,重建后
    log ≤ INITIAL 预算(单步收敛),历史段查询第二次打到 (now-3d, now]。"""
    from agent_engine.agents import generation_context

    # 1500 条 × ~200 token ≈ 30 万 token 的增量洪峰(backfill 场景)
    history = [_arrival(i) for i in range(100)]
    flood = [_arrival(2000 + i) for i in range(1500)]

    calls: list[dict[str, Any]] = []

    async def fake(path: str, **params: Any) -> dict[str, Any]:
        calls.append({"path": path, "params": params})
        if "recordedSince" in params and params.get("newestFirst"):
            # reset 前:历史段 = anchor 为右界;reset 后:now 为右界(含洪峰)
            if params["recordedUntil"] == ANCHOR.isoformat():
                return {"items": history}
            return {"items": (history + flood)[-int(params["arrivalsLimit"]) :]}
        if "recordedSince" in params:
            # 半开区间 (since, until]:since == until 必空(reset 后的增量段)
            if params["recordedSince"] == params["recordedUntil"]:
                return {"items": []}
            return {"items": flood}
        return {"items": []}

    monkeypatch.setattr(generation_context.http_client, "get", fake)
    ctx = await build_tick_context(anchor=ANCHOR, now=NOW)

    assert ctx["stats"]["was_reset"] is True
    assert ctx["effective_anchor"] == NOW
    assert ctx["stats"]["log_tokens_estimate"] <= INITIAL_LOG_TOKEN_BUDGET
    assert ctx["stats"]["growth"] == 0  # reset 后增量段空
    # 洪峰的最新部分保留在 log 里(重截取"最近优先")
    reset_hist_calls = [
        c
        for c in calls
        if c["params"].get("newestFirst") and c["params"]["recordedUntil"] == NOW.isoformat()
    ]
    assert len(reset_hist_calls) == 1


def test_chunk_log_boundaries():
    events = [{"id": f"e{i}"} for i in range(BLOCK_SIZE_EVENTS)]
    blocks, tail = chunk_log(events)
    assert len(blocks) == 1 and tail == []  # 恰好一满块

    blocks, tail = chunk_log(events[:-1])
    assert blocks == [] and len(tail) == BLOCK_SIZE_EVENTS - 1  # 不满不封块

    blocks, tail = chunk_log([])
    assert blocks == [] and tail == []


@pytest.mark.asyncio
async def test_log_projection_narrow_with_supersedes_and_decisions(monkeypatch):
    """投影:structured 全量不进 log(Daytona 教训)、supersedes 指针保留、
    agent_decision 带去重锚(kind/cardId/relatedEventIds)。"""
    from agent_engine.agents import generation_context

    growth = [
        _arrival(1),
        _arrival(2, supersedesId="evt_0001"),
        _arrival(
            3,
            eventType="agent_decision",
            source="agent_action",
            structured={
                "kind": "proactive_proposal",
                "card_id": "run_x_card_00",
                "related_event_ids": ["evt_0001"],
            },
        ),
    ]
    fake, _ = _fake_get([], growth, [])
    monkeypatch.setattr(generation_context.http_client, "get", fake)

    ctx = await build_tick_context(anchor=ANCHOR, now=NOW)
    tail = ctx["tail_events"]

    assert "structured" not in tail[0]
    assert len(tail[0]["body"]) <= 280
    assert tail[0]["toolkit"] == "gmail"
    assert tail[1]["supersedes"] == "evt_0001"
    decision = tail[2]
    assert decision["kind"] == "proactive_proposal"
    assert decision["cardId"] == "run_x_card_00"
    assert decision["relatedEventIds"] == ["evt_0001"]


@pytest.mark.asyncio
async def test_future_view_sorted_soonest_first_one_line(monkeypatch):
    from agent_engine.agents import generation_context

    upcoming = [
        {
            "id": "evt_far",
            "eventType": "meeting",
            "title": "Onsite",
            "occurredAt": (NOW + timedelta(days=2)).isoformat(),
        },
        {
            "id": "evt_near",
            "eventType": "meeting",
            "title": "Diana sync",
            "occurredAt": (NOW + timedelta(hours=20)).isoformat(),
            "endAt": (NOW + timedelta(hours=21)).isoformat(),
        },
    ]
    fake, calls = _fake_get([], [], upcoming)
    monkeypatch.setattr(generation_context.http_client, "get", fake)

    ctx = await build_tick_context(anchor=ANCHOR, now=NOW)

    assert len(ctx["future_view"]) == 2
    assert "evt_near" in ctx["future_view"][0]  # soonest first
    assert "→" in ctx["future_view"][0]  # 区间渲染(endAt)
    assert "evt_far" in ctx["future_view"][1]
    # 视图查询走 occurred_at 轴 + active(supersede 已消解)。
    view_call = next(c for c in calls if "recordedSince" not in c["params"])
    assert view_call["params"]["status"] == "active"


@pytest.mark.asyncio
async def test_survives_search_failure(monkeypatch):
    from agent_engine.agents import generation_context

    async def fake(path: str, **params: Any):
        raise ConnectionError("api down")

    monkeypatch.setattr(generation_context.http_client, "get", fake)
    ctx = await build_tick_context(anchor=ANCHOR, now=NOW)
    assert ctx["log_blocks"] == []
    assert ctx["tail_events"] == []
    assert ctx["future_view"] == []
    assert ctx["effective_anchor"] == ANCHOR


def test_default_anchor_is_now():
    now = datetime(2026, 7, 4, 9, 0, tzinfo=UTC)
    assert default_anchor(now) == now
