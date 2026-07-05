"""A hung one-shot run must time out → force-delete the sandbox + still meter,
instead of wedging until Daytona's 60min auto_stop. evolve is the single
one-shot consolidation path (the merged evolve/dream/crystallize)."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from agent_engine.agents import evolve

pytestmark = pytest.mark.asyncio


async def test_hung_evolve_times_out_force_deletes_and_meters(monkeypatch):
    class _HangAgent:
        async def ainvoke(self, _payload):
            await asyncio.sleep(30)  # never returns within the (tiny) timeout

    delete = AsyncMock()
    reported: dict = {}

    monkeypatch.setattr(
        evolve, "create_oneshot_sandbox", AsyncMock(return_value=("backend", "raw"))
    )
    monkeypatch.setattr(evolve, "build_agent", lambda **_kw: _HangAgent())
    monkeypatch.setattr(evolve, "make_chat_model", lambda **_kw: None)
    monkeypatch.setattr(evolve, "delete_sandbox_now", delete)
    monkeypatch.setattr(evolve, "report_compute_usage", lambda **kw: reported.update(kw))
    monkeypatch.setattr(evolve, "ONESHOT_AGENT_RUN_TIMEOUT_SEC", 0.05)

    out = await evolve.run_evolve(
        trigger_kind=evolve.TRIGGER_DAILY,
        virtual_key="vk",
        user_id=1,
        run_id="r",
        run_jwt="jwt-x",
    )

    # Sandbox force-deleted despite the hang.
    delete.assert_awaited_once()
    # Usage still metered (attributed to the run's user).
    assert reported.get("provider") == "daytona"
    assert reported.get("run_jwt") == "jwt-x"
    assert reported.get("source") == "daytona:evolve:daily:daily"
    # Graceful degraded return, not a hang / unhandled raise.
    assert out == {"summary": "", "trigger": "daily", "scope": "daily"}


async def test_hung_rollup_semantic_times_out_force_deletes_and_meters(monkeypatch):
    """rollup_semantic (split out of evolve, rollup R4) shares the same one-shot
    sandbox + timeout shape — a hang must force-delete + still meter, same as
    evolve."""
    from agent_engine.agents import rollup_semantic

    class _HangAgent:
        async def ainvoke(self, _payload):
            await asyncio.sleep(30)

    delete = AsyncMock()
    reported: dict = {}

    monkeypatch.setattr(
        rollup_semantic, "create_oneshot_sandbox", AsyncMock(return_value=("backend", "raw"))
    )
    monkeypatch.setattr(rollup_semantic, "build_agent", lambda **_kw: _HangAgent())
    monkeypatch.setattr(rollup_semantic, "make_chat_model", lambda **_kw: None)
    monkeypatch.setattr(rollup_semantic, "delete_sandbox_now", delete)
    monkeypatch.setattr(rollup_semantic, "report_compute_usage", lambda **kw: reported.update(kw))
    monkeypatch.setattr(rollup_semantic, "ONESHOT_AGENT_RUN_TIMEOUT_SEC", 0.05)

    out = await rollup_semantic.run_rollup_semantic(
        virtual_key="vk",
        user_id=1,
        run_id="r",
        run_jwt="jwt-x",
    )

    delete.assert_awaited_once()
    assert reported.get("provider") == "daytona"
    assert reported.get("run_jwt") == "jwt-x"
    assert reported.get("source") == "daytona:rollup_semantic"
    assert out == {"summary": "", "scope": "rollup_semantic"}
