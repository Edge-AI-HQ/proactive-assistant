"""persist_generator_run — pipeline_runs 落库 + L1 agent_decision 写回 + 幂等。

Pattern hits 持久化随 pattern matcher 一起退役;evaluations 写口保留
(agentic generator 恒发空,legacy payload 回放仍有效)。
"""

from __future__ import annotations

import pytest
from pinai_api.domains.generation.pipeline_persistence import (
    persist_generator_run,
    persist_pipeline_run_strict,
)
from pinai_contracts.api_models import CardEvaluation
from pinai_db.rls import service_tx, user_scoped_tx


def _card(card_id: str, *, title: str = "smoke card") -> dict:
    return {
        "id": card_id,
        "intentKey": f"intent-{card_id}",
        "goalBasket": "work",
        "title": title,
        "whyNow": "collides with tomorrow's onsite",
        "summary": "summary",
        "sources": [
            "gmail event id=evt_e9, title=Diana rescheduled",
            "googlecalendar event id=evt_m1, title=Diana sync",
        ],
    }


async def _cleanup(pool, user_id: int, run_id: str, card_ids: list[str]) -> None:
    async with service_tx(pool) as conn:
        for card_id in card_ids:
            await conn.execute(
                "DELETE FROM pai_events WHERE user_id = %s AND dedupe_key = %s",
                (user_id, f"card_decision:{card_id}"),
            )
            await conn.execute(
                "DELETE FROM pai_card_evaluations WHERE user_id = %s AND card_id = %s",
                (user_id, card_id),
            )
        await conn.execute(
            "DELETE FROM pai_pipeline_runs WHERE user_id = %s AND id = %s",
            (user_id, run_id),
        )


@pytest.mark.asyncio
async def test_persist_appends_card_decision_events_and_is_idempotent(pool, user_ids) -> None:
    """每张出卡 → 一条 L1 agent_decision(structured.kind=proactive_proposal,
    related_event_ids 从 sources 引文解析);重试(retry path)靠 dedupe_key
    幂等,不产生第二条。"""
    user_a, _ = user_ids
    run_id = "smoke_run_001"
    card_id = "smoke_card_001"
    payload = {"runId": run_id, "cards": [_card(card_id)]}

    await persist_generator_run(pool, user_id=user_a, payload=payload, trigger="test")
    # Second persist (retry path) — must not raise, must not duplicate.
    await persist_generator_run(pool, user_id=user_a, payload=payload, trigger="test")

    try:
        async with user_scoped_tx(pool, user_a) as conn, conn.cursor() as cur:
            await cur.execute(
                "SELECT status FROM pai_pipeline_runs WHERE user_id = %s AND id = %s",
                (user_a, run_id),
            )
            run_row = await cur.fetchone()
            await cur.execute(
                "SELECT source, event_type, title, body, structured "
                "FROM pai_events WHERE user_id = %s AND dedupe_key = %s",
                (user_a, f"card_decision:{card_id}"),
            )
            decision_rows = await cur.fetchall()

        assert run_row is not None and run_row["status"] == "completed"
        assert len(decision_rows) == 1
        decision = decision_rows[0]
        assert decision["source"] == "agent_action"
        assert decision["event_type"] == "agent_decision"
        assert decision["title"] == "Card proposed: smoke card"
        assert decision["body"] == "collides with tomorrow's onsite"
        structured = decision["structured"]
        assert structured["kind"] == "proactive_proposal"
        assert structured["card_id"] == card_id
        assert structured["run_id"] == run_id
        assert structured["related_event_ids"] == ["evt_e9", "evt_m1"]
    finally:
        await _cleanup(pool, user_a, run_id, [card_id])


@pytest.mark.asyncio
async def test_persist_zero_cards_writes_run_row_but_no_events(pool, user_ids) -> None:
    """静默 run(0 卡)落 run 行(前端轮询要 completed),但 L1 零写入。"""
    user_a, _ = user_ids
    run_id = "smoke_run_002"

    await persist_generator_run(
        pool, user_id=user_a, payload={"runId": run_id, "cards": []}, trigger="test"
    )

    try:
        async with user_scoped_tx(pool, user_a) as conn, conn.cursor() as cur:
            await cur.execute(
                "SELECT status FROM pai_pipeline_runs WHERE user_id = %s AND id = %s",
                (user_a, run_id),
            )
            run_row = await cur.fetchone()
            await cur.execute(
                "SELECT count(*)::int AS n FROM pai_events "
                "WHERE user_id = %s AND source = 'agent_action' "
                "AND structured->>'run_id' = %s",
                (user_a, run_id),
            )
            n_row = await cur.fetchone()

        assert run_row is not None and run_row["status"] == "completed"
        assert n_row is not None and n_row["n"] == 0
    finally:
        await _cleanup(pool, user_a, run_id, [])


@pytest.mark.asyncio
async def test_persist_reminder_skips_decision_events(pool, user_ids) -> None:
    """reminder.card 是用户自设 nudge,不是 AI 提议 — record_decisions=False
    不写 agent_decision。"""
    user_a, _ = user_ids
    run_id = "smoke_run_003"
    card_id = "smoke_card_003"

    await persist_pipeline_run_strict(
        pool,
        user_id=user_a,
        payload={"runId": run_id, "cards": [_card(card_id, title="drink water")]},
        trigger="reminder",
        record_decisions=False,
    )

    try:
        async with user_scoped_tx(pool, user_a) as conn, conn.cursor() as cur:
            await cur.execute(
                "SELECT count(*)::int AS n FROM pai_events WHERE user_id = %s AND dedupe_key = %s",
                (user_a, f"card_decision:{card_id}"),
            )
            row = await cur.fetchone()
        assert row is not None and row["n"] == 0
    finally:
        await _cleanup(pool, user_a, run_id, [card_id])


@pytest.mark.asyncio
async def test_persist_evaluations_fills_dims_from_flat_camelcase(pool, user_ids) -> None:
    """evaluations 写口保留(legacy payload 回放):五维 camelCase 平铺 →
    dim_* 列。agentic generator 主路径恒发空 evaluations,此路径 no-op。"""
    user_a, _ = user_ids
    run_id = "smoke_run_004"
    card_id = "smoke_card_004"
    evaluation = CardEvaluation.model_validate(
        {
            "intentKey": "smoke-flat",
            "relevance": 7.5,
            "actionability": 6.5,
            "whyNowClarity": 8.0,
            "novelty": 5.5,
            "decisionCompression": 6.0,
            "overall": 7.1,
            "pass": True,
            "feedback": "flat shape audit note",
        }
    ).model_dump(by_alias=True)
    evaluation["cardId"] = card_id
    payload = {
        "runId": run_id,
        "cards": [_card(card_id, title="flat dims card")],
        "evaluations": [evaluation],
    }

    await persist_generator_run(pool, user_id=user_a, payload=payload, trigger="test")

    try:
        async with user_scoped_tx(pool, user_a) as conn, conn.cursor() as cur:
            await cur.execute(
                "SELECT dim_relevance, dim_actionability, dim_why_now, dim_novelty, "
                "dim_decision_compress, overall, pass, feedback_text "
                "FROM pai_card_evaluations WHERE user_id = %s AND card_id = %s",
                (user_a, card_id),
            )
            row = await cur.fetchone()

        assert row is not None
        assert row["dim_relevance"] == pytest.approx(7.5)
        assert row["dim_actionability"] == pytest.approx(6.5)
        assert row["dim_why_now"] == pytest.approx(8.0)
        assert row["dim_novelty"] == pytest.approx(5.5)
        assert row["dim_decision_compress"] == pytest.approx(6.0)
        assert row["overall"] == pytest.approx(7.1)
        assert row["pass"] is True
        assert row["feedback_text"] == "flat shape audit note"
    finally:
        await _cleanup(pool, user_a, run_id, [card_id])
