"""Phase 3 — per-user pattern fingerprint affects matcher ranking."""

from __future__ import annotations

import pytest

from pinai_agents.web.db.repositories.patterns import PatternsRepository
from pinai_agents.web.db.repositories.user_fingerprint import (
    UserFingerprintRepository,
)
from pinai_agents.web.db.rls import user_scoped_tx
from pinai_agents.web.services.pattern_matcher import match_patterns


@pytest.mark.asyncio
async def test_suppress_after_three_dismisses(pool, user_ids) -> None:
    user_a, _ = user_ids
    pattern_id = "__test_fp_pattern__"
    phase1 = {"open_commitments": [{"id": "c"} for _ in range(8)]}

    async with user_scoped_tx(pool, user_a) as conn:
        await conn.execute(
            """
            INSERT INTO pai_card_patterns
              (id, category, abstract, signals_required, trigger_dsl, intent,
               card_skeleton, specializations, surprise_init, practical_init,
               tier, status, source)
            VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s,
                    %s::jsonb, %s::jsonb, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET trigger_dsl = EXCLUDED.trigger_dsl
            """,
            (
                pattern_id,
                "test",
                "fp test",
                "[]",
                '[{"op": "open_commitment_count_gte", "field": "open_commitments", "min": 5}]',
                "test_intent",
                "{}",
                "[]",
                "m",
                "m",
                "warmup",
                "active",
                "seed",
            ),
        )

        repo = PatternsRepository(user_a, conn)
        fp = UserFingerprintRepository(user_a, conn)

        first = await match_patterns(repo, phase1, fingerprint=fp)
        assert any(m.pattern_id == pattern_id for m in first.matched), (
            "pattern must match before any fingerprint signal"
        )

        # Three dismisses against this pattern → suppress_until set + matcher drops it.
        for _ in range(3):
            await fp.record_dismiss(pattern_ids=[pattern_id])

        after_dismiss = await match_patterns(repo, phase1, fingerprint=fp)
        assert not any(m.pattern_id == pattern_id for m in after_dismiss.matched), (
            "suppressed pattern should drop out of the match list"
        )

        # Cleanup
        await conn.execute(
            "DELETE FROM pai_card_patterns WHERE id = %s",
            (pattern_id,),
        )


@pytest.mark.asyncio
async def test_per_user_isolation(pool, user_ids) -> None:
    """user A's dismiss must NOT affect user B's matcher output."""
    user_a, user_b = user_ids
    pattern_id = "__test_iso_pattern__"
    phase1 = {"open_commitments": [{"id": "c"} for _ in range(8)]}

    async with user_scoped_tx(pool, user_a) as conn_a:
        await conn_a.execute(
            """
            INSERT INTO pai_card_patterns
              (id, category, abstract, signals_required, trigger_dsl, intent,
               card_skeleton, specializations, surprise_init, practical_init,
               tier, status, source)
            VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s,
                    %s::jsonb, %s::jsonb, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET trigger_dsl = EXCLUDED.trigger_dsl
            """,
            (
                pattern_id,
                "test",
                "iso test",
                "[]",
                '[{"op": "open_commitment_count_gte", "field": "open_commitments", "min": 5}]',
                "test_intent",
                "{}",
                "[]",
                "m",
                "m",
                "warmup",
                "active",
                "seed",
            ),
        )
        fp_a = UserFingerprintRepository(user_a, conn_a)
        for _ in range(3):
            await fp_a.record_dismiss(pattern_ids=[pattern_id])

    async with user_scoped_tx(pool, user_b) as conn_b:
        repo_b = PatternsRepository(user_b, conn_b)
        fp_b = UserFingerprintRepository(user_b, conn_b)
        b_result = await match_patterns(repo_b, phase1, fingerprint=fp_b)
        assert any(m.pattern_id == pattern_id for m in b_result.matched), (
            "user B should still match (isolation from user A's suppression)"
        )

    async with user_scoped_tx(pool, user_a) as conn_a2:
        await conn_a2.execute(
            "DELETE FROM pai_card_patterns WHERE id = %s",
            (pattern_id,),
        )
