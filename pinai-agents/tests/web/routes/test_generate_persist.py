"""persist_generator_run — pattern hits + idempotency under retry."""

from __future__ import annotations

import pytest

from pinai_agents.web.db.rls import service_tx, user_scoped_tx
from pinai_agents.web.routes.ui.generate import persist_generator_run


@pytest.mark.asyncio
async def test_persist_records_pattern_hits_and_is_idempotent(pool, user_ids) -> None:
    user_a, _ = user_ids
    run_id = "smoke_run_001"
    card_id = "smoke_card_001"
    payload = {
        "runId": run_id,
        "cards": [
            {
                "id": card_id,
                "intentKey": "smoke-intent",
                "goalBasket": "work",
                "title": "smoke card",
                "whyNow": "now",
                "summary": "summary",
                "sources": ["signal id=sig_smoke"],
            },
        ],
        "evaluations": [
            {
                "cardId": card_id,
                "intentKey": "smoke-intent",
                "dimensions": {
                    "relevance": 7, "actionability": 7, "whyNowClarity": 7,
                    "novelty": 7, "decisionCompression": 7,
                },
                "overall": 7,
                "pass": True,
                "patternId": "routine_anchor_detected",
                "patternGroundingOk": True,
            },
        ],
    }
    matched = [
        {
            "patternId": "routine_anchor_detected",
            "category": "routine_observation",
            "intent": "routine_assistance",
            "abstract": "abc",
            "evidence": {"trajectory_similarity_gte": {"value": 0.9}},
            "baseHitRate": 0.5,
            "userFitScore": None,
            "combinedScore": 0.5,
            "subtype": "commute_route",
        },
    ]

    # First persist
    await persist_generator_run(
        pool, user_id=user_a, payload=payload, trigger="test",
        matched_patterns=matched,
    )
    # Second persist (retry path) — must not raise
    await persist_generator_run(
        pool, user_id=user_a, payload=payload, trigger="test",
        matched_patterns=matched,
    )

    async with user_scoped_tx(pool, user_a) as conn, conn.cursor() as cur:
        await cur.execute(
            "SELECT status FROM pai_pipeline_runs WHERE user_id = %s AND id = %s",
            (user_a, run_id),
        )
        run_row = await cur.fetchone()
        await cur.execute(
            "SELECT count(*)::int AS n FROM pai_card_evaluations "
            "WHERE user_id = %s AND card_id = %s",
            (user_a, card_id),
        )
        eval_row = await cur.fetchone()
        await cur.execute(
            "SELECT subtype, pattern_grounding_ok, combined_score "
            "FROM pai_card_pattern_hits "
            "WHERE user_id = %s AND card_id = %s",
            (user_a, card_id),
        )
        hit_row = await cur.fetchone()

    assert run_row is not None and run_row["status"] == "completed"
    assert eval_row is not None and eval_row["n"] == 1
    assert hit_row is not None
    assert hit_row["subtype"] == "commute_route"
    assert hit_row["pattern_grounding_ok"] is True
    assert hit_row["combined_score"] == pytest.approx(0.5)

    # Cleanup
    async with service_tx(pool) as conn:
        await conn.execute(
            "DELETE FROM pai_card_pattern_hits WHERE user_id = %s AND card_id = %s",
            (user_a, card_id),
        )
        await conn.execute(
            "DELETE FROM pai_card_evaluations WHERE user_id = %s AND card_id = %s",
            (user_a, card_id),
        )
        await conn.execute(
            "DELETE FROM pai_pipeline_runs WHERE user_id = %s AND id = %s",
            (user_a, run_id),
        )


@pytest.mark.asyncio
async def test_persist_tolerates_unknown_pattern_id(pool, user_ids) -> None:
    """If the agent claims a pattern_id that doesn't exist, the pipeline_runs
    + evaluations rows still land — the pattern hit silently drops."""
    user_a, _ = user_ids
    run_id = "smoke_run_002"
    card_id = "smoke_card_002"
    payload = {
        "runId": run_id,
        "cards": [{
            "id": card_id, "intentKey": "smoke", "goalBasket": "work",
            "title": "t", "whyNow": "n", "summary": "s",
            "sources": ["signal id=sig"],
        }],
        "evaluations": [{
            "cardId": card_id, "intentKey": "smoke",
            "dimensions": {"relevance": 5, "actionability": 5, "whyNowClarity": 5, "novelty": 5, "decisionCompression": 5},
            "overall": 5, "pass": True,
            "patternId": "__never_seen_pattern__",
        }],
    }

    await persist_generator_run(
        pool, user_id=user_a, payload=payload, trigger="test",
        matched_patterns=None,
    )

    async with user_scoped_tx(pool, user_a) as conn, conn.cursor() as cur:
        await cur.execute(
            "SELECT 1 FROM pai_pipeline_runs WHERE user_id = %s AND id = %s",
            (user_a, run_id),
        )
        assert await cur.fetchone() is not None
        await cur.execute(
            "SELECT count(*)::int AS n FROM pai_card_pattern_hits "
            "WHERE user_id = %s AND card_id = %s",
            (user_a, card_id),
        )
        row = await cur.fetchone()
        assert row is not None and row["n"] == 0

    async with service_tx(pool) as conn:
        await conn.execute(
            "DELETE FROM pai_card_evaluations WHERE user_id = %s AND card_id = %s",
            (user_a, card_id),
        )
        await conn.execute(
            "DELETE FROM pai_pipeline_runs WHERE user_id = %s AND id = %s",
            (user_a, run_id),
        )
