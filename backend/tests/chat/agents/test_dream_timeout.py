"""A hung one-shot run must time out → force-delete the sandbox + still meter,
instead of wedging until Daytona's 60min auto_stop. Uses dream as the
representative one-shot path (crystallize / evolve share the structure)."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from agent_engine.agents import dream

pytestmark = pytest.mark.asyncio


async def test_hung_dream_times_out_force_deletes_and_meters(monkeypatch):
    class _HangAgent:
        async def ainvoke(self, _payload):
            await asyncio.sleep(30)  # never returns within the (tiny) timeout

    delete = AsyncMock()
    reported: dict = {}

    monkeypatch.setattr(dream, "create_oneshot_sandbox", AsyncMock(return_value=("backend", "raw")))
    monkeypatch.setattr(dream, "build_agent", lambda **_kw: _HangAgent())
    monkeypatch.setattr(dream, "make_chat_model", lambda **_kw: None)
    monkeypatch.setattr(dream, "delete_sandbox_now", delete)
    monkeypatch.setattr(dream, "report_compute_usage", lambda **kw: reported.update(kw))
    monkeypatch.setattr(dream, "ONESHOT_AGENT_RUN_TIMEOUT_SEC", 0.05)

    out = await dream.run_dream(virtual_key="vk", user_id=1, run_id="r", run_jwt="jwt-x")

    # Sandbox force-deleted despite the hang.
    delete.assert_awaited_once()
    # Usage still metered (attributed to the run's user).
    assert reported.get("provider") == "daytona"
    assert reported.get("run_jwt") == "jwt-x"
    assert reported.get("source") == "daytona:dream"
    # Graceful degraded return, not a hang / unhandled raise.
    assert out == {"summary": ""}
