from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest

from pinai_agents.web.db.repositories.provider_usage import (
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
