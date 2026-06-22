from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest
from pinai_api.domains.billing.repository import (
    ProviderUsageEventInput,
    ProviderUsageRepository,
)


@pytest.mark.asyncio
async def test_provider_usage_repository_records_user_scoped_event():
    conn = FakeConnection()
    started_at = datetime(2026, 6, 10, 1, 2, 3, tzinfo=UTC)
    ended_at = datetime(2026, 6, 10, 1, 2, 4, tzinfo=UTC)

    await ProviderUsageRepository(123, conn).record_event(
        ProviderUsageEventInput(
            supabase_user_id="00000000-0000-4000-8000-000000000123",
            provider="bytedance",
            product="bytedance_streaming_asr",
            source="main_chat_voice",
            quantity_seconds=Decimal("1.000"),
            cost_usd=Decimal("0.000042"),
            metadata={"audio_bytes": 32000},
            started_at=started_at,
            ended_at=ended_at,
        )
    )

    assert len(conn.executed) == 1
    sql, params = conn.executed[0]
    assert "INSERT INTO pai_provider_usage_events" in sql
    assert params["user_id"] == 123
    assert params["supabase_user_id"] == "00000000-0000-4000-8000-000000000123"
    assert params["provider"] == "bytedance"
    assert params["product"] == "bytedance_streaming_asr"
    assert params["source"] == "main_chat_voice"
    assert params["quantity_seconds"] == Decimal("1.000")
    assert params["cost_usd"] == Decimal("0.000042")
    assert params["metadata"].obj == {"audio_bytes": 32000}
    assert params["started_at"] == started_at
    assert params["ended_at"] == ended_at


class FakeConnection:
    def __init__(self) -> None:
        self.executed: list[tuple[str, dict[str, Any]]] = []

    async def execute(self, sql: str, params: dict[str, Any]) -> None:
        self.executed.append((sql, params))


class _FakeCursor:
    def __init__(self, row: dict[str, Any]) -> None:
        self._row = row

    async def fetchone(self) -> dict[str, Any]:
        return self._row


class FakeReadConnection:
    def __init__(self, total: Any) -> None:
        self._total = total
        self.executed: list[tuple[str, Any]] = []

    async def execute(self, sql: str, params: Any = None) -> _FakeCursor:
        self.executed.append((sql, params))
        return _FakeCursor({"total": self._total})


@pytest.mark.asyncio
async def test_sum_cost_usd_since_filters_period_and_succeeded():
    conn = FakeReadConnection(Decimal("0.420000"))
    since = datetime(2026, 6, 1, tzinfo=UTC)

    total = await ProviderUsageRepository(7, conn).sum_cost_usd(since=since)

    assert total == Decimal("0.420000")
    sql, params = conn.executed[0]
    assert "SUM(cost_usd)" in sql
    assert "status = 'succeeded'" in sql
    assert "created_at >= " in sql
    assert params == (7, since)


@pytest.mark.asyncio
async def test_sum_cost_usd_all_time_when_since_none():
    conn = FakeReadConnection(Decimal("1.5"))

    total = await ProviderUsageRepository(7, conn).sum_cost_usd()

    assert total == Decimal("1.5")
    sql, params = conn.executed[0]
    assert "created_at" not in sql
    assert params == (7,)
