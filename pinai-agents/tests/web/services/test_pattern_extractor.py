"""Phase 6 — pattern extractor heuristic v0."""

from __future__ import annotations

import json

import pytest

from pinai_agents.web.db.rls import service_tx, user_scoped_tx
from pinai_agents.web.services.pattern_extractor import (
    EXTRACTED_PATTERN_PREFIX,
    run_pattern_extractor,
)


async def _seed_casebook_cluster(
    conn,
    *,
    user_id: int,
    intent_key: str,
    count: int,
) -> list[str]:
    """Drop `count` golden casebook rows + matching evaluations sharing
    the same intent_key. Returns the card_ids so the test can clean up."""
    card_ids: list[str] = []
    for i in range(count):
        run_id = f"extr_run_{intent_key}_{i}"
        card_id = f"extr_card_{intent_key}_{i}"
        card_ids.append(card_id)
        # pipeline run so the FK chain is sound
        await conn.execute(
            """
            INSERT INTO pai_pipeline_runs
              (user_id, id, run_id, status, total_iterations, final_cards, trigger,
               started_at, completed_at)
            VALUES (%s, %s, %s, 'completed', 1, %s::jsonb, 'manual', NOW(), NOW())
            ON CONFLICT (user_id, id) DO NOTHING
            """,
            (user_id, run_id, run_id, json.dumps([{"id": card_id, "intentKey": intent_key}])),
        )
        await conn.execute(
            """
            INSERT INTO pai_card_evaluations
              (user_id, card_id, run_id, intent_key, basket, overall, pass,
               evaluator, evaluated_at)
            VALUES (%s, %s, %s, %s, 'work', 8, true, 'self', NOW())
            ON CONFLICT (user_id, card_id) DO NOTHING
            """,
            (user_id, card_id, run_id, intent_key),
        )
        snapshot = {
            "card": {"id": card_id, "intentKey": intent_key, "goalBasket": "work"},
        }
        await conn.execute(
            """
            INSERT INTO pai_card_casebook
              (user_id, id, run_id, card_id, label, score_snapshot, snapshot,
               created_at, updated_at)
            VALUES (%s, %s, %s, %s, 'great', 8.5, %s::jsonb, NOW(), NOW())
            ON CONFLICT (user_id, card_id) DO NOTHING
            """,
            (
                user_id,
                f"case_{intent_key}_{i}",
                run_id,
                card_id,
                json.dumps(snapshot),
            ),
        )
    return card_ids


async def _cleanup(conn, *, user_id: int, card_ids: list[str], pattern_id: str) -> None:
    if card_ids:
        await conn.execute(
            "DELETE FROM pai_card_casebook WHERE user_id = %s AND card_id = ANY(%s)",
            (user_id, card_ids),
        )
        await conn.execute(
            "DELETE FROM pai_card_evaluations WHERE user_id = %s AND card_id = ANY(%s)",
            (user_id, card_ids),
        )
        run_ids = [f"extr_run_{cid.split('_', 2)[2]}" for cid in card_ids]
        await conn.execute(
            "DELETE FROM pai_pipeline_runs WHERE user_id = %s AND id = ANY(%s)",
            (user_id, run_ids),
        )
    await conn.execute(
        "DELETE FROM pai_card_patterns WHERE id = %s",
        (pattern_id,),
    )


@pytest.mark.asyncio
async def test_extractor_creates_candidate_for_new_intent(pool, user_ids) -> None:
    user_a, _ = user_ids
    intent_key = "test-extr-new-intent"
    expected_pattern_id = f"{EXTRACTED_PATTERN_PREFIX}{intent_key}"
    card_ids: list[str] = []
    try:
        async with user_scoped_tx(pool, user_a) as conn:
            card_ids = await _seed_casebook_cluster(
                conn,
                user_id=user_a,
                intent_key=intent_key,
                count=3,
            )
        async with service_tx(pool) as conn:
            summary = await run_pattern_extractor(
                conn,
                lookback_days=30,
                min_cluster_size=3,
            )
        assert summary["candidates_inserted"] >= 1
        pattern_ids = [c["patternId"] for c in summary["candidates"]]
        assert expected_pattern_id in pattern_ids

        # Pattern is in pending_review and ai_extracted source.
        async with service_tx(pool) as conn, conn.cursor() as cur:
            await cur.execute(
                "SELECT status, source, intent FROM pai_card_patterns WHERE id = %s",
                (expected_pattern_id,),
            )
            row = await cur.fetchone()
            assert row is not None
            assert row["status"] == "pending_review"
            assert row["source"] == "ai_extracted"
            assert row["intent"] == intent_key
    finally:
        async with service_tx(pool) as conn:
            await _cleanup(
                conn,
                user_id=user_a,
                card_ids=card_ids,
                pattern_id=expected_pattern_id,
            )


@pytest.mark.asyncio
async def test_extractor_skips_below_min_cluster(pool, user_ids) -> None:
    user_a, _ = user_ids
    intent_key = "test-extr-tiny"
    expected_pattern_id = f"{EXTRACTED_PATTERN_PREFIX}{intent_key}"
    card_ids: list[str] = []
    try:
        async with user_scoped_tx(pool, user_a) as conn:
            card_ids = await _seed_casebook_cluster(
                conn,
                user_id=user_a,
                intent_key=intent_key,
                count=2,
            )
        async with service_tx(pool) as conn:
            summary = await run_pattern_extractor(
                conn,
                lookback_days=30,
                min_cluster_size=3,
            )
        # No new pattern for this intent.
        async with service_tx(pool) as conn, conn.cursor() as cur:
            await cur.execute(
                "SELECT 1 FROM pai_card_patterns WHERE id = %s",
                (expected_pattern_id,),
            )
            row = await cur.fetchone()
            assert row is None
        # Summary surfaces the cluster but didn't insert it.
        assert summary["golden_cards_seen"] >= 2
    finally:
        async with service_tx(pool) as conn:
            await _cleanup(
                conn,
                user_id=user_a,
                card_ids=card_ids,
                pattern_id=expected_pattern_id,
            )


@pytest.mark.asyncio
async def test_extractor_skips_intent_already_covered(pool, user_ids) -> None:
    """An intent_key that already has an active pattern shouldn't get a
    duplicate candidate."""
    user_a, _ = user_ids
    # Use a real seed pattern intent ("routine_assistance" exists in
    # routine_anchor_detected.intent). Drop 3 golden cards with that intent.
    intent_key = "routine_assistance"
    expected_pattern_id = f"{EXTRACTED_PATTERN_PREFIX}{intent_key}"
    card_ids: list[str] = []
    try:
        async with user_scoped_tx(pool, user_a) as conn:
            card_ids = await _seed_casebook_cluster(
                conn,
                user_id=user_a,
                intent_key=intent_key,
                count=4,
            )
        async with service_tx(pool) as conn:
            summary = await run_pattern_extractor(
                conn,
                lookback_days=30,
                min_cluster_size=3,
            )
        # Even though cluster size meets threshold, the intent already has
        # active patterns → no candidate inserted.
        assert all(c["intentKey"] != intent_key for c in summary["candidates"])
        async with service_tx(pool) as conn, conn.cursor() as cur:
            await cur.execute(
                "SELECT 1 FROM pai_card_patterns WHERE id = %s",
                (expected_pattern_id,),
            )
            assert await cur.fetchone() is None
    finally:
        async with service_tx(pool) as conn:
            await _cleanup(
                conn,
                user_id=user_a,
                card_ids=card_ids,
                pattern_id=expected_pattern_id,
            )
