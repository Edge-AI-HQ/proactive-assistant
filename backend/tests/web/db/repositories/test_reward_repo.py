from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest
from pinai_db.rls import user_scoped_tx
from pinai_reward_dashboard.reward import RewardRepository


def _cards() -> list[dict]:
    return [
        {
            "id": "run_reward_a_card_00",
            "intentKey": "work:handoff",
            "goalBasket": "work",
            "title": "Send the handoff",
            "summary": "Draft the handoff before the meeting.",
            "whyNow": "The meeting is today.",
            "sources": ["signal id=sig_1"],
        },
        {
            "id": "run_reward_a_card_01",
            "intentKey": "health:sleep",
            "goalBasket": "health",
            "title": "Protect sleep",
            "summary": "Move the late workout.",
            "whyNow": "Calendar shows a late workout.",
            "sources": ["memory id=mem_1"],
        },
    ]


async def _insert_run(conn, user_id: int, run_id: str, cards: list[dict]) -> None:
    await conn.execute(
        """
        INSERT INTO pai_pipeline_runs
          (user_id, id, run_id, status, total_iterations, final_cards, trigger,
           started_at, completed_at)
        VALUES (%s, %s, %s, 'completed', 1, %s::jsonb, 'manual', %s, %s)
        """,
        (
            user_id,
            run_id,
            run_id,
            json.dumps(cards),
            # 相对时间:写死日历日期会在它滑出 metrics(days=30) 窗口那天让
            # 全仓 CI 集体变红(2026-06-12 实爆过)。
            datetime.now(UTC) - timedelta(days=1),
            datetime.now(UTC) - timedelta(days=1, minutes=-1),
        ),
    )
    for card in cards:
        await conn.execute(
            """
            INSERT INTO pai_card_evaluations
              (user_id, card_id, run_id, intent_key, basket, dim_relevance,
               dim_actionability, dim_why_now, dim_novelty, dim_decision_compress,
               overall, pass, evaluator, feedback_text, evaluated_at)
            VALUES (%s, %s, %s, %s, %s, 7, 7, 7, 7, 7, 7, true, 'self', 'solid', %s)
            """,
            (
                user_id,
                card["id"],
                run_id,
                card["intentKey"],
                card["goalBasket"],
                datetime(2026, 5, 13, 8, 2, tzinfo=UTC),
            ),
        )


@pytest.mark.asyncio
async def test_reward_fold_rules_score_open_zero(pool, user_ids):
    user_a, _ = user_ids
    cards = _cards()
    async with user_scoped_tx(pool, user_a) as conn:
        repo = RewardRepository(user_a, conn)
        await _insert_run(conn, user_a, "run_reward_a", cards)

        before = await repo.get_run_detail("run_reward_a")
        assert before is not None
        assert before["cards"][0]["rewards"]["userReward"] == 0.0

        await repo.create_reward_event(
            card_id=cards[0]["id"],
            source="user",
            event_type="card_open",
        )
        opened = await repo.get_card_detail(cards[0]["id"])
        assert opened is not None
        assert opened["rewards"]["userReward"] == 1.0

        await repo.create_reward_event(
            card_id=cards[0]["id"],
            source="user",
            event_type="user_score",
            score=8,
        )
        await repo.create_reward_event(
            card_id=cards[1]["id"],
            source="reviewer",
            event_type="reviewer_score",
            score=6,
        )
        with pytest.raises(ValueError, match="between 1 and 10"):
            await repo.create_reward_event(
                card_id=cards[1]["id"],
                source="reviewer",
                event_type="reviewer_score",
                score=0,
            )

        summaries = await repo.list_runs()
        aha_summaries = await repo.list_runs(quality="aha")
        dead_summaries = await repo.list_runs(quality="dead")
        reviewer_aha_summaries = await repo.list_runs(quality="reviewer_aha")
    assert len(summaries) == 1
    run = summaries[0]
    assert run["avgUserReward"] == 4.0
    assert run["deadCardRate"] == 0.5
    assert run["ahaRate"] == 0.5
    assert run["avgReviewerReward"] == 6.0
    assert run["reviewedCount"] == 1
    assert [r["runId"] for r in aha_summaries] == ["run_reward_a"]
    assert [r["runId"] for r in dead_summaries] == ["run_reward_a"]
    assert reviewer_aha_summaries == []


@pytest.mark.asyncio
async def test_casebook_upsert_preserves_snapshot(pool, user_ids):
    user_a, _ = user_ids
    cards = _cards()
    async with user_scoped_tx(pool, user_a) as conn:
        repo = RewardRepository(user_a, conn)
        await _insert_run(conn, user_a, "run_reward_case", cards)
        await repo.create_reward_event(
            card_id=cards[0]["id"],
            source="reviewer",
            event_type="reviewer_score",
            score=8,
        )
        first = await repo.upsert_casebook(
            card_id=cards[0]["id"],
            label="great",
            reviewer_note="this is sharp",
        )
        second = await repo.upsert_casebook(
            card_id=cards[0]["id"],
            label="surprising",
            reviewer_note="same snapshot, better label",
        )
        cases = await repo.list_casebook(
            label="surprising",
            basket="work",
            intent="handoff",
            min_evaluator_gap=1,
            since=datetime(2026, 5, 13, 0, 0, tzinfo=UTC),
        )
        miss = await repo.list_casebook(basket="health")
        total = await repo.count_casebook(label="surprising")

    assert first["snapshot"] == second["snapshot"]
    assert second["label"] == "surprising"
    assert second["scoreSnapshot"] == 8.0
    assert second["reviewerNote"] == "same snapshot, better label"
    assert len(cases) == 1
    assert cases[0]["snapshot"]["card"]["id"] == cards[0]["id"]
    assert total == 1
    assert miss == []


@pytest.mark.asyncio
async def test_reward_repo_is_user_scoped(pool, user_ids):
    user_a, user_b = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await _insert_run(conn, user_a, "run_reward_user_a", _cards())

    async with user_scoped_tx(pool, user_b) as conn:
        repo_b = RewardRepository(user_b, conn)
        detail = await repo_b.get_card_detail("run_reward_a_card_00")
        summaries = await repo_b.list_runs()

    assert detail is None
    assert summaries == []


@pytest.mark.asyncio
async def test_reward_repo_ignores_json_null_final_cards(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await conn.execute(
            """
            INSERT INTO pai_pipeline_runs
              (user_id, id, run_id, status, total_iterations, final_cards, trigger,
               started_at, completed_at)
            VALUES (%s, 'run_reward_json_null', 'run_reward_json_null', 'completed',
                    1, 'null'::jsonb, 'manual', %s, %s)
            """,
            (
                user_a,
                datetime(2026, 5, 13, 8, 0, tzinfo=UTC),
                datetime(2026, 5, 13, 8, 1, tzinfo=UTC),
            ),
        )
        await _insert_run(conn, user_a, "run_reward_array_cards", _cards())

        repo = RewardRepository(user_a, conn)
        summaries = await repo.list_runs()
        metrics = await repo.metrics(days=30)

    assert [r["runId"] for r in summaries] == ["run_reward_array_cards"]
    assert sum(point["cardCount"] for point in metrics["series"]) == 2
