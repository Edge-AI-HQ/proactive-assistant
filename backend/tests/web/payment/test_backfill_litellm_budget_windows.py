from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest

from scripts import backfill_litellm_budget_windows as backfill


def _candidate() -> dict:
    return {
        "id": 42,
        "email": "user@example.com",
        "supabase_user_id": "u-abc",
        "plan_code": "pro",
        "period_end": datetime(2026, 7, 17, 12, 0, tzinfo=UTC),
    }


@pytest.mark.asyncio
async def test_sync_candidate_dry_run_does_not_touch_litellm():
    recompute = AsyncMock(return_value=True)

    result = await backfill._sync_candidate(
        object(),
        _candidate(),
        apply_changes=False,
        recompute=recompute,
    )

    recompute.assert_not_awaited()
    assert result.user_id == 42
    assert result.applied is False
    assert result.updated is False


@pytest.mark.asyncio
async def test_sync_candidate_apply_preserves_existing_spend():
    recompute = AsyncMock(return_value=True)
    conn = object()

    result = await backfill._sync_candidate(
        conn,
        _candidate(),
        apply_changes=True,
        recompute=recompute,
    )

    recompute.assert_awaited_once_with(conn, 42, reset_spend=False)
    assert result.user_id == 42
    assert result.applied is True
    assert result.updated is True


@pytest.mark.asyncio
async def test_sync_candidate_reports_no_key_without_recompute():
    recompute = AsyncMock(return_value=False)

    result = await backfill._sync_candidate(
        object(),
        _candidate(),
        apply_changes=True,
        recompute=recompute,
    )

    assert result.applied is True
    assert result.updated is False


def test_candidate_label_is_human_readable():
    result = backfill.SyncResult(
        user_id=42,
        email="user@example.com",
        supabase_user_id="u-abc",
        plan_code="pro",
        period_end=datetime(2026, 7, 17, 12, 0, tzinfo=UTC),
        applied=True,
        updated=True,
    )

    assert result.label == "user=42 email=user@example.com uuid=u-abc plan=pro"
